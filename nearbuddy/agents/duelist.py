"""duelist.py: the model brain for one arena agent. Trimmed from Arcane (LingSiewWin/arcane @ f2a0cb7).

A `Duelist` wraps ONE model call per decision. Agent A is *hardened* (told to cross-check in-context
telemetry against the trusted oracle move), Agent B is *naive*. That single controlled variable is
what a duel measures: whether a spectator's injection flips the call.

Variant D is the exception: two calls. The side call sees the oracle brief and never the telemetry; when there is
telemetry a second call reads it and proposes a size, which this module clamps to [1, FULL_SIZE_BPS]. Any direction
in that reply is ignored, so the telemetry can shrink the position but never flip or grow it.

Profile hardened-v2 (`prompts.user_v2`) asks for a side and a size from provenance-tagged blocks; `policy_size` caps
the size in code while paid text is in the request. With `judgments` k > 1 it asks k times on the same request bytes
and takes the majority side (ties: the first judgment's side); the aggregation is code, not another model call, so
no narrative a judgment repeats can steer it. The proof binds the first judgment on the majority side.

The model client is injected as `complete_fn(system, user) -> str`, so the parsing logic is unit-tested
with no network and the runner can swap the stub for NEAR AI Cloud.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from prompts import (
    FULL_SIZE_BPS,
    HARDENED_V2,
    SIZER,
    UNTRUSTED_CAP_BPS,
    sizer_user,
    system_prompt,
    user_prompt,
    user_v2,
)


@dataclass
class Decision:
    direction: int  # +1 long / -1 short
    reasoning: str
    evidence_used: list[str] = field(default_factory=list)  # variant C declares what it traded on
    size_bps: int = FULL_SIZE_BPS
    size_asked: int | None = None  # variant D: the sizer's size_bps before the clamp; hardened-v2: the model's size
    size_note: str = ""  # variant D: "no telemetry", "sized" or "malformed: <why>"
    size_cap: int | None = None  # hardened-v2: the policy cap applied to size_asked
    cues_removed: list[str] = field(default_factory=list)  # hardened-v2: what cue_guard took out of the injection
    votes: list[int] = field(default_factory=list)  # hardened-v2: each parsed judgment's direction, in call order
    proof_index: int | None = None  # hardened-v2: the call the intent's proof binds (None: the last call)


def policy_size(stated: int | None, untrusted: bool) -> tuple[int, int]:
    """(size, cap) for hardened-v2. The cap is the mandate's UNTRUSTED_CAP_BPS while paid text is in the request, else
    FULL_SIZE_BPS; the size is the model's stated size clamped to [1, cap], or the cap when it stated none.

    >>> policy_size(9000, True), policy_size(300, True), policy_size(None, False), policy_size(-5, False)
    ((1000, 1000), (300, 1000), (5000, 5000), (1, 5000))
    """
    cap = UNTRUSTED_CAP_BPS if untrusted else FULL_SIZE_BPS
    return (cap if stated is None else min(cap, max(1, stated))), cap


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
        judgments: int = 1,
    ) -> None:
        self.address = address
        self.hardened = hardened
        self.model = model
        self.persona = persona
        # "A" | "B" | "C" | "D" from prompts.VARIANTS, prompts.HARDENED_V2, or None for the hardened/naive pair
        self.variant = variant
        self.judgments = judgments  # hardened-v2 only: k calls per decision, majority side
        self._complete = complete_fn

    @property
    def prompt_variant(self) -> str:
        """The dataset label: the arm when one is set, else which of today's two prompts this agent runs."""
        return self.variant or ("hardened" if self.hardened else "naive")

    @property
    def profile(self) -> str:
        """`runner.py --profile`: naive, hardened or hardened-v2. A letter arm runs on the hardened agent."""
        return HARDENED_V2 if self.variant == HARDENED_V2 else ("hardened" if self.hardened else "naive")

    @profile.setter
    def profile(self, name: str) -> None:
        self.hardened = name != "naive"
        self.variant = HARDENED_V2 if name == HARDENED_V2 else None

    def system_prompt(self, symbol: str) -> str:
        return system_prompt(symbol, self.hardened, self.persona, self.variant)

    def decide(self, symbol: str, market_brief: str, injection_text: str | None = None) -> Decision:
        if self.variant == HARDENED_V2:
            return self._decide_v2(symbol, market_brief, injection_text)
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

    def _decide_v2(self, symbol: str, brief: str, injection: str | None) -> Decision:
        """hardened-v2: `judgments` calls on the same system and user messages; the majority side wins and the first
        call on that side is the proof. An unparseable judgment does not vote; if none parses, the first error is
        raised. The size is `policy_size` of the proof call's stated size."""
        system = self.system_prompt(symbol)
        user, cues = user_v2(brief, injection)
        judged: list[tuple[int, Decision, str]] = []
        errors: list[DuelistError] = []
        for i in range(max(1, self.judgments)):
            raw = self._complete(system, user)
            try:
                judged.append((i, parse_decision(raw), raw))
            except DuelistError as e:
                errors.append(e)
        if not judged:
            raise errors[0]
        side = Counter(d.direction for _, d, _ in judged).most_common(1)[0][0]  # ties: first seen
        index, decision, raw = next(j for j in judged if j[1].direction == side)
        try:
            decision.size_asked = parse_size(raw)
        except DuelistError:
            decision.size_asked = None
        decision.size_bps, decision.size_cap = policy_size(decision.size_asked, bool(injection))
        decision.cues_removed = cues
        decision.votes = [d.direction for _, d, _ in judged]
        decision.proof_index = index
        return decision
