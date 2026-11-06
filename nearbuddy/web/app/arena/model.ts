// Pure derivations for the arena page: the duel in focus (live, else the last finished one), each side's
// standing if the bell rang at the current reference price, and the attack-and-reply story. No React here,
// so the rules are easy to read and to check.
import type { Summary } from "../api/arena";
import type { Decision } from "../api/dataset";
import type { ArenaEvent } from "../api/tape";
import type { Tick } from "../lib/live";

export type Intent = Extract<ArenaEvent, { kind: "intent" }>;
export type Attack = Extract<ArenaEvent, { kind: "attack" }>;
export type Side = {
  agent: string;
  model: string;
  side: "Long" | "Short" | null;
  size_pct: number | null;
  verified: boolean;
  bond: number | null;
};
export type Focus = {
  duel: number;
  live: boolean;
  opened: number;
  closes: number;
  open: number | null;
  close: number | null;
  pot: number;
  a: Side;
  b: Side;
  winner: string | null;
  slashed: number;
  lockS: number;
  slashPct: number;
};

export function focusOf(s: Summary): Focus | null {
  const bond = (pk: string) => s.standings.find((x) => x.agent === pk)?.bond_near ?? null;
  const base = { lockS: s.rules.decisions_locked_last_seconds, slashPct: s.rules.loser_slashed_pct };
  if (s.live) {
    const l = s.live;
    return {
      ...base,
      duel: l.duel,
      live: true,
      opened: l.opened_at,
      closes: l.closes_at,
      open: l.open_price_usd,
      close: null,
      pot: l.pot_near,
      a: { ...l.a, bond: bond(l.a.agent) },
      b: { ...l.b, bond: bond(l.b.agent) },
      winner: null,
      slashed: 0,
    };
  }
  const r = s.recent[0];
  if (!r) return null;
  return {
    ...base,
    duel: r.duel,
    live: false,
    opened: r.opened_at,
    closes: r.closed_at,
    open: r.open_price_usd,
    close: r.close_price_usd,
    pot: 0,
    a: { ...r.a, bond: bond(r.a.agent) },
    b: { ...r.b, bond: bond(r.b.agent) },
    winner: r.winner,
    slashed: r.slashed_near,
  };
}

/** Return in % for one side if the duel were scored at `price`, the contract's rule on its last call. */
export const markPct = (side: Side, open: number | null, price: number | null) => {
  if (!side.side || side.size_pct == null || !open || !price) return 0;
  return (side.side === "Long" ? 1 : -1) * ((price - open) / open) * side.size_pct;
};

/** The price the race is measured against: the oracle's open, else the first trade after the duel opened. */
export const openOf = (f: Focus, ticks: Tick[]) => f.open ?? ticks.find((t) => t.t >= f.opened)?.p ?? null;

/** Last trade at or before `t` (ticks are oldest first). */
export function priceAt(ticks: Tick[], t: number): number | null {
  let lo = 0;
  let hi = ticks.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = ticks[mid] as Tick;
    if (m.t <= t) {
      best = m.p;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export const duelEvents = (events: ArenaEvent[], duel: number) => ({
  intents: events
    .filter((e): e is Intent => e.kind === "intent" && e.duel === duel && e.ok)
    .sort((x, y) => x.at - y.at),
  attacks: events
    .filter((e): e is Attack => e.kind === "attack" && e.duel === duel && e.ok)
    .sort((x, y) => x.at - y.at),
});

export type Story = {
  attack: Attack | null; // null when the story comes from the dataset only (no chain event in the window)
  text: string | null;
  target: string;
  model: string;
  duel: number;
  reply: Intent | null;
  d: Decision | null;
};

/** The newest paid attack on the tape and the target's next call; else the newest attacked dataset row. */
export function latestStory(
  events: ArenaEvent[],
  byTx: Map<string, Decision>,
  attacked: Decision[],
  modelOf: (pk: string) => string,
): Story | null {
  const atk = events.find((e): e is Attack => e.kind === "attack" && e.ok);
  if (atk) {
    const reply =
      events
        .filter((e): e is Intent => e.kind === "intent" && e.ok && e.agent === atk.target && e.at > atk.at)
        .sort((x, y) => x.at - y.at)[0] ?? null;
    return {
      attack: atk,
      text: atk.text,
      target: atk.target,
      model: modelOf(atk.target),
      duel: atk.duel,
      reply,
      d: reply ? (byTx.get(reply.tx) ?? null) : null,
    };
  }
  const d = attacked.at(-1);
  return d
    ? { attack: null, text: d.attack, target: d.agent, model: d.model, duel: Number(d.duel), reply: null, d }
    : null;
}
