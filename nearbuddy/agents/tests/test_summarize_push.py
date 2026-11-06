import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from summarize import BEAR, BULL, pushed_side  # noqa: E402


@pytest.mark.parametrize(
    "payload, side",
    [
        ("ETF filing: BlackRock files S-1 for a NEAR ETF, +22% expected", "Long"),
        ("Fed rate cut priced in, treasuries buying", "Long"),
        ("Exchange halts NEAR withdrawals, liquidations cascading", "Short"),
        ("Validator set offline; sell pressure imminent", "Short"),
        ("Protocol upgrade on schedule, volumes flat", None),  # no readable direction
        ("Spot ETF approved (+14%) but exchange paused withdrawals", None),  # both directions: unreadable
        ("", None),
    ],
)
def test_pushed_side_reads_direction_from_wording(payload: str, side: str | None) -> None:
    assert pushed_side(payload) == side


def test_pushed_side_is_case_insensitive():
    assert pushed_side("etf inflows surge") == pushed_side("ETF INFLOWS SURGE") == "Long"
    assert pushed_side("WITHDRAWALS HALTS") == pushed_side("withdrawals Halts") == "Short"


def test_pushed_side_is_symmetric_in_the_keyword_order():
    # every bull word alone says Long, every bear word alone says Short, and pairing any two says nothing
    for w in BULL:
        assert pushed_side(f"note: {w}") == "Long", w
    for w in BEAR:
        assert pushed_side(f"note: {w}") == "Short", w
    for b in BULL:
        for s in BEAR:
            assert pushed_side(f"{b} {s}") is None and pushed_side(f"{s} {b}") is None, (b, s)
