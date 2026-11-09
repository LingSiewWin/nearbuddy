"""Model seam. The arena loop runs with `StubClient` (free, deterministic, no TEE proof).
`NearAiClient` is the paid path: OpenAI-compatible NEAR AI Cloud at https://cloud-api.near.ai/v1.
The request is sent as exact bytes and the response kept as exact bytes, because the enclave signs
`"{model}:{sha256(request bytes)}:{sha256(response bytes)}"` and the arena contract re-verifies that
signature (`GET /v1/signature/{chat_id}?signing_algo=ed25519`) before accepting the intent.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import requests

NEAR_AI_BASE = "https://cloud-api.near.ai/v1"


@dataclass
class Completion:
    text: str
    chat_id: str | None
    model: str
    request_bytes: bytes = b""
    response_bytes: bytes = b""

    @property
    def request_hash(self) -> bytes:
        return hashlib.sha256(self.request_bytes).digest()

    @property
    def response_hash(self) -> bytes:
        return hashlib.sha256(self.response_bytes).digest()


def message_text(response: dict[str, Any]) -> str:
    """The text the duelist parses from a chat completion response. Reasoning models may spend the budget thinking
    and leave `content` empty; the JSON decision is then usually at the end of the reasoning text."""
    msg = response["choices"][0]["message"]
    return msg.get("content") or msg.get("reasoning_content") or msg.get("reasoning") or ""


STUB_MODEL = re.compile(r"(^|/)stub(/|$)")


def is_stub_model(model_id: str | None) -> bool:
    """A stub agent, not a model: `stub` as a whole path segment (`stub/deterministic`, `redteam/stub`), so a real
    model named e.g. `stubborn-model` is not one. Same rule as `isStubModel` in web/app/cells.ts."""
    return model_id is not None and STUB_MODEL.search(model_id) is not None


class StubClient:
    """Deterministic: direction follows the parity of the last byte of sha256(user prompt) plus the byte sum of
    `label`. Both duelists see the same prompt, so without the label every stub duel ties; with labels "A" and "B"
    (sums 65 and 66) the two always take opposite sides and every stub duel has a winner and a slash."""

    model_id = "stub/deterministic"
    tee = False

    def __init__(self, label: str = "") -> None:
        self.label = label

    def complete(self, system: str, user: str) -> Completion:
        d = hashlib.sha256(user.encode()).digest()[-1]
        direction = "long" if (d + sum(self.label.encode())) % 2 == 0 else "short"
        return Completion(json.dumps({"direction": direction, "reasoning": f"stub call #{d}"}), None, self.model_id)

    def signature(self, chat_id: str) -> dict[str, Any] | None:
        return None

    def attestation(self) -> dict[str, Any] | None:
        return None


DEFAULT_MAX_TOKENS = 600  # pair 1 (DeepSeek-V4.1-Flash, Qwen3.8-27B): keep it, their request bytes must not change
# Reasoning models that spend 600 tokens thinking before the JSON. Measured on the arena prompt 2026-11-06: Qwen3.6
# ran to the cap on 9/14 live calls and used up to 899 tokens uncapped; GLM-5.3-flash used up to 810 under attack.
# About twice the largest observed completion; tokens are billed as used, so the cap costs only on the long tail.
MAX_TOKENS = {"Qwen/Qwen3.6-35B-A3B-FP8": 1800, "z-ai/glm-5.3-flash": 1600}


def request_body(model_id: str, system: str, user: str, max_tokens: int | None = None) -> bytes:
    """The exact chat-completion request bytes the enclave signs. One builder for the client, the dataset verifier
    and the tests, so a body with any other field (temperature, logit_bias, another max_tokens) never verifies."""
    payload = {
        "model": model_id,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": max_tokens or MAX_TOKENS.get(model_id, DEFAULT_MAX_TOKENS),
        # streaming responses are re-chunked by the gateway; the model enclave signs only the exact bytes
        "stream": False,
    }
    return json.dumps(payload, separators=(",", ":")).encode()


class NearAiClient:
    tee = True

    def __init__(
        self, api_key: str, model_id: str, base_url: str = NEAR_AI_BASE, max_tokens: int | None = None
    ) -> None:
        self.model_id = model_id
        self._base = base_url.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "accept": "application/json",
        }
        self._max_tokens = max_tokens or MAX_TOKENS.get(model_id, DEFAULT_MAX_TOKENS)

    def complete(self, system: str, user: str) -> Completion:
        body = request_body(self.model_id, system, user, self._max_tokens)
        r = requests.post(f"{self._base}/chat/completions", headers=self._headers, data=body, timeout=180)
        r.raise_for_status()
        # Strict UTF-8: the dataset stores this text and verifiers re-hash it, so a lossy decode would turn a
        # genuine enclave-signed row into a hash mismatch. Bytes that are not UTF-8 fail the call instead.
        j = json.loads(r.content.decode("utf-8"))
        return Completion(message_text(j), j.get("id"), j.get("model", self.model_id), body, r.content)

    def signature(self, chat_id: str, attempts: int = 6) -> dict[str, Any] | None:
        """The enclave signature record. A model runs on several TEE nodes and the record lives on the one
        that served the completion, so a miss is retried."""
        import time

        for i in range(attempts):
            r = requests.get(
                f"{self._base}/signature/{chat_id}",
                params={"model": self.model_id, "signing_algo": "ed25519"},
                headers=self._headers,
                timeout=30,
            )
            if r.status_code == 200:
                return r.json()
            time.sleep(1.5 * (i + 1))
        return None

    def attestation(self) -> dict[str, Any] | None:
        """Intel TDX quote + NVIDIA payload for the model's enclave, bound to a fresh nonce. Non-billable.
        External (non-TEE) providers answer 503; the gateway's own attestation is at the same path without `model`."""
        nonce = secrets.token_hex(32)
        r = requests.get(
            f"{self._base}/attestation/report",
            params={"model": self.model_id, "signing_algo": "ed25519", "nonce": nonce},
            headers=self._headers,
            timeout=90,
        )
        if r.status_code != 200:
            return {"model": self.model_id, "nonce": nonce, "status": r.status_code, "error": r.text[:300]}
        return {"model": self.model_id, "nonce": nonce, "status": 200, "report": r.json()}


ModelClient = StubClient | NearAiClient


def client_from_env(env: Mapping[str, str], which: str = "") -> ModelClient:
    """`which` = "A" or "B" picks NEAR_AI_MODEL_A / NEAR_AI_MODEL_B when set, so a headline duel can pit two
    TEE-hosted models (e.g. deepseek-ai/DeepSeek-V4.1-Flash-1017 vs Qwen/Qwen3.8-27B). No key = stub."""
    key = env.get("NEAR_AI_API_KEY", "").strip()
    if not key:
        return StubClient(which)
    model = env.get(f"NEAR_AI_MODEL_{which}", "").strip() or env.get(
        "NEAR_AI_MODEL", "deepseek-ai/DeepSeek-V4.1-Flash-1017"
    )
    return NearAiClient(key, model, base_url=env.get("NEAR_AI_BASE", NEAR_AI_BASE))
