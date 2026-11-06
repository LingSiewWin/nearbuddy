// Pure derivations for the arena page: the duel in focus (live, else the last finished one), each side's
// standing if the bell rang at the current reference price, and the attack-and-reply story. No React here,
// so the rules are easy to read and to check.
import type { Summary } from "../api/arena";
import type { Decision } from "../api/dataset";
import type { ArenaEvent } from "../api/tape";
import type { Tick } from "../lib/live";

/** A public call: a plain intent, or a sealed (commit-reveal) intent once it is revealed. */
export type Intent = Extract<ArenaEvent, { kind: "intent" | "reveal" }>;
export const isCall = (e: ArenaEvent): e is Intent => e.kind === "intent" || e.kind === "reveal";
export type Attack = Extract<ArenaEvent, { kind: "attack" }>;
/** When a call was fixed: a plain intent when it landed; a reveal when its commit landed (the agent's newest commit
 *  in the same duel at or before the reveal), since under commit-reveal the side was chosen then, not at the reveal. */
export const fixedAt = (c: Intent, events: ArenaEvent[]): number | null => {
  if (c.kind !== "reveal") return c.at;
  const commits = events
    .filter((e) => e.kind === "commit" && e.ok && e.duel === c.duel && e.agent === c.agent && e.at <= c.at)
    .map((e) => e.at);
  // no commit in view: it is older than everything here (the window is contiguous), so not after any attack in it
  return commits.length ? Math.max(...commits) : null;
};
/** The target's first call fixed after an attack: the call that could have read the lie. */
export const replyTo = (a: Attack, events: ArenaEvent[]): Intent | null =>
  events
    .filter((e): e is Intent => isCall(e) && e.ok && e.duel === a.duel && e.agent === a.target)
    .filter((c) => (fixedAt(c, events) ?? Number.NEGATIVE_INFINITY) > a.at)
    .sort((x, y) => x.at - y.at)[0] ?? null;
export type Side = {
  agent: string;
  model: string;
  side: "Long" | "Short" | null;
  size_pct: number | null;
  verified: boolean;
  bond: number | null;
  return_pct?: number | null; // the contract's score, on a resolved duel
  sealed?: boolean; // live, commit-reveal: a call is committed on chain and not revealed yet
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
  sealed: boolean; // commit-reveal: calls are hidden until revealed
  forfeitPct: number;
  consent: boolean;
};

export function focusOf(s: Summary): Focus | null {
  const bond = (pk: string) => s.standings.find((x) => x.agent === pk)?.bond_near ?? null;
  const base = {
    lockS: s.rules.decisions_locked_last_seconds,
    slashPct: s.rules.loser_slashed_pct,
    sealed: s.rules.sealed_calls,
    forfeitPct: s.rules.no_reveal_forfeit_pct,
    consent: s.rules.pairing_needs_consent,
  };
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

/** A live duel's sides with their newest call from the tape: the contract view behind the summary is cached
 *  for seconds, the tape is fresher, and the headline must not say "yet to make a call" beside a call. */
export function withTape(f: Focus | null, events: ArenaEvent[]): Focus | null {
  if (!f?.live) return f;
  const latest = (pk: string) =>
    events.find((e): e is Intent => isCall(e) && e.ok && e.duel === f.duel && e.agent === pk);
  // the tape is newest first: a commit newer than the side's last reveal is a call nobody can read yet
  const commit = (pk: string) => events.find((e) => e.kind === "commit" && e.ok && e.duel === f.duel && e.agent === pk);
  const patch = (s: Side): Side => {
    const e = latest(s.agent);
    const c = commit(s.agent);
    const sealed = !!c && (!e || c.at > e.at);
    const shown = e ? { ...s, side: e.side, size_pct: e.size / 100, verified: e.tee === 2 } : s;
    return { ...shown, sealed };
  };
  return { ...f, a: patch(f.a), b: patch(f.b) };
}

/** Return in % for one side if the duel were scored at `price`, by the contract's own rule: its last call,
 *  integer basis points truncated toward zero on prices x1e8 (pnl_bps = sign * (close - open) * size_bps / open),
 *  so a move too small to score shows as 0, the way the contract will count it. */
export const markPct = (side: Side, open: number | null, price: number | null) => {
  if (!side.side || side.size_pct == null || !open || !price) return 0;
  const o = Math.round(open * 1e8);
  const c = Math.round(price * 1e8);
  const bps = Math.trunc(((side.side === "Long" ? 1 : -1) * (c - o) * Math.round(side.size_pct * 100)) / o);
  return bps / 100;
};

/** The price the race is measured against: the oracle's open, else the first trade after the duel opened. */
export const openOf = (f: Focus, ticks: Tick[]) => {
  // live: compare Coinbase with Coinbase (the oracle's open can be up to 300 s old, so mixing the two invents
  // a move); scored: the oracle's own open, the price the contract used
  const first = ticks.find((t) => t.t >= f.opened)?.p ?? null;
  return f.live ? (first ?? f.open) : (f.open ?? first);
};

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
  intents: events.filter((e): e is Intent => isCall(e) && e.duel === duel && e.ok).sort((x, y) => x.at - y.at),
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
  replyFixed?: number | null; // when the reply's side was chosen: its commit under commit-reveal, else the call
  d: Decision | null;
};

/** The newest paid attack on the tape and the target's next call; else the newest attacked dataset row. */
export function latestStory(
  events: ArenaEvent[],
  byTx: Map<string, Decision>,
  attacked: Decision[],
  modelOf: (pk: string) => string,
  trusted: (pk: string) => boolean = () => true,
): Story | null {
  // the newest attack on an enclave-verified agent: red-team bots must not take over the story
  const atk = events.find((e): e is Attack => e.kind === "attack" && e.ok && trusted(e.target));
  if (atk) {
    const reply = replyTo(atk, events);
    const replyFixed = reply ? fixedAt(reply, events) : null;
    return {
      attack: atk,
      text: atk.text,
      target: atk.target,
      model: modelOf(atk.target),
      duel: atk.duel,
      reply,
      replyFixed,
      d: reply ? (byTx.get(reply.tx) ?? null) : null,
    };
  }
  const d = attacked.at(-1);
  return d
    ? { attack: null, text: d.attack, target: d.agent, model: d.model, duel: Number(d.duel), reply: null, d }
    : null;
}
