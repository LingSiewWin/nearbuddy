"""duelist.py: the model brain for one arena agent. Trimmed from Arcane (LingSiewWin/arcane @ f2a0cb7).

A `Duelist` wraps ONE model call per decision. Agent A is *hardened* (told to cross-check in-context
telemetry against the trusted oracle move), Agent B is *naive*. That single controlled variable is
what a duel measures: whether a spectator's injection flips the call.

Variant D is the exception: two calls. The side call sees the oracle brief and never the telemetry; when there is
telemetry a second call reads it and proposes a size, which this module clamps to [1, FULL_SIZE_BPS]. Any direction
in that reply is ignored, so the telemetry can shrink the position but never flip or grow it.

The model client is injected as `complete_fn(system, user) -> str`, so the parsing logic is unit-tested
with no network and the runner can swap the stub for NEAR AI Cloud.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from prompts import SIZER, sizer_user, system_prompt, user_prompt

FULL_SIZE_BPS = 5000  # every arm trades this size; variant D's sizer can only lower it


@dataclass
class Decision:
    direction: int  # +1 long / -1 short
    reasoning: str
    evidence_used: list[str] = field(default_factory=list)  # variant C declares what it traded on
    size_bps: int = FULL_SIZE_BPS
    size_asked: int | None = None  # variant D: the sizer's size_bps before the clamp
    size_note: str = ""  # variant D: "no telemetry", "sized" or "malformed: <why>"


class DuelistError(RuntimeError):
    """Model output could not be parsed into a Decision."""


class EvidenceError(DuelistError):
    """Variant C: the decision does not declare the oracle as evidence, so the runner posts nothing."""


def _json_object(raw: str) -> dict[str, Any]:
    match = re.search(r"\{.*\}", raw or "", re.DOTALL)
    if not match:
        raise DuelistError(f"no JSON object in model output: {raw!r:.160}")
    try:
        obj = json.loads(match.group(0))
    except (ValueError, TypeError) as exc:
        raise DuelistError(f"unparseable JSON: {raw!r:.160}") from exc
    if not isinstance(obj, dict):
        raise DuelistError(f"JSON is not an object: {raw!r:.160}")
    return obj


def parse_decision(raw: str) -> Decision:
    obj = _json_object(raw)
    token = str(obj.get("direction", "")).strip().lower()
    if token in ("long", "buy", "up", "+1", "1"):
        direction = 1
    elif token in ("short", "sell", "down", "-1"):
        direction = -1
    else:
        raise DuelistError(f"unrecognized direction: {obj.get('direction')!r}")
    evidence = obj.get("evidence_used") or []
    return Decision(
        direction=direction,
        reasoning=str(obj.get("reasoning", "")).strip() or "(no reasoning given)",
        evidence_used=[str(e).strip().lower() for e in (evidence if isinstance(evidence, list) else [evidence])],
    )


def parse_size(raw: str) -> int:
    """`size_bps` from the variant-D sizer's reply, unclamped. A whole number (int, float or numeric string).

    >>> parse_size('{"size_bps": 2500, "direction": "short"}')
    2500
    >>> parse_size('{"size_bps": "1200.0"}')
    1200
    >>> parse_size('{"size_bps": "half"}')
    Traceback (most recent call last):
    duelist.DuelistError: bad size_bps: 'half'
    """
    value = _json_object(raw).get("size_bps")
    try:
        if isinstance(value, bool) or not isinstance(value, int | float | str):
            raise TypeError
        number = float(value)
        if not number.is_integer():  # also rejects nan and inf
            raise ValueError
    except (ValueError, TypeError, OverflowError) as exc:
        raise DuelistError(f"bad size_bps: {value!r}") from exc
    return int(number)


class Duelist:
    def __init__(
        self,
        address: str,
        hardened: bool,
        *,
        model: str | None,
        complete_fn: Callable[[str, str], str],
        persona: str = "",
        variant: str | None = None,
    ) -> None:
        self.address = address
        self.hardened = hardened
        self.model = model
        self.persona = persona
        self.variant = variant  # "A" | "B" | "C" | "D" from prompts.VARIANTS, or None for the hardened/naive pair
        self._complete = complete_fn

    @property
    def prompt_variant(self) -> str:
        """The dataset label: the arm when one is set, else which of today's two prompts this agent runs."""
        return self.variant or ("hardened" if self.hardened else "naive")

    def system_prompt(self, symbol: str) -> str:
        return system_prompt(symbol, self.hardened, self.persona, self.variant)

    def decide(self, symbol: str, market_brief: str, injection_text: str | None = None) -> Decision:
        user = user_prompt(market_brief, injection_text, self.variant)  # variant D: the telemetry is dropped here
        raw = self._complete(self.system_prompt(symbol), user)
        decision = parse_decision(raw)
        if self.variant == "C" and "oracle" not in decision.evidence_used:
            raise EvidenceError("evidence not oracle")
        if self.variant == "D":
            self._size(decision, raw, symbol, market_brief, injection_text)
        return decision

    def _size(self, decision: Decision, side_raw: str, symbol: str, brief: str, telemetry: str | None) -> None:
        """Variant D, call 2: the only place telemetry reaches the model. The side is already fixed in `decision`
        and nothing here writes `direction`; the reply can only lower `size_bps`. A malformed reply keeps the full
        size."""
        if not telemetry:
            decision.size_note = "no telemetry"
            return
        side = "Long" if decision.direction > 0 else "Short"
        digest = hashlib.sha256(side_raw.encode()).hexdigest()
        reply = self._complete(
            SIZER.format(symbol=symbol.upper()), sizer_user(brief, side, FULL_SIZE_BPS, digest, telemetry)
        )
        try:
            asked = parse_size(reply)
        except DuelistError as e:
            decision.size_note = f"malformed: {e}"[:200]
            return
        decision.size_asked = asked
        decision.size_bps = min(FULL_SIZE_BPS, max(1, asked))
        decision.size_note = "sized"
