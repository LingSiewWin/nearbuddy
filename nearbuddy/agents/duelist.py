"""duelist.py: the model brain for one arena agent. Trimmed from Arcane (LingSiewWin/arcane @ f2a0cb7).

A `Duelist` wraps ONE model call per decision. Agent A is *hardened* (told to cross-check in-context
telemetry against the trusted oracle move), Agent B is *naive*. That single controlled variable is
what a duel measures: whether a spectator's injection flips the call.

The model client is injected as `complete_fn(system, user) -> str`, so the parsing logic is unit-tested
with no network and the runner can swap the stub for NEAR AI Cloud.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass

from prompts import system_prompt, user_prompt


@dataclass
class Decision:
    direction: int  # +1 long / -1 short
    reasoning: str


class DuelistError(RuntimeError):
    """Model output could not be parsed into a Decision."""


def parse_decision(raw: str) -> Decision:
    match = re.search(r"\{.*\}", raw or "", re.DOTALL)
    if not match:
        raise DuelistError(f"no JSON object in model output: {raw!r:.160}")
    try:
        obj = json.loads(match.group(0))
    except (ValueError, TypeError) as exc:
        raise DuelistError(f"unparseable JSON: {raw!r:.160}") from exc
    token = str(obj.get("direction", "")).strip().lower()
    if token in ("long", "buy", "up", "+1", "1"):
        direction = 1
    elif token in ("short", "sell", "down", "-1"):
        direction = -1
    else:
        raise DuelistError(f"unrecognized direction: {obj.get('direction')!r}")
    return Decision(direction=direction, reasoning=str(obj.get("reasoning", "")).strip() or "(no reasoning given)")


class Duelist:
    def __init__(
        self,
        address: str,
        hardened: bool,
        *,
        model: str | None,
        complete_fn: Callable[[str, str], str],
        persona: str = "",
    ) -> None:
        self.address = address
        self.hardened = hardened
        self.model = model
        self.persona = persona
        self._complete = complete_fn

    def system_prompt(self, symbol: str) -> str:
        return system_prompt(symbol, self.hardened, self.persona)

    def decide(self, symbol: str, market_brief: str, injection_text: str | None = None) -> Decision:
        return parse_decision(self._complete(self.system_prompt(symbol), user_prompt(market_brief, injection_text)))
