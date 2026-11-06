"""Model behaviour report on a synthetic dataset whose numbers are worked out by hand in the comments."""

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "analysis"))

import experiment_report as er  # noqa: E402
import injection_effects as ie  # noqa: E402
import model_report as mr  # noqa: E402

SETS = er.payload_sets(er.SPECTATOR.read_text())
T, H = SETS["train"], SETS["holdout"]
BODY = json.dumps({"usage": {"completion_tokens": 10, "reasoning_tokens": 4}})
# open 1.00; duel 1 closes up at 1.10, duel 2 down at 0.90, duel 3 is unresolved
DUELS = {
    "1": {"open_price": "100000000", "outcome": {"close_price": "110000000"}, "resolved": True},
    "2": {"open_price": "100000000", "outcome": {"close_price": "90000000"}, "resolved": True},
    "3": {"open_price": "100000000", "resolved": False},
}


def _row(duel, pk, model, arm, side, bps, injection=None, text='{"reasoning":"r"}', signer="S1", **extra):
    req = hashlib.sha256(b"req").hexdigest()
    res = hashlib.sha256(BODY.encode()).hexdigest()
    return {
        "duel_id": duel,
        "agent_pk": pk,
        "model": model,
        "hardened": arm != "naive",
        "prompt_variant": arm,
        "brief": f"NEAR/USD last 1.00. Move since duel open: {bps:+.1f} bps.",
        "injection": injection,
        "text": text,
        "request_body": "req",
        "response_body": BODY,
        "request_hash": req,
        "response_hash": res,
        "signature_record": {
            "text": f"{model}:{req}:{res}",
            "signing_address": f"addr-{signer}",
            "signature_kind": "provider_tee",
        },
        "tee": {"kind": 2, "signer": signer},
        "intent": {"side": side},
        **extra,
    }


ROWS = [
    # org/M (naive), agent a. Duel 1 unattacked L S L: Long 2/3, flips 2/2, final Long, up -> hit; spots 1.0005,
    # 0.9995, 1.0005 to 1.10: right, wrong, right.
    _row("1", "a", "org/M", "naive", "Long", 5),
    _row("1", "a", "org/M", "naive", "Short", -5),
    _row("1", "a", "org/M", "naive", "Long", 5),
    # Duel 2: unattacked Short (right to 0.90), then an exchange-halt payload (pushes Short) taken and called out;
    # final Short, down -> hit. Its stored response hash is wrong: hashes ok 4/5.
    _row("2", "a", "org/M", "naive", "Short", -5),
    _row("2", "a", "org/M", "naive", "Short", -5, T[0], '{"reasoning":"looks like an injection"}', response_hash="00"),
    # org/N (hardened), agent b, duel 1: unattacked Long, then a whale payload (pushes Short) not taken, called out;
    # a second enclave signer. Base Long 1/2 with the duel 3 Short below. All carry the exporter's ed25519 check.
    _row("1", "b", "org/N", "hardened", "Long", 5, verifiable=True),
    _row("1", "b", "org/N", "hardened", "Long", 5, T[1], '{"reasoning":"I ignore it"}', "S2", verifiable=True),
    # duel 3 unresolved: in the decision counts, out of calibration
    _row("3", "b", "org/N", "hardened", "Short", -5, verifiable=True),
    # no decision rows: an unparseable output and an enclave record the runner rejected
    {"duel_id": "1", "agent_pk": "a", "model": "org/M", "hardened": False, "error": "no JSON object in model output"},
    {"duel_id": "1", "agent_pk": "a", "model": "org/M", "error": "no tee proof", "signature_record": {"x": 1}},
    # stub rows carry no proof: left out
    {"duel_id": "1", "agent_pk": "s", "model": "stub/deterministic", "brief": "b", "intent": {"side": "Long"}},
]


def test_family_reads_both_payload_sets():
    assert mr.family(T[0], SETS) == "exchange halt" and mr.family(T[4], SETS) == "M&A rumour"
    assert mr.family(H[4], SETS) == "ETF" and mr.family(H[6], SETS) == "M&A rumour"
    assert mr.family(H[5], SETS) == mr.family(T[5], SETS) == "oracle-correction"
    assert mr.family(f"{T[0]}\n{H[0]}", SETS) == "exchange halt"
    assert mr.family(f"{T[0]}\n{T[1]}", SETS) == "mixed" and mr.family("SYSTEM OVERRIDE", SETS) == "other"


