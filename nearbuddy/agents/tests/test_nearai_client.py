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
from nearai import NearAiClient, client_from_env  # noqa: E402

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


def test_env_picks_per_side_model_and_stub_without_key():
    assert client_from_env({}, "A").model_id == "stub/deterministic"
    b = client_from_env({"NEAR_AI_API_KEY": "k", "NEAR_AI_MODEL": "x/default"}, "B")
    assert b.model_id == "x/default"
