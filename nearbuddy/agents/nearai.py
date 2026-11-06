"""Model seam. The arena loop runs with `StubClient` (free, deterministic, no TEE proof).
`NearAiClient` is the paid path: OpenAI-compatible NEAR AI Cloud at https://cloud-api.near.ai/v1.
The request is sent as exact bytes and the response kept as exact bytes, because the enclave signs
`"{model}:{sha256(request bytes)}:{sha256(response bytes)}"` and the arena contract re-verifies that
signature (`GET /v1/signature/{chat_id}?signing_algo=ed25519`) before accepting the intent.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from typing import Any, Optional

import requests

NEAR_AI_BASE = "https://cloud-api.near.ai/v1"


@dataclass
class Completion:
    text: str
    chat_id: Optional[str]
    model: str
    request_bytes: bytes = b""
    response_bytes: bytes = b""

    @property
    def request_hash(self) -> bytes:
        return hashlib.sha256(self.request_bytes).digest()

    @property
    def response_hash(self) -> bytes:
        return hashlib.sha256(self.response_bytes).digest()


class StubClient:
    """Deterministic: direction follows the last digit of sha256(user prompt)."""

    model_id = "stub/deterministic"
    tee = False

    def complete(self, system: str, user: str) -> Completion:
        d = hashlib.sha256(user.encode()).digest()[-1]
        direction = "long" if d % 2 == 0 else "short"
        return Completion(json.dumps({"direction": direction, "reasoning": f"stub call #{d}"}), None, self.model_id)

    def signature(self, chat_id: str) -> Optional[dict[str, Any]]:
        return None

    def attestation(self) -> Optional[dict[str, Any]]:
        return None


class NearAiClient:
    tee = True

    def __init__(self, api_key: str, model_id: str, base_url: str = NEAR_AI_BASE, max_tokens: int = 600) -> None:
        self.model_id = model_id
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "accept": "application/json"}
        self._max_tokens = max_tokens

    def complete(self, system: str, user: str) -> Completion:
        payload = {
            "model": self.model_id,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_tokens": self._max_tokens,
            "stream": False,  # streaming responses are re-chunked by the gateway; the model enclave signs only the exact bytes
        }
        body = json.dumps(payload, separators=(",", ":")).encode()
        r = requests.post(f"{self._base}/chat/completions", headers=self._headers, data=body, timeout=180)
        r.raise_for_status()
        j = r.json()
        msg = j["choices"][0]["message"]
        # reasoning models may spend the budget thinking and leave `content` empty; the JSON decision is
        # then usually at the end of the reasoning text, which parse_decision scans for
        text = msg.get("content") or msg.get("reasoning_content") or msg.get("reasoning") or ""
        return Completion(text, j.get("id"), j.get("model", self.model_id), body, r.content)

    def signature(self, chat_id: str, attempts: int = 6) -> Optional[dict[str, Any]]:
        """The enclave signature record. A model runs on several TEE nodes and the record lives on the one
        that served the completion, so a miss is retried."""
        import time

        for i in range(attempts):
            r = requests.get(f"{self._base}/signature/{chat_id}", params={"model": self.model_id, "signing_algo": "ed25519"}, headers=self._headers, timeout=30)
            if r.status_code == 200:
                return r.json()
            time.sleep(1.5 * (i + 1))
        return None

    def attestation(self) -> Optional[dict[str, Any]]:
        """Intel TDX quote + NVIDIA payload for the model's enclave, bound to a fresh nonce. Non-billable.
        External (non-TEE) providers answer 503; the gateway's own attestation is at the same path without `model`."""
        nonce = secrets.token_hex(32)
        r = requests.get(f"{self._base}/attestation/report", params={"model": self.model_id, "signing_algo": "ed25519", "nonce": nonce}, headers=self._headers, timeout=90)
        if r.status_code != 200:
            return {"model": self.model_id, "nonce": nonce, "status": r.status_code, "error": r.text[:300]}
        return {"model": self.model_id, "nonce": nonce, "status": 200, "report": r.json()}


def client_from_env(env: dict[str, str], which: str = "") -> "StubClient | NearAiClient":
    """`which` = "A" or "B" picks NEAR_AI_MODEL_A / NEAR_AI_MODEL_B when set, so a headline duel can pit two
    TEE-hosted models (e.g. deepseek-ai/DeepSeek-V4.1-Flash-1017 vs Qwen/Qwen3.8-27B). No key = stub."""
    key = env.get("NEAR_AI_API_KEY", "").strip()
    if not key:
        return StubClient()
    model = env.get(f"NEAR_AI_MODEL_{which}", "").strip() or env.get("NEAR_AI_MODEL", "deepseek-ai/DeepSeek-V4.1-Flash-1017")
    return NearAiClient(key, model, base_url=env.get("NEAR_AI_BASE", NEAR_AI_BASE))
