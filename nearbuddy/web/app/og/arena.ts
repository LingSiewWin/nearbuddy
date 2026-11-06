// The arena share card, built live: the headline from the published record of paid lies (the same grouping
// as the arena's "Who falls for fake news" squares: model family and prompt), the foot from the chain's live
// duel. The record is a local file and the chain may be slow or down, so the chain gets a short deadline
// and every part has a static stand-in: the card always renders.
import { type Agent, type Config, type Duel, type Summary, summary } from "../api/arena";
import { type Decision, getDecisions } from "../api/dataset";
import { ARENA, RPC, viewOn } from "../api/near";
import { pct, promptName, who } from "../ui/format";
import type { Card, Mark, Span } from "./card";
import { toneOf } from "./card";

const CHAIN_MS = 3_500;
const MIN_LIES = 5; // a group needs this many attacks before the card quotes it
const view = viewOn(ARENA);

type Group = { model: string; arm: string; rows: Decision[]; fell: number; resisted: number };

/** Attacked decisions grouped by model family and prompt, oldest attack first within each group. */
export function groups(decisions: Decision[]): Group[] {
  const by = new Map<string, Group>();
  for (const d of decisions) {
    if (!d.attack) continue;
    const k = `${who(d.model)}|${d.arm}`;
    const g = by.get(k) ?? { model: d.model, arm: d.arm, rows: [], fell: 0, resisted: 0 };
    g.rows.push(d);
    if (d.verdict === "fell") g.fell++;
    if (d.verdict === "resisted") g.resisted++;
    by.set(k, g);
  }
  return [...by.values()];
}

/** The most fooled group and the most guarded one, preferring two different model families. */
export function contrast(gs: Group[]): { fooled: Group | null; guarded: Group | null } {
  const big = gs.filter((g) => g.rows.length >= MIN_LIES);
  const best = (score: (g: Group) => number, pool: Group[]) =>
    [...pool].sort((x, y) => score(y) - score(x) || y.rows.length - x.rows.length)[0] ?? null;
  const fooled = best(
    (g) => g.fell / g.rows.length,
    big.filter((g) => g.fell > 0),
  );
  const rest = big.filter((g) => g !== fooled && g.resisted > 0);
  const other = rest.filter((g) => who(g.model) !== who(fooled?.model));
  const guarded = best((g) => g.resisted / g.rows.length, other.length ? other : rest);
  return { fooled, guarded };
}

const name = (model: string): Span => ({ t: who(model), tone: toneOf(model) });
const marks = (g: Group): Mark[] => g.rows.map((d) => d.verdict ?? "unmoved");
const label = (g: Group): Span[] => [name(g.model), `· ${promptName(g.arm)}`];

/** The live duel in one line, else the last result. */
export function duelLine(s: Summary): Span[] {
  if (s.live) {
    const l = s.live;
    const call = (x: typeof l.a) => [name(x.model), `${x.side ? x.side.toLowerCase() : "deciding"},`];
    const left = `${Math.floor(l.seconds_left / 60)}:${String(l.seconds_left % 60).padStart(2, "0")} left`;
    return [`Duel ${l.duel} live:`, ...call(l.a), ...call(l.b), left];
  }
  const r = s.recent[0];
  if (!r) return ["Five-minute duels on NEAR testnet"];
  const [w, l] = r.winner === r.b.agent ? [r.b, r.a] : [r.a, r.b];
  return r.winner
    ? [`Duel ${r.duel}:`, name(w.model), "beat", name(l.model), `${pct(w.return_pct)} to ${pct(l.return_pct)}`]
    : [`Duel ${r.duel}:`, name(r.a.model), "and", name(r.b.model), "drew"];
}

export const FALLBACK = {
  title: [["AI models trade NEAR."], ["Anyone can pay to feed one a lie."]],
  sub: ["The record shows who falls for it, in its own words."],
  foot: ["Five-minute duels on NEAR testnet"],
} satisfies Card;

/** The newest duel in the v1 shape: two round trips, not the arena page's full scan, because a crawler
 * usually lands on a cold function and waits only seconds. */
async function read(): Promise<Summary> {
  const config = (await view("get_config", {})) as Config;
  const n = Number(config.next_duel);
  const [leaderboard, duel] = await Promise.all([
    view("leaderboard", {}) as Promise<Agent[]>,
    n ? (view("get_duel", { duel_id: String(n - 1) }) as Promise<Duel | null>) : null,
  ]);
  const duels = duel ? [duel] : [];
  return summary({ at: Date.now(), rpc: RPC, contract: ARENA, config, leaderboard, duels, solver: null });
}
// kept for 20 s and shared by concurrent cards; a read that misses one card's deadline still serves the next
let last: { at: number; s: Promise<Summary> } | null = null;
function newest(): Promise<Summary> {
  if (!last || Date.now() - last.at > 20_000) {
    const s = read();
    last = { at: Date.now(), s };
    s.catch(() => {
      if (last?.s === s) last = null;
    });
  }
  return last.s;
}

export async function arenaCard(): Promise<Card> {
  const chain = Promise.race([newest(), new Promise<null>((ok) => setTimeout(() => ok(null), CHAIN_MS))]).catch(
    () => null,
  );
  const [decisions, s] = await Promise.all([getDecisions().catch(() => []), chain]);
  const live = s ? { foot: duelLine(s), note: `${s.duels_total} duels on NEAR testnet` } : {};
  const { fooled, guarded } = contrast(groups(decisions));
  if (!fooled && !guarded) return { ...FALLBACK, ...live };
  const title: Span[][] = [];
  const rows: NonNullable<Card["rows"]> = [];
  if (fooled) {
    title.push([name(fooled.model), `fell for ${fooled.fell} of ${fooled.rows.length} paid lies.`]);
    rows.push({ label: label(fooled), marks: marks(fooled) });
  }
  if (guarded) {
    title.push([name(guarded.model), `saw through ${guarded.resisted} of ${guarded.rows.length}.`]);
    rows.push({ label: label(guarded), marks: marks(guarded) });
  }
  const cost = s ? `${s.rules.attack_cost_near} NEAR` : "a little NEAR";
  return {
    title,
    sub: [`Anyone can pay ${cost} to feed an AI trader a fake headline.`],
    rows,
    foot: FALLBACK.foot,
    ...live,
  };
}
