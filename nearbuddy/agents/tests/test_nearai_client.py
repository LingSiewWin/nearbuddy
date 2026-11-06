"""Exercises the paid seam offline: a local OpenAI-compatible server stands in for NEAR AI Cloud and signs
`model:sha256(request bytes):sha256(response bytes)` with an ed25519 key, exactly like the enclave."""

import hashlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nacl.signing import SigningKey  # noqa: E402

from intent_client import proof_hash, tee_proof  # noqa: E402
from nearai import NearAiClient, StubClient, client_from_env, is_stub_model  # noqa: E402

ENCLAVE = SigningKey(bytes([9] * 32))
SENT: dict[str, tuple[bytes, bytes, str]] = {}  # chat id -> (request bytes, response bytes, model)


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_POST(self):
        n = int(self.headers["content-length"])
        raw = self.rfile.read(n)
        req = json.loads(raw)
        assert self.headers["authorization"].startswith("Bearer ")
        assert req["stream"] is False
        body = {
            "id": "chatcmpl-test1",
            "object": "chat.completion",
            "created": 1,
            "model": req["model"],
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": '{"direction":"short","reasoning":"fake"}'},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        data = json.dumps(body).encode()
        SENT["chatcmpl-test1"] = (raw, data, req["model"])
        self._send(data)

    def do_GET(self):
        u = urlparse(self.path)
        assert u.path == "/v1/signature/chatcmpl-test1", u.path
        assert "signing_algo=ed25519" in u.query
        raw, data, model = SENT["chatcmpl-test1"]
        text = f"{model}:{hashlib.sha256(raw).hexdigest()}:{hashlib.sha256(data).hexdigest()}"
        sig = ENCLAVE.sign(text.encode()).signature
        self._send(
            json.dumps(
                {
                    "text": text,
                    "signature": sig.hex(),
                    "signing_address": bytes(ENCLAVE.verify_key).hex(),
                    "signing_algo": "ed25519",
                    "signature_kind": "provider_tee",
                }
            ).encode()
        )

    def _send(self, data):
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def test_near_ai_client_round_trip_and_tee_proof():
    srv = HTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}/v1"
    c = client_from_env({"NEAR_AI_API_KEY": "k", "NEAR_AI_MODEL_A": "test/model-a", "NEAR_AI_BASE": base}, "A")
    assert isinstance(c, NearAiClient) and c.model_id == "test/model-a" and c.tee
    done = c.complete("sys", "user")
    assert '"short"' in done.text and done.chat_id == "chatcmpl-test1"
    assert done.request_bytes and done.response_bytes
    rec = c.signature(done.chat_id)
    assert rec is not None
    p = tee_proof(rec, c.model_id, done.request_hash, done.response_hash)
    assert p["kind"] == 2
    assert proof_hash(done.request_hash, done.response_hash) != proof_hash(None)
    srv.shutdown()


SNAPSHOT = Path(__file__).resolve().parents[2] / "dataset" / "decisions.jsonl"


def test_pair_1_requests_stay_byte_identical_to_the_signed_dataset_rows():
    """Re-send the system/user text of real enclave-signed pair-1 rows; the client must emit the exact bytes the
    enclave signed then (max_tokens 600), while the pair-2 reasoning models get their measured budgets."""
    rows = [json.loads(line) for line in SNAPSHOT.read_text().splitlines() if line.strip()]
    srv = HTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}/v1"
    for model in ("deepseek-ai/DeepSeek-V4.1-Flash-1017", "Qwen/Qwen3.8-27B"):
        stored = [r["request_body"] for r in rows if r.get("model") == model and r.get("request_body")][-3:]
        assert stored, model
        c = client_from_env({"NEAR_AI_API_KEY": "k", "NEAR_AI_MODEL_A": model, "NEAR_AI_BASE": base}, "A")
        for body in stored:
            system, user = (m["content"] for m in json.loads(body)["messages"])
            c.complete(system, user)
            assert SENT["chatcmpl-test1"][0] == body.encode(), model
    for model, budget in (("Qwen/Qwen3.6-35B-A3B-FP8", 1800), ("z-ai/glm-5.3-flash", 1600)):
        client_from_env({"NEAR_AI_API_KEY": "k", "NEAR_AI_MODEL_A": model, "NEAR_AI_BASE": base}, "A").complete(
            "s", "u"
        )
        assert json.loads(SENT["chatcmpl-test1"][0])["max_tokens"] == budget
    assert NearAiClient("k", "Qwen/Qwen3.6-35B-A3B-FP8", base, max_tokens=50)._max_tokens == 50  # explicit wins
    srv.shutdown()


def test_is_stub_model_matches_a_whole_segment():
    # same cases as web/app/__tests__/cells.test.ts isStubModel
    assert is_stub_model(StubClient.model_id)
    for m in ("stub", "stub/x", "redteam/stub", "org/stub/v2"):
        assert is_stub_model(m), m
    for m in ("stubborn-model", "acme/stubborn-model", "acme/model-stub", "Qwen/Qwen3.8-27B", "", None):
        assert not is_stub_model(m), m


def test_env_picks_per_side_model_and_stub_without_key():
    assert client_from_env({}, "A").model_id == "stub/deterministic"
    b = client_from_env({"NEAR_AI_API_KEY": "k", "NEAR_AI_MODEL": "x/default"}, "B")
    assert b.model_id == "x/default"


def test_stub_sides_follow_the_agent_label_so_a_stub_duel_is_decided():
    a, b = client_from_env({}, "A"), client_from_env({}, "B")
    for user in ("NEAR/USD last 3.66. Duel just opened.", "NEAR/USD last 3.67. Move since duel open: +27.3 bps."):
        da, db = (json.loads(c.complete("sys", user).text)["direction"] for c in (a, b))
        assert {da, db} == {"long", "short"}
        assert json.loads(a.complete("other system", user).text)["direction"] == da, "deterministic per prompt"
    assert StubClient().complete("s", "u").text == StubClient("").complete("s", "u").text
