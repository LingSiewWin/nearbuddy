// Server side of the share card: a planted headline's tx from FastNEAR's tx API, the target's model from the arena,
// and the verdict: on deploy 17 the outcome of its get_chaos record, read each time (it is decided after the tx);
// on deploy 16 the dataset's verdict for that attack when the dataset already holds it. A landed tx never changes, so
// it is kept per process; a miss (not indexed yet, or FastNEAR down) is retried on the next request.
import board from "../data/board.json";
import type { Arm, Chaos, ChaosOutcome } from "../lib/abi/arena";
import { type Planted, plantedOf, shownText, type TxBody } from "../lib/card";
import { NET } from "../network";
import { ARENA, arenaView } from "./near";

const TX_API = process.env.FASTNEAR_TX_API ?? NET.txApi;
const seen = new Map<string, Planted>(); // ponytail: one process, a few hundred bytes a card; evicts past 500

export type Card = {
  planted: Planted | null;
  model: string | null;
  /** The headline (lib/card.ts shownText): never from a refused call; on deploy 17 the chain's record, on 16 the
   *  share link's when its sha256 is the one on chain. */
  text: string | null;
  verdict: "fooled" | "held" | "untested" | "expired" | null;
  /** Deploy 17: how it was delivered, and the nonce of the proved call that decided it. */
  arm: Arm | null;
  decided_by: string | null;
};

const VERDICT: Record<ChaosOutcome, Card["verdict"]> = {
  Pending: null,
  Flipped: "fooled",
  Held: "held",
  NoTrial: "untested",
  Expired: "expired",
};

/** Deploy 17: the record the tx created, from get_chaos at the index the call returned, when it is that tx's. */
async function recordOf(p: Planted): Promise<Chaos | null> {
  if (!p.landed || p.index === null) return null;
  const c = await arenaView("get_chaos", { duel_id: p.duel_id })
    .then((l) => l[p.index ?? -1] ?? null)
    .catch(() => null);
  return c && c.injector === p.signer && c.target === p.target && c.headline === p.headline ? c : null;
}

async function lookup(tx: string): Promise<Planted | null> {
  const hit = seen.get(tx);
  if (hit) return hit;
  try {
    const r = await fetch(`${TX_API}/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx_hashes: [tx] }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const { transactions } = (await r.json()) as { transactions: TxBody[] };
    const p = transactions[0] ? plantedOf(transactions[0], ARENA) : null;
    if (p?.at_ms) {
      // only once its arena receipt is indexed: before that, landed and the time are unknown
      seen.set(tx, p);
      if (seen.size > 500) seen.delete(seen.keys().next().value as string);
    }
    return p;
  } catch {
    return null;
  }
}

export async function card(tx: string, text: string | null): Promise<Card> {
  const planted = await lookup(tx);
  if (!planted) return { planted: null, model: null, text: null, verdict: null, arm: null, decided_by: null };
  const [model, rec] = await Promise.all([
    arenaView("get_agent", { agent_pk: planted.target })
      .then((a) => a?.model_id ?? null)
      .catch(() => null),
    recordOf(planted),
  ]);
  const shown = shownText(planted, text, rec);
  if (planted.headline !== null) {
    // deploy 17: headline and outcome from the chain's record
    const verdict = rec ? VERDICT[rec.outcome] : null;
    return { planted, model, text: shown, verdict, arm: rec?.arm ?? null, decided_by: rec?.decided_by ?? null };
  }
  const row = shown
    ? board.recent.find((a) => a.duel_id === planted.duel_id && a.agent_pk === planted.target && a.text === shown)
    : undefined;
  return {
    planted,
    model,
    text: shown,
    verdict: (row?.verdict as Card["verdict"]) ?? null,
    arm: null,
    decided_by: null,
  };
}
