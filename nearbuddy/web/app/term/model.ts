// What the terminal shows, derived from the API bodies without React: which duel is live, the event feed, and the
// flat field map whose changes between two polls make cells flash. bun test covers it (app/__tests__/term.test.ts).
import type { Attack, Score, Side } from "../lib/fool";

export type Intent = { agent_pk: string; side: Side; size_bps: number; nonce: string; proof_hash: string };
export type Injection = { kind: string; payload_hash: string; target: string; block: string };
export type Duel = {
  id: string;
  a: string;
  b: string;
  symbol: string;
  open_at?: string | null;
  close_at: string;
  pool: string;
  injections: Injection[];
  resolved: boolean;
  last_intent_a: Intent | null;
  last_intent_b: Intent | null;
  outcome?: {
    open_price?: string;
    close_price?: string;
    pnl_a: number;
    pnl_b: number;
    winner: string | null;
    injections?: number;
  } | null;
  open_price?: string | null;
};
export type Agent = { pk: string; model_id: string; tee: boolean; in_duel: string | number | null };
/** The slice of GET /api/arena the terminal reads. */
export type Snap = {
  at: number;
  contract: string;
  config: { next_duel: string; min_chaos_deposit: string; commit_reveal?: boolean };
  leaderboard: Agent[];
  duels: (Duel | null)[];
  solver: null | { pending?: Record<string, { kind: string; payload: string; payload_hash?: string }[]> };
};
/** GET /api/board. */
export type Board = { source: string; rows: number; models: Score[]; recent: Attack[] };
/** GET /api/duel, normalised to what pane 2 needs. */
export type DuelRec = { duel: Duel | null; a: Agent | null; b: Agent | null };
/** An attack this browser signed, kept for the session; `before` is the target's call nonce when it was signed. */
export type Mine = {
  tx: string;
  duel: string;
  target: string;
  text: string;
  hash: string;
  before: string | null;
  at: number;
};

/** Headlines by payload_hash from the solver's pending list. The solver drops an injection from it once the runner has
 *  read it, so the page keeps every text it has seen (see Term) instead of losing it the moment the model sees it. */
export const textsOf = (s: Snap | null): Record<string, string> =>
  Object.fromEntries(
    Object.values(s?.solver?.pending ?? {}).flatMap((l) =>
      l.flatMap((p) => (p.payload_hash ? [[p.payload_hash, p.payload]] : [])),
    ),
  );

const nsToMs = (ns: string) => Number(BigInt(ns) / 1_000_000n);
/** "z-ai/glm-5.3-flash" -> "glm-5.3-flash". */
export const shortModel = (id: string | null | undefined) => (id ? (id.split("/").pop() ?? id) : "?");

/** The duel pane 2 follows: one taking calls now, else one closed and awaiting its oracle, else the newest. */
export function pickLive(duels: (Duel | null)[] | undefined, nowMs: number): Duel | null {
  const list = (duels ?? []).filter((d): d is Duel => !!d);
  return (
    list.find((d) => !d.resolved && nsToMs(d.close_at) > nowMs) ?? list.find((d) => !d.resolved) ?? list[0] ?? null
  );
}

export type FeedItem = {
  key: string;
  duel: string;
  model: string;
  /** The headline when known: the solver's pending payload, the dataset row, or what this browser sent. */
  lie: string | null;
  hash: string | null;
  pushed: Side | null;
  /** The model's call after the lie (null until one is known to be newer), and its words when the dataset has them. */
  after: Side | null;
  reply: string | null;
  /** answered: a call newer than this browser's attack landed; whether it took the bait needs the lie's side. */
  verdict: "fooled" | "held" | "untested" | "waiting" | "answered";
  tx: string | null;
  mine: boolean;
};

/** Newest first: this browser's own attacks, then the other attacks on open duels (on chain now), then the dataset's.
 *  `texts` maps payload_hash to headline for attacks whose text this page has seen. */
export function feed(s: Snap | null, b: Board | null, mine: Mine[], texts: Record<string, string> = {}): FeedItem[] {
  const ownHashes = new Set(mine.map((m) => `${m.duel}:${m.hash}`));
  const model = (pk: string) => {
    const id = s?.leaderboard.find((a) => a.pk === pk)?.model_id;
    return id ? shortModel(id) : pk.slice(0, 8);
  };
  const intentOf = (d: Duel | undefined, pk: string) =>
    (d && (pk === d.a ? d.last_intent_a : pk === d.b ? d.last_intent_b : null)) ?? null;
  const duels = (s?.duels ?? []).filter((d): d is Duel => !!d);
  const own: FeedItem[] = [...mine].reverse().map((m) => {
    const it = intentOf(
      duels.find((d) => d.id === m.duel),
      m.target,
    );
    const newer = !!it && it.nonce !== m.before; // the call on chain when it was signed came before the lie
    return {
      key: `mine:${m.tx}`,
      duel: m.duel,
      model: model(m.target),
      lie: m.text,
      hash: m.hash,
      pushed: null,
      after: newer ? (it?.side ?? null) : null,
      reply: null,
      verdict: newer ? "answered" : "waiting",
      tx: m.tx,
      mine: true,
    };
  });
  const live: FeedItem[] = duels
    .filter((d) => !d.resolved)
    .flatMap((d) =>
      d.injections.flatMap((j, i) =>
        ownHashes.has(`${d.id}:${j.payload_hash}`)
          ? [] // already listed as this browser's own
          : [
              {
                key: `chain:${d.id}:${i}`,
                duel: d.id,
                model: model(j.target),
                lie: texts[j.payload_hash] ?? textsOf(s)[j.payload_hash] ?? null,
                hash: j.payload_hash,
                pushed: null,
                after: null, // the duel's last call may predate this attack: no block time to tell

                reply: null,
                verdict: "waiting" as const,
                tx: null,
                mine: false,
              },
            ],
      ),
    )
    .reverse();
  const past: FeedItem[] = (b?.recent ?? []).map((a) => ({
    key: `data:${a.duel_id}:${a.agent_pk}:${a.text.slice(0, 24)}`,
    duel: a.duel_id,
    model: shortModel(a.model),
    lie: a.text,
    hash: null,
    pushed: a.pushed,
    after: a.after,
    reply: a.reply,
    verdict: a.verdict,
    tx: a.tx,
    mine: false,
  }));
  return [...own, ...live, ...past];
}

/** Every value a cell shows, by a stable key; two polls' maps differ exactly where cells must flash. */
export function fields(s: Snap | null, b: Board | null, d: Duel | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of b?.models ?? []) out[`board:${m.model}`] = `${m.fooled}/${m.tested}`;
  if (d) {
    out[`duel:${d.id}:a`] = d.last_intent_a ? `${d.last_intent_a.side}:${d.last_intent_a.size_bps}` : "";
    out[`duel:${d.id}:b`] = d.last_intent_b ? `${d.last_intent_b.side}:${d.last_intent_b.size_bps}` : "";
    out[`duel:${d.id}:pot`] = d.pool;
    out[`duel:${d.id}:attacks`] = String(d.injections.length);
    out[`duel:${d.id}:state`] = d.resolved ? "resolved" : "open";
  }
  if (s) out.price = s.config.min_chaos_deposit;
  return out;
}

/** Keys whose value changed between two field maps; a key that only appears in `next` is new, not changed. */
export const changed = (prev: Record<string, string>, next: Record<string, string>): string[] =>
  Object.keys(next).filter((k) => k in prev && prev[k] !== next[k]);
