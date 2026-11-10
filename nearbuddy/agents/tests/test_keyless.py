"""Keyless request builder and response parse against fixtures/keyless-vectors.json (written by arena/src/keyless.rs,
read by packages/protocol/src/keyless.test.ts too)."""

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from keyless import keyless_id, keyless_request, parse_decision  # noqa: E402

V = json.loads((Path(__file__).resolve().parents[2] / "fixtures" / "keyless-vectors.json").read_text())


@pytest.mark.parametrize("case", V["cases"], ids=[c["name"] for c in V["cases"]])
def test_case_builds_the_contracts_bytes(case):
    body = keyless_request(case["inputs"])
    assert body.hex() == case["request_hex"]
    assert hashlib.sha256(body).hexdigest() == case["request_sha256"]
    parsed = json.loads(body)
    assert (parsed["seed"], parsed["temperature"]) == (case["seed"], 0)


@pytest.mark.parametrize("edge", V["reject"], ids=[r["name"] for r in V["reject"]])
def test_reject_edge_refused_with_the_contracts_text(edge):
    with pytest.raises(ValueError) as e:
        keyless_request({**V["cases"][0]["inputs"], **edge["patch"]})
    assert str(e.value) == edge["error"]


@pytest.mark.parametrize("p", V["parse"], ids=[p["name"] for p in V["parse"]])
def test_response_parses_like_the_contract(p):
    d = parse_decision(p["response"].encode(), p["headlines"])
    assert (None if d is None else {"side": d[0], "size_bps": d[1]}) == p["decision"]


def test_agent_id():
    i = V["id"]
    assert keyless_id(i["contract"], i["owner"], i["n"]).hex() == i["id_hex"]


@pytest.mark.parametrize("bad", ["-1", "18446744073709551616", "1.5", "0x10", "", True])
def test_u64_refused_like_the_contracts_json_ingress(bad):
    with pytest.raises(ValueError):
        keyless_request({**V["cases"][0]["inputs"], "duel_id": bad})