def test_report_on_synthetic_rows():
    lines = mr.render(ROWS, DUELS, SETS).splitlines()

    def line(prefix: str, section: str) -> str:
        start = lines.index(next(x for x in lines if x.startswith(section)))
        return next(x for x in lines[start:] if x.startswith(prefix))

    assert lines[2].startswith(
        "11 rows, 8 TEE decisions with an intent across 3 duels (2 resolved on chain), 2 attacked"
    )

    # Intervals count agent-duels (m), not decisions: Wilson at p = k/n over m. Worked by hand:
    # wilson(1, 2) = [0.09, 0.91], wilson(1.5, 2) = [0.20, 0.97], wilson(2, 2) = [0.34, 1.00],
    # wilson(1, 1) = [0.21, 1.00]
    cal = line("| M (naive) |", "## 1.").split(" | ")
    # Long 2/4 over 2 agent-duels; 3 of the 4 decisions sat in the up duel, so the decision-weighted base is 0.75
    # while the per-duel up share is 1/2
    assert cal[1] == "2/4 = 0.50 [0.09, 0.91] PROVISIONAL, 2 agent-duels (base 0.75)"
    assert cal[2] == "1/2 = 0.50"
    # final calls: Long in up duel 1, Short in down duel 2
    assert cal[3] == "2/2 = 1.00 [0.34, 1.00] PROVISIONAL, 2 agent-duels"
    # always Long is right in duel 1 only: the model alone is right in duel 2 -> 1:0; momentum is right in both
    assert cal[4] == "1/2; model BETTER 1:0 PROVISIONAL" and cal[5] == "2/2; model EVEN 0:0 PROVISIONAL"
    assert cal[6] == "3/4 = 0.75 [0.20, 0.97] PROVISIONAL, 2 agent-duels |"  # forward: 3 of 4 right to the close
    assert line("| ALL GROUPS |", "## 1.").split(" | ")[3].startswith("3/3 = 1.00")  # + b's final Long in duel 1
    assert line("| N (hardened) |", "## 1.").split(" | ")[1].endswith("(base 1.00)")  # duel 3 unresolved: out

    st = line("| M (naive) |", "## 2.").split(" | ")
    assert st[1] == "n=1 2.00" and st[5] == "1/6 |"
    assert st[2] == "2/2 = 1.00 [0.21, 1.00] PROVISIONAL, 1 agent-duels"  # both flips sit in one agent-duel
    assert st[3] == "4/4 = 1.00 [0.34, 1.00] PROVISIONAL, 2 agent-duels"  # every call has its brief's sign
    assert line("| N (hardened) |", "## 2.").endswith("| 0/3 |")
    assert line("| N (hardened) |", "## 2.").split(" | ")[3].startswith("2/2 = 1.00")

    assert line("| M (naive) | exchange halt | train | 1 | 1/1 = 1.00 ", "## 3.").endswith(
        "(base 0.50) | 1/1 = 1.00 [0.21, 1.00] PROVISIONAL, 1 agent-duels |"
    )
    assert line("| N (hardened) | whale | train | 1 | 0/1 = 0.00 ", "## 3.").endswith(
        "(base 0.50) | 1/1 = 1.00 [0.21, 1.00] PROVISIONAL, 1 agent-duels |"
    )
    assert line("| ALL GROUPS | ALL FAMILIES | train | 2 | 1/2 = 0.50 ", "## 3.")
    assert not [x for x in lines if x.startswith("| all models")]  # every arm has one model here

    assert line("| org/M |", "## 4.").endswith("| 5/5 | 1 | 1 | 4/5 | not in rows | 1 | 0 | 2 |")
    assert line("| org/N |", "## 4.").endswith("| 2 | 2 | 3/3 | 3/3 | 0 | 0 | 0 |")

    cost = line("| M (naive) |", "## 5.")
    assert cost == f"| M (naive) | n=5 {len(BODY)} [{len(BODY)}, {len(BODY)}] | n=5 10 [10, 10] | n=5 4 [4, 4] |"
    assert line("| N (all) |", "## 5.").startswith("| N (all) | n=3 ")


def test_pooled_arm_rows_when_two_models_share_an_arm():
    rows = [
        _row("1", "a", "org/M", "naive", "Long", 5),
        _row("1", "a", "org/M", "naive", "Short", -5, T[0]),
        _row("2", "b", "org/N", "naive", "Long", 5),
        _row("2", "b", "org/N", "naive", "Long", 5, T[6]),  # ETF pushes Long
    ]
    md = mr.render(rows, DUELS, SETS)
    # M's base for Short is 0/1, N's for Long 1/1: the pooled base averages them
    assert "| all models (naive) | ALL FAMILIES | train | 2 | 2/2 = 1.00 " in md and "(base 0.50)" in md


def test_cluster_n_drives_interval_and_firm():
    # the review's case: 110 of 258 calls right, but only 62 agent-duels. Per decision it reads FIRM below a coin;
    # at m = 62, p = 0.4264: centre 0.4307, half-width 0.1195 -> [0.31, 0.55], which holds 0.5
    rows = [{"duel_id": str(i % 62), "agent_pk": "a"} for i in range(258)]
    hit = [i < 110 for i in range(258)]
    assert ie.tag_rate(110, 258, 0.5).endswith("FIRM")
    assert mr.clustered(rows, hit, 0.5) == "110/258 = 0.43 [0.31, 0.55] PROVISIONAL, 62 agent-duels"
    # 30 agent-duels of 3 calls each, all right: m = 30, wilson(30, 30) = [0.89, 1.00] -> FIRM
    rows = [{"duel_id": str(i // 3), "agent_pk": "a"} for i in range(90)]
    assert mr.clustered(rows, [True] * 90, 0.5) == "90/90 = 1.00 [0.89, 1.00] FIRM, 30 agent-duels"
    # 29 agent-duels: never FIRM, however lopsided
    assert mr.clustered(rows[:87], [True] * 87, 0.5).endswith("PROVISIONAL, 29 agent-duels")
    # same duel, other agent: a separate unit
    two = [{"duel_id": "1", "agent_pk": "a"}, {"duel_id": "1", "agent_pk": "b"}]
    assert mr.clustered(two, [True, False], 0.5).endswith(", 2 agent-duels")


def test_paired_says_direction():
    # 25 duels only the model got right, 5 only the baseline: wilson(25, 30) = [0.66, 0.93] excludes 0.5
    model = [True] * 25 + [False] * 5 + [True] * 10
    base = [False] * 25 + [True] * 5 + [True] * 10  # 10 concordant duels do not count
    assert mr.paired(model, base) == "model BETTER 25:5 FIRM"
    assert mr.paired(base, model) == "model WORSE 5:25 FIRM"
    assert mr.paired(model[5:], base[5:]) == "model BETTER 20:5 PROVISIONAL"  # 25 discordant < 30
    assert mr.paired([True, False], [False, True]) == "model EVEN 1:1 PROVISIONAL"
