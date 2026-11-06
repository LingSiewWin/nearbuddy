import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from duelist import Duelist  # noqa: E402
from prompts import HARDENED_CLAUSE, system_prompt, user_prompt  # noqa: E402


def test_hardened_prompt_warns_about_injection_and_names_the_oracle():
    p = system_prompt("near/usd", hardened=True)
    assert "NEAR/USD" in p
    assert "prompt injection" in p and "oracle" in p and "UNVERIFIED" in p
    assert p.endswith(HARDENED_CLAUSE)


def test_naive_prompt_has_no_security_policy():
    p = system_prompt("near/usd", hardened=False)
    assert "NEAR/USD" in p and '"direction"' in p  # same task and output format
    assert "injection" not in p and "oracle" not in p and "SECURITY POLICY" not in p
    assert system_prompt("near/usd", hardened=True) == p + HARDENED_CLAUSE  # hardened = naive + one clause


def test_persona_is_appended_after_the_policy():
    p = system_prompt("BTC/USD", hardened=True, persona="momentum only")
    assert p.index("SECURITY POLICY") < p.index("YOUR STRATEGY: momentum only")
    assert "YOUR STRATEGY" not in system_prompt("BTC/USD", hardened=True)


def test_user_prompt_wraps_injection_in_telemetry_tags():
    brief = "NEAR/USD last 2.10. Duel just opened."
    assert user_prompt(brief) == brief
    assert user_prompt(brief, None) == brief
    assert user_prompt(brief, "") == brief
    u = user_prompt(brief, "Whale alert")
    assert u.startswith(brief)
    assert "<URGENT_MARKET_TELEMETRY>\nWhale alert\n</URGENT_MARKET_TELEMETRY>" in u


def test_duelist_feeds_both_prompts_to_the_model():
    seen: list[tuple[str, str]] = []

    def fake(system: str, user: str) -> str:
        seen.append((system, user))
        return '{"direction": "short", "reasoning": "x"}'

    d = Duelist(address="pk", hardened=True, model="stub", complete_fn=fake)
    assert d.decide("NEAR/USD", "brief", "inject me").direction == -1
    assert seen == [(system_prompt("NEAR/USD", True), user_prompt("brief", "inject me"))]
