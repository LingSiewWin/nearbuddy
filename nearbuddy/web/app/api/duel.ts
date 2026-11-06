// One duel read from the arena contract on the public RPC: the duel record plus both agents' views, the
// config (commit-reveal fields when the contract has them) and get_no_reveal (null before commit-reveal).
// Cached 20 s per id; pollers share one in-flight read, and a stale record beats an error while the RPC
// is throttled.
import type { Agent, Duel } from "./arena";
import { ARENA, RPC, viewOn } from "./near";

const ORACLE = process.env.ORACLE_ACCOUNT ?? "price-oracle.testnet";
const TTL = 20_000;
const view = viewOn(ARENA);
export const ID_RE = /^\d{1,12}$/;

export type DuelRecord = {
  at: number;
  rpc: string;
  contract: string;
  oracle: string;
  config: unknown;
  no_reveal: unknown;
  duel: Duel | null;
  a: Agent | null;
  b: Agent | null;
};

const cache = new Map<string, { at: number; rec: DuelRecord }>();
const inflight = new Map<string, Promise<DuelRecord>>();

async function build(id: string): Promise<DuelRecord> {
  const [duel, config, no_reveal] = await Promise.all([
    view("get_duel", { duel_id: id }) as Promise<Duel | null>,
    view("get_config", {}),
    view("get_no_reveal", { duel_id: id }).catch(() => null), // view missing before commit-reveal
  ]);
  const [a, b] = duel
    ? ((await Promise.all([view("get_agent", { agent_pk: duel.a }), view("get_agent", { agent_pk: duel.b })])) as [
        Agent | null,
        Agent | null,
      ])
    : [null, null];
  return { at: Date.now(), rpc: RPC, contract: ARENA, oracle: ORACLE, config, no_reveal, duel, a, b };
}

/** The raw record (contract units) for an id already checked against ID_RE. */
export async function duelRecord(id: string): Promise<DuelRecord> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.rec;
  let p = inflight.get(id);
  if (!p) {
    p = build(id)
      .then((rec) => {
        cache.set(id, { at: rec.at, rec });
        if (cache.size > 200) cache.delete(cache.keys().next().value as string);
        return rec;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  try {
    return await p;
  } catch (e) {
    if (hit) return hit.rec;
    throw e;
  }
}
