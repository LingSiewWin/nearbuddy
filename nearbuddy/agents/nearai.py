"""Model seam. The arena loop runs with `StubClient` (free, deterministic, proof_hash = zeros).
`NearAiClient` is the paid path: OpenAI-compatible NEAR AI Cloud at https://cloud-api.near.ai/v1,
every response signed by a key that never leaves the TEE; the signature record is fetched from
GET /v1/signature/{chat_id} and hashed into the on-chain intent.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Optional

import requests

NEAR_AI_BASE = "https://cloud-api.near.ai/v1"


class StubClient:
    """Deterministic: direction follows the last digit of sha256(user prompt)."""

    model_id = "stub/deterministic"

    def complete(self, system: str, user: str) -> tuple[str, Optional[str]]:
        d = hashlib.sha256(user.encode()).digest()[-1]
        direction = "long" if d % 2 == 0 else "short"
        return json.dumps({"direction": direction, "reasoning": f"stub call #{d}"}), None

    def signature(self, chat_id: str) -> Optional[dict[str, Any]]:
        return None


class NearAiClient:
    def __init__(self, api_key: str, model_id: str, base_url: str = NEAR_AI_BASE, max_tokens: int = 256) -> None:
        from openai import OpenAI  # imported lazily so the stub path needs no SDK

        self.model_id = model_id
        self._client = OpenAI(base_url=base_url, api_key=api_key)
        self._base = base_url
        self._key = api_key
        self._max_tokens = max_tokens

    def complete(self, system: str, user: str) -> tuple[str, Optional[str]]:
        r = self._client.chat.completions.create(
            model=self.model_id,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            max_tokens=self._max_tokens,
        )
        return r.choices[0].message.content or "", r.id

    def signature(self, chat_id: str) -> Optional[dict[str, Any]]:
        r = requests.get(f"{self._base}/signature/{chat_id}", headers={"Authorization": f"Bearer {self._key}"}, timeout=30)
        if r.status_code != 200:
            return None
        return r.json()


def client_from_env(env: dict[str, str]):
    key = env.get("NEAR_AI_API_KEY", "").strip()
    if not key:
        return StubClient()
    return NearAiClient(key, env.get("NEAR_AI_MODEL", "deepseek/deepseek-v4.1-flash"))
