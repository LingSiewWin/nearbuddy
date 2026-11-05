"""Exercises the paid seam offline: a local OpenAI-compatible server stands in for NEAR AI Cloud."""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from intent_client import proof_hash  # noqa: E402
from nearai import NearAiClient, client_from_env  # noqa: E402


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_POST(self):
        n = int(self.headers["content-length"])
        req = json.loads(self.rfile.read(n))
        assert self.headers["authorization"].startswith("Bearer ")
        body = {"id": "chatcmpl-test1", "object": "chat.completion", "created": 1, "model": req["model"],
                "choices": [{"index": 0, "message": {"role": "assistant", "content": '{"direction":"short","reasoning":"fake"}'}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        self._json(body)

    def do_GET(self):
        assert self.path == "/v1/signature/chatcmpl-test1"
        self._json({"text": "sha256:abc", "signature": "0xsig", "signing_address": "0xaddr", "signing_algo": "ecdsa"})

    def _json(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def test_near_ai_client_round_trip():
    srv = HTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}/v1"
    c = client_from_env({"NEAR_AI_API_KEY": "k", "NEAR_AI_MODEL_A": "test/model-a", "NEAR_AI_BASE": base}, "A")
    assert isinstance(c, NearAiClient) and c.model_id == "test/model-a"
    text, chat_id = c.complete("sys", "user")
    assert '"short"' in text and chat_id == "chatcmpl-test1"
    rec = c.signature(chat_id)
    assert rec["signing_address"] == "0xaddr"
    assert proof_hash(rec) != proof_hash(None)
    srv.shutdown()


def test_env_picks_per_side_model_and_stub_without_key():
    assert client_from_env({}, "A").model_id == "stub/deterministic"
    b = client_from_env({"NEAR_AI_API_KEY": "k", "NEAR_AI_MODEL": "x/default"}, "B")
    assert b.model_id == "x/default"
