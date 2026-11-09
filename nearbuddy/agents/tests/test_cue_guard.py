"""cue_guard: the golden vectors in fixtures/cue-guard-vectors.json (a TS or Rust port reads the same file), then
seeded property checks: idempotent, never adds a word, numbers and tickers survive, and a headline built from a claim
plus cues comes back as the claim."""

import hashlib
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cue_guard_v1  # noqa: E402
from cue_guard import CUE_GUARD_VERSION, VERSIONS, fold, normalize  # noqa: E402

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "fixtures" / "cue-guard-vectors.json").read_text())


@pytest.mark.parametrize("v", VECTORS["vectors"], ids=[v["name"] for v in VECTORS["vectors"]])
def test_golden_vector(v):
    assert normalize(v["input"]) == (v["clean"], v["cues"])


def test_vectors_cover_every_kind_and_the_evasions():
    kinds = Counter(v["kind"] for v in VECTORS["vectors"])
    assert len(VECTORS["vectors"]) >= 40
    assert {"urgency", "source", "emphasis", "evasion", "keep"} <= kinds.keys()
    assert kinds["evasion"] >= 8 and kinds["keep"] >= 6
    assert len({v["name"] for v in VECTORS["vectors"]}) == len(VECTORS["vectors"])


# facts cue_guard v1 changed: 10⁹ -> 109, 1½ -> 11⁄2, "$1 per trader" -> "$1", "NEAR ⬇ 20%" -> "NEAR 20%", "> 5%"
V1_CHANGED = [
    "superscript-exponent-kept",
    "vulgar-fraction-kept",
    "per-unit-trader-kept",
    "per-unit-person-kept",
    "arrow-emoji-down",
    "chart-emoji-down",
    "leading-greater-than-kept",
]


def test_the_vectors_are_this_version_and_v1_still_gives_its_own_output():
    assert VECTORS["cue_guard_version"] == CUE_GUARD_VERSION == 2
    vectors = {v["name"]: v for v in VECTORS["vectors"]}
    for name in V1_CHANGED:
        v = vectors[name]
        assert v["clean"] == v["input"].replace("⬇", "down").replace("📉", "down") and v["cues"] == [], name
        assert cue_guard_v1.normalize(v["input"]) != (v["clean"], v["cues"]), name  # so v1 rows verify only as v1


# claims with numbers and tickers; none carries a cue, so normalize must leave each one as written
CLAIMS = [
    "Binance halts {T} withdrawals after a {N}% drop",
    "{T} falls {N}% to ${P} in ten minutes",
    "Coinbase lists {T} perpetuals with {I}x leverage",
    "Validators holding {N}% of {T} stake go offline",
    "Whale moves {I} {T} to Kraken",
    "{T} breaking resistance at ${P} as funding flips to {N}%",
    "Unconfirmed reports suggest {T} bridge lost ${P}M",
    "Kraken delists {T} on 2026-11-{D} at 14:00 UTC",
    "Airdrop pays {I} {T} per trader, 1½% of supply, fees at 10⁻⁹ per tx",
]
TICKERS = ["NEAR", "BTC", "ETH", "SOL", "USDT", "$NEAR", "NEAR/USD", "AURORA"]
PREFIXES = [
    "BREAKING: ",
    "🚨 JUST IN 🚨 ",
    "[URGENT] ",
    "B R E A K I N G: ",
    "BR\u0395AKING: ",  # Greek capital epsilon
    "ＵＲＧＥＮＴ： ",
    "EXCLUSIVE - ",
    "Reuters: ",
    "NEWS: ",
    "**ALERT** ",
    "Sources say ",
    "Per Bloomberg, ",
    "According to the SEC, ",
    "BREA\u200bKING: ",
    "ʙʀᴇᴀᴋɪɴɢ — ",
    "J.U.S.T I.N: ",
    "Two people familiar with the matter said ",
]
SUFFIXES = [
    ", according to Reuters",
    "!!!",
    " — Whale Alert",
    " via @WatcherGuru",
    ", sources say",
    ", as confirmed by the SEC",
    " (Bloomberg)",
    ". Source: CoinDesk",
    " 🚀🚀",
    "! ! !",
]


def words(text: str) -> Counter:
    return Counter(re.findall(r"[^\W_]+", text.lower()))


def cases(n: int, seed: int = 20261110):
    rng = random.Random(seed)
    for _ in range(n):
        ticker = rng.choice(TICKERS)
        nums = {
            "N": f"{rng.randint(1, 99)}.{rng.randint(0, 9)}",
            "P": f"{rng.randint(1, 99_999):,}",
            "I": str(rng.randint(2, 50_000)),
            "D": f"{rng.randint(10, 28)}",
        }
        claim = rng.choice(CLAIMS).format(T=ticker, **nums)
        text = claim
        if rng.random() < 0.3:  # shout the claim; tickers in KEEP stay as written
            text = text.upper()
        k = rng.randint(0, 3)
        text = "".join(rng.sample(PREFIXES, k=min(k, 2))) + text + "".join(rng.sample(SUFFIXES, k=k % 2))
        yield claim, ticker, [v for v in nums.values() if v in claim], text


def test_a_claim_without_cues_comes_back_unchanged():
    for claim, _, _, _ in cases(300):
        assert normalize(claim) == (claim, []), claim


def test_properties_on_claims_wrapped_in_cues():
    for claim, ticker, nums, text in cases(600):
        clean, cues = normalize(text)
        assert normalize(clean) == (clean, []), text  # idempotent
        assert not words(clean) - words(fold(text)), text  # never adds a word
        for n in nums:
            assert n in clean, (text, n)  # numbers survive as written
        assert ticker.lstrip("$") in clean, (text, ticker)  # tickers survive, case and all
        assert clean.rstrip(".").lower() == claim.lower(), text  # only the cues went
        assert cues or text == claim


ALPHABET = (
    "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 .,;:!?-—|/$%#@*_~()[]<>\"' \n"
    "\u200b\u200d\ufeff\u00ad\u202e\u0336\ufe0f\u0395\u0410\u0435ʙᴀＢ𝐁🚨🔥‼\ufe0f"
)
SNIPPETS = ["BREAKING", "JUST IN", "according to ", "Reuters", "SEC", "NEAR", "!!!", "**", "B R E A K", "sources say"]


def test_idempotent_and_adds_no_word_on_random_text():
    rng = random.Random(7)
    for _ in range(1500):
        parts = [
            rng.choice(SNIPPETS) if rng.random() < 0.2 else "".join(rng.choices(ALPHABET, k=rng.randint(1, 12)))
            for _ in range(rng.randint(1, 8))
        ]
        text = " ".join(parts)
        clean, _ = normalize(text)
        assert normalize(clean) == (clean, []), repr(text)
        assert not words(clean) - words(fold(text)), repr(text)


def test_v1_is_frozen_for_the_rows_it_cleaned():
    # rows without guard.cue_guard are re-checked with this file; editing it would make them unverifiable
    v1 = Path(cue_guard_v1.__file__).read_bytes()
    assert hashlib.sha256(v1).hexdigest() == "706d1e8d5eb2890dfd5853464c9d5053f4520f3540af8a677ddbd069783f0a72"
    assert (VERSIONS[1], VERSIONS[CUE_GUARD_VERSION], len(VERSIONS)) == (cue_guard_v1.normalize, normalize, 2)


def test_deterministic():
    text = "🚨 ＢＲ\u0395AKING: Binance halts NEAR withdrawals, according to Reuters!!!"
    assert len({json.dumps(normalize(text)) for _ in range(5)}) == 1
