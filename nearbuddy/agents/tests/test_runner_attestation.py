"""Every row cites an attestation report that must list its signer (check_row). The runner saves a report only when
NEAR AI Cloud answered 200, retries a dropped connection, a 429 or a 5xx with backoff, and fetches the report again
when a row's signer is not in the saved one, so one bad answer at the start of a run no longer strands its rows."""

import json
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import nearai  # noqa: E402
import runner  # noqa: E402
from config import ENV  # noqa: E402
from export_dataset import check_row  # noqa: E402
from tests.test_arm_d import Enclave  # noqa: E402

S = 1_000_000_000


class Answers(Enclave):
    """An enclave whose attestation endpoint gives `answers` in turn (a status code, or 200 for its report)."""

    def __init__(self, *answers: int | None) -> None:
        super().__init__()
        self.answers = list(answers)
        self.fetches = 0

    def attestation(self) -> dict:
        self.fetches += 1
        status = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if status == 200:
            return {"model": self.model_id, "nonce": "n", "status": 200, **super().attestation()}
        return {"model": self.model_id, "nonce": "n", "status": status, "error": "upstream"}


def naps(monkeypatch) -> list[float]:
    slept: list[float] = []
    monkeypatch.setattr(time, "sleep", slept.append)
    return slept


def test_a_dropped_connection_and_a_5xx_are_retried_with_backoff_and_only_the_report_is_saved(attest_dir, monkeypatch):
    slept = naps(monkeypatch)
    model = Answers(None, 503, 200)
    name = runner.save_attestation(model)
    assert model.fetches == 3 and slept == [2, 4]
    assert [p.name for p in attest_dir.iterdir()] == [name]
    assert json.loads((attest_dir / name).read_text())["report"] == super(Answers, model).attestation()["report"]


def test_no_file_without_a_report_and_no_retry_on_a_client_error(attest_dir, monkeypatch):
    slept = naps(monkeypatch)
    throttled = Answers(429)
    assert runner.save_attestation(throttled) is None
    assert throttled.fetches == 4 and slept == [2, 4, 8], "429 every time: four fetches, then give up"
    refused = Answers(401)
    assert runner.save_attestation(refused) is None and refused.fetches == 1, "a 401 will not get better"
    assert list(attest_dir.iterdir()) == [], "an error answer is never saved as a report"


def test_near_ai_client_reports_a_dropped_connection_instead_of_raising(monkeypatch):
    def drop(*_a, **_k):
        raise requests.ConnectionError("Remote end closed connection without response")

    monkeypatch.setattr(nearai.requests, "get", drop)
    att = nearai.NearAiClient("k", "deepseek-ai/DeepSeek-V4.1-Flash-1017").attestation()
    assert att is not None and att["status"] is None and "report" not in att


def test_two_reports_in_the_same_second_are_two_files(attest_dir):
    model = Answers(200)
    assert runner.save_attestation(model) != runner.save_attestation(model)
    assert len(list(attest_dir.iterdir())) == 2


def test_rows_stay_verifiable_when_the_report_at_start_failed(attest_dir, monkeypatch):
    naps(monkeypatch)
    monkeypatch.setattr(runner, "DATA", attest_dir.parent / "decisions.jsonl")
    monkeypatch.delitem(ENV, "AGENT_KEY_Y", raising=False)
    monkeypatch.delitem(ENV, "AGENT_SEED_Y", raising=False)
    model = Answers(502, 502, 502, 502, 200)
    attestations = {model.model_id: runner.save_attestation(model)}
    assert attestations == {model.model_id: None} and model.fetches == 4
    d, sk, comp = runner.make_duelist("Y", model, hardened=False)

    def decide(nonce: int) -> dict:
        prep = runner.prepare_decision(
            "5", "NEAR/USD", 366_000_000, 365_000_000, 100 * S, {}, nonce, d, sk, comp, model, attestations
        )
        assert prep is not None
        return prep[3]

    first = decide(1)
    assert model.fetches == 5, "the row's signer is not in any saved report: fetched again"
    assert first["attestation_file"] == attestations[model.model_id] is not None
    assert check_row(first) == (True, "ok")
    assert check_row(decide(2)) == (True, "ok") and model.fetches == 5, "listed now: no fetch for the next row"


def test_a_signer_missing_from_the_report_fetches_it_at_most_once_a_minute(attest_dir, monkeypatch):
    naps(monkeypatch)
    model = Answers(200)
    saved = runner.save_attestation(model)
    attestations = {model.model_id: saved}
    stranger = {"signing_address": "ab" * 32}  # a node the report does not list (scaled out since)
    assert runner.attestation_file(model, stranger, attestations) != saved and model.fetches == 2
    assert runner.attestation_file(model, stranger, attestations) == attestations[model.model_id]
    assert model.fetches == 2, "within ATTEST_RETRY_S: the saved report is cited, nothing fetched"
    clock = time.monotonic() + runner.ATTEST_RETRY_S
    monkeypatch.setattr(time, "monotonic", lambda: clock)
    runner.attestation_file(model, stranger, attestations)
    assert model.fetches == 3
