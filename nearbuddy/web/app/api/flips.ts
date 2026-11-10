// What GET /api/flips serves, built from plain inputs so bun test covers it without an RPC: the attacks a model
// already answered (the replay pane shows them when no duel is live) and the saboteurs board (injectors ranked by
// Flipped, with what the contract paid them). Chain records (deploy 17 `get_chaos`) carry stake and payout; the
// dataset's attacks carry the model's own words. Only finished duels count: their records no longer change.
import type { Arm, Chaos } from "../lib/abi/arena";
import type { Attack, Side } from "../lib/fool";

/** One answered attack: headline, the model's reply (words when the dataset has them, else its next call), verdict,
 *  and on chain what the injector staked and was paid. */
export type Flip = {
  duel: string;
  /** The record's place in the duel's `get_chaos`; null for a dataset attack. (duel, index) names it uniquely. */
  index: number | null;
  model: string;
  target: string;
  headline: string;
  pushed: Side | null;
  arm: Arm | null;
  before: Side | null;
  after: Side | null;
  reply: string | null;
  verdict: "fooled" | "held";
  injector: string | null;
  stake: string | null;
  payout: string | null;
  tx: string | null;
};
export type Saboteur = {
  account: string;
  flipped: number;
  held: number;
  attacks: number;
  /** yoctoNEAR staked over every attack, and paid back by the contract (stake less fee, plus slash shares). */
  staked: string;
  paid: string;
};
/** A finished duel's chaos records, newest duel first. */
export type DuelChaos = { duel: string; records: Chaos[] };

const DECIDED: Partial<Record<Chaos["outcome"], Flip["verdict"]>> = { Flipped: "fooled", Held: "held" };

/** Newest first: up to `n` decided chain records, then up to `n` dataset attacks of duels the chain has no records for
 *  (a duel with records is told by them, never twice from text that may differ). */
export function replay(chain: DuelChaos[], recent: Attack[], modelOf: (pk: string) => string | null, n = 5): Flip[] {
  const fromChain: Flip[] = chain
    .flatMap(({ duel, records }) =>
      records
        .flatMap((c, index): Flip[] => {
          const verdict = DECIDED[c.outcome];
          if (!verdict) return [];
          return [
            {
              duel,
              index,
              model: modelOf(c.target) ?? c.target.slice(0, 8),
              target: c.target,
              headline: c.headline,
              pushed: c.kind === "Placebo" ? null : c.kind,
              arm: c.arm,
              before: c.prev,
              after: c.next,
              reply: null,
              verdict,
              injector: c.injector,
              stake: c.stake,
              payout: c.payout,
              tx: null,
            },
          ];
        })
        .reverse(),
    )
    .slice(0, n);
  const onChain = new Set(chain.map((c) => c.duel));
  const fromData: Flip[] = recent
    .filter((a) => (a.verdict === "fooled" || a.verdict === "held") && !onChain.has(a.duel_id))
    .slice(0, n)
    .map((a) => ({
      duel: a.duel_id,
      index: null,
      model: a.model,
      target: a.agent_pk,
      headline: a.text,
      pushed: a.pushed,
      arm: null,
      before: a.before,
      after: a.after,
      reply: a.reply || null,
      verdict: a.verdict as Flip["verdict"],
      injector: null,
      stake: null,
      payout: null,
      tx: a.tx,
    }));
  return [...fromChain, ...fromData];
}

/** Every injector in `chain`, ranked by Flipped, then what it was paid, then attacks; the placebo arm (the owner's
 *  control headlines) is left out: nobody chose it to fool a model. */
export function saboteurs(chain: DuelChaos[]): Saboteur[] {
  const by = new Map<string, { flipped: number; held: number; attacks: number; staked: bigint; paid: bigint }>();
  for (const { records } of chain)
    for (const c of records) {
      if (c.kind === "Placebo") continue;
      const s = by.get(c.injector) ?? { flipped: 0, held: 0, attacks: 0, staked: 0n, paid: 0n };
      s.attacks++;
      if (c.outcome === "Flipped") s.flipped++;
      if (c.outcome === "Held") s.held++;
      s.staked += BigInt(c.stake);
      s.paid += BigInt(c.payout);
      by.set(c.injector, s);
    }
  return [...by.entries()]
    .map(([account, s]) => ({ account, ...s, staked: s.staked.toString(), paid: s.paid.toString() }))
    .sort(
      (x, y) =>
        y.flipped - x.flipped ||
        (BigInt(y.paid) > BigInt(x.paid) ? 1 : BigInt(y.paid) < BigInt(x.paid) ? -1 : 0) ||
        y.attacks - x.attacks ||
        x.account.localeCompare(y.account),
    );
}

/** GET /api/flips' cache. A body built from the chain is served for `ttl`. One built while the chain was unreadable
 *  (`ok` false) is never kept as good: the last good body is served instead (else that one), and no rebuild starts
 *  for `negTtl`, so a dead RPC is asked once per `negTtl`, not once per request. One build runs at a time. */
export function flipsCache(
  build: () => Promise<{ body: string; ok: boolean }>,
  ttl = 60_000,
  negTtl = 10_000,
  now: () => number = Date.now,
): () => Promise<string> {
  let good: { at: number; body: string } | null = null;
  let failed: { at: number; body: string } | null = null;
  let inflight: Promise<string> | null = null;
  return async () => {
    const t = now();
    if (good && t - good.at < ttl) return good.body;
    if (failed && t - failed.at < negTtl) return good?.body ?? failed.body;
    inflight ??= build()
      .then(({ body, ok }) => {
        if (ok) {
          good = { at: now(), body };
          failed = null;
          return body;
        }
        failed = { at: now(), body };
        return good?.body ?? body;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
