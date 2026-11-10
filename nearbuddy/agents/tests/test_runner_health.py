"""`runner.py --health` against a fake NEAR AI Cloud on localhost: GET /v1/models must answer 200 and list every model
the run calls; `--chat` adds a 1-output-token chat call per model. Unhealthy is one line and exit 1, and the API key
never shows, even when the server echoes the Authorization header back."""

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runner  # noqa: E402

KEY = "sk-test-SECRET-1234"
A, B = "deepseek-ai/DeepSeek-V4.1-Flash-1017", "Qwen/Qwen3.8-27B"
RUNNER = Path(__file__).resolve().parents[1] / "runner.py"


class FakeCloud:
    """`models_status` / `listed` shape GET /models; `chat_status` maps a model id to its chat answer's status (200
    when absent). Error bodies echo the Authorization header, as a careless gateway might. Records every request."""

    def __init__(self, models_status=200, listed=(A, B), chat_status=None):
        self.models_status, self.listed, self.chat_status = models_status, list(listed), chat_status or {}
        self.requests: list[tuple[str, str, dict | None]] = []
        cloud = self

        class H(BaseHTTPRequestHandler):
            def reply(self, status: int, body: dict) -> None:
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                cloud.requests.append(("GET", self.path, None))
                if cloud.models_status != 200:
                    self.reply(cloud.models_status, {"error": f"upstream down for {self.headers['Authorization']}"})
                else:
                    self.reply(200, {"object": "list", "data": [{"id": m, "owned_by": "nearai"} for m in cloud.listed]})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                cloud.requests.append(("POST", self.path, body))
                status = cloud.chat_status.get(body["model"], 200)
                if status != 200:
                    self.reply(status, {"error": "Bad Gateway"})
                else:
                    self.reply(200, {"id": "chatcmpl-1", "usage": {"prompt_tokens": 17, "completion_tokens": 1}})

            def log_message(self, *a):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.server.server_port}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def env(self) -> dict[str, str]:
        return {"NEAR_AI_API_KEY": KEY, "NEAR_AI_BASE": self.base}


@pytest.fixture
def cloud():
    made: list[FakeCloud] = []

    def make(**kw) -> FakeCloud:
        made.append(FakeCloud(**kw))
        return made[-1]

    yield make
    for c in made:
        c.server.shutdown()


def test_healthy_when_the_list_answers_and_names_every_model(cloud):
    c = cloud()
    why, done = runner.model_health(c.env(), [A, B])
    assert why is None and done == f"GET /v1/models 200, lists {A}, {B}"
    assert [(m, p) for m, p, _ in c.requests] == [("GET", "/v1/models")]  # free: no chat call without --chat


def test_gateway_500_is_one_line_without_the_key(cloud):
    c = cloud(models_status=500)
    why, _ = runner.model_health(c.env(), [A, B])
    assert why is not None and why.startswith("GET /v1/models: HTTP 500")
    assert KEY not in why and "\n" not in why and "***" in why


def test_a_model_missing_from_the_list_is_unhealthy(cloud):
    why, _ = runner.model_health(cloud(listed=[A]).env(), [A, B])
    assert why == f"GET /v1/models: not listed: {B}"


def test_no_answer_is_unhealthy():
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # nothing listens there now
    why, _ = runner.model_health({"NEAR_AI_API_KEY": KEY, "NEAR_AI_BASE": f"http://127.0.0.1:{port}/v1"}, [A])
    assert why == "GET /v1/models: no answer (ConnectionError)"


def test_no_key_means_stub_models_and_nothing_to_check():
    assert runner.model_health({"NEAR_AI_API_KEY": " "}, [A]) == (
        None,
        "no NEAR_AI_API_KEY: stub models, nothing to check",
    )


def test_chat_probe_catches_a_listed_model_that_502s(cloud):
    c = cloud(chat_status={B: 502})
    why, _ = runner.model_health(c.env(), [A, B], chat=True)
    assert why == 'POST /v1/chat/completions Qwen/Qwen3.8-27B: HTTP 502 {"error": "Bad Gateway"}'
    chats = [b for m, _, b in c.requests if m == "POST"]
    assert [b["model"] for b in chats] == [A, B] and all(b["max_tokens"] == 1 for b in chats)


def test_chat_probe_reports_the_tokens_it_paid_for(cloud):
    why, done = runner.model_health(cloud().env(), [A], chat=True)
    assert why is None and done.endswith(f"; chat {A} 200 (17 in / 1 out)")


def _cli(cloud_env: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, **cloud_env, "NEAR_AI_MODEL_A": A, "NEAR_AI_MODEL_B": B}
    return subprocess.run(
        [sys.executable, str(RUNNER), "--health", *args], env=env, capture_output=True, text=True, timeout=60
    )


def test_cli_exits_1_with_one_line_when_the_gateway_500s(cloud):
    out = _cli(cloud(models_status=500).env())
    assert out.returncode == 1 and out.stdout == ""
    assert out.stderr.startswith("unhealthy: GET /v1/models: HTTP 500") and out.stderr.count("\n") == 1
    assert KEY not in out.stderr


def test_cli_exits_0_when_healthy_and_names_the_judge_under_hardened_v3(cloud):
    c = cloud(listed=[A, B, runner.JUDGE_MODEL])
    out = _cli(c.env(), "--profile", "hardened-v3")
    assert out.returncode == 0, out.stderr
    assert out.stdout == f"healthy: GET /v1/models 200, lists {A}, {B}, {runner.JUDGE_MODEL}\n"
