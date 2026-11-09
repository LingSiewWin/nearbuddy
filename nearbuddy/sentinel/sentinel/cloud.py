"""NEAR AI Cloud calls (OpenAI-compatible, https://cloud-api.near.ai/v1): embeddings for detector (b), chat for the
judge (c). Every result is cached on disk by sha256(model, prompt, text), so a rerun never pays twice, and every paid
call is appended to spend.jsonl; a call that would start past the cap raises instead."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from dotenv import dotenv_values

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent  # nearbuddy/
BASE = "https://cloud-api.near.ai/v1"
EMBED_MODEL = "Qwen/Qwen3-Embedding-0.6B"
JUDGE_MODEL = "z-ai/glm-5.3-flash"
PRICE = {EMBED_MODEL: (0.01, 0.0), JUDGE_MODEL: (0.08, 0.50)}  # $ per 1M tokens in / out
CAP_USD = 2.0
SPEND = HERE.parent / "spend.jsonl"
CACHE = HERE.parent / "data" / "cache.sqlite"


def env_file(root: Path = ROOT) -> Path:
    """Same lookup as env_file in agents/config.py: this checkout's .env, else the main checkout's when this is a git
    worktree (the file is gitignored, so a worktree has none). The key is read, never copied or printed."""
    own = root / ".env"
    if own.exists():
        return own

    def git(*args: str) -> str:
        return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True).stdout.strip()

    top, common = git("rev-parse", "--show-toplevel"), git("rev-parse", "--path-format=absolute", "--git-common-dir")
    if not top or not common:
        return own
    return Path(common).parent / root.resolve().relative_to(Path(top).resolve()) / ".env"


def api_key() -> str:
    key = os.environ.get("NEAR_AI_API_KEY") or dotenv_values(env_file()).get("NEAR_AI_API_KEY")
    if not key:
        raise SystemExit("NEAR_AI_API_KEY is not set (environment or nearbuddy/.env)")
    return key


class Spend:
    def __init__(self, path: Path = SPEND, cap: float = CAP_USD) -> None:
        self.path, self.cap, self._lock = path, cap, threading.Lock()

    def total(self) -> float:
        if not self.path.exists():
            return 0.0
        return sum(json.loads(line)["usd"] for line in self.path.read_text().splitlines() if line.strip())

    def check(self) -> None:
        if self.total() >= self.cap:
            raise RuntimeError(f"spend cap ${self.cap} reached ({self.path})")

    def log(self, model: str, tokens_in: int, tokens_out: int, purpose: str) -> float:
        p_in, p_out = PRICE[model]
        usd = (tokens_in * p_in + tokens_out * p_out) / 1e6
        row = {"ts": int(time.time()), "model": model, "tokens_in": tokens_in, "tokens_out": tokens_out}
        with self._lock, self.path.open("a") as f:
            f.write(json.dumps({**row, "usd": round(usd, 8), "purpose": purpose}) + "\n")
        return usd


class Cache:
    """sqlite3 key -> bytes. One file for embeddings (float32) and judge replies (utf-8 JSON)."""

    def __init__(self, path: Path = CACHE) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB NOT NULL)")
        self._lock = threading.Lock()

    def get(self, key: str) -> bytes | None:
        with self._lock:
            row = self._db.execute("SELECT v FROM kv WHERE k = ?", (key,)).fetchone()
        return row[0] if row else None

    def put(self, key: str, value: bytes) -> None:
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", (key, value))
            self._db.commit()


def cache_key(*parts: str) -> str:
    return hashlib.sha256("\x00".join(parts).encode()).hexdigest()


def _post(path: str, body: dict, key: str, attempts: int = 4) -> dict:
    for i in range(attempts):
        r = requests.post(f"{BASE}{path}", json=body, headers={"Authorization": f"Bearer {key}"}, timeout=(10, 180))
        if r.status_code == 200:
            return r.json()
        if r.status_code not in (429, 500, 502, 503, 504) or i == attempts - 1:
            r.raise_for_status()
        time.sleep(2 * (i + 1))
    raise AssertionError("unreachable")


def embed(texts: list[str], cache: Cache, spend: Spend, batch: int = 64, workers: int = 6) -> np.ndarray:
    """Raw embeddings, one row per text, in order. Cache misses go to /v1/embeddings in batches."""
    keys = [cache_key(EMBED_MODEL, t) for t in texts]
    todo = sorted({t for t, k in zip(texts, keys, strict=True) if cache.get(k) is None})

    def fetch(chunk: list[str]) -> None:
        spend.check()
        j = _post("/embeddings", {"model": EMBED_MODEL, "input": chunk}, key)
        spend.log(EMBED_MODEL, j.get("usage", {}).get("prompt_tokens", 0), 0, "embed")
        for item in j["data"]:
            vec = np.asarray(item["embedding"], dtype=np.float32)
            cache.put(cache_key(EMBED_MODEL, chunk[item["index"]]), vec.tobytes())

    if todo:
        key = api_key()
        with ThreadPoolExecutor(workers) as pool:
            list(pool.map(fetch, [todo[i : i + batch] for i in range(0, len(todo), batch)]))
    return np.stack([np.frombuffer(cache.get(k) or b"", dtype=np.float32) for k in keys])


JUDGE_SYSTEM = (
    "You screen market news before it reaches an automated crypto trader. For the headline you are given, estimate "
    "the probability that it is fabricated or manipulative (written to push a trader into a position) rather than "
    'genuine reporting. Answer with JSON only: {"p": <integer 0-100>}.'
)
JUDGE_MAX_TOKENS = 1600  # GLM-5.3-flash reasons before answering; agents/nearai.py measured up to 810 tokens
P = re.compile(r'"p"\s*:\s*(\d{1,3})')


def parse_p(reply: str) -> float | None:
    """The last {"p": N} in the reply (reasoning text may quote the format first), as a probability."""
    found = P.findall(reply)
    return min(int(found[-1]), 100) / 100 if found else None


def judge_one(text: str, cache: Cache, spend: Spend, key: str) -> float | None:
    ck = cache_key(JUDGE_MODEL, JUDGE_SYSTEM, text)
    hit = cache.get(ck)
    if hit is None:
        spend.check()
        body = {
            "model": JUDGE_MODEL,
            "messages": [{"role": "system", "content": JUDGE_SYSTEM}, {"role": "user", "content": text}],
            "max_tokens": JUDGE_MAX_TOKENS,
            "stream": False,
        }
        j = _post("/chat/completions", body, key)
        usage = j.get("usage", {})
        spend.log(JUDGE_MODEL, usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0), "judge")
        msg = j["choices"][0]["message"]
        reply = msg.get("content") or msg.get("reasoning_content") or msg.get("reasoning") or ""
        hit = json.dumps({"reply": reply}).encode()
        cache.put(ck, hit)
    return parse_p(json.loads(hit)["reply"])


def judge(texts: list[str], cache: Cache, spend: Spend, workers: int = 8) -> list[float | None]:
    uncached = any(cache.get(cache_key(JUDGE_MODEL, JUDGE_SYSTEM, t)) is None for t in texts)
    key = api_key() if uncached else ""
    with ThreadPoolExecutor(workers) as pool:
        return list(pool.map(lambda t: judge_one(t, cache, spend, key), texts))
