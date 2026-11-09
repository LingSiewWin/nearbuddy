// Server side of the share card: a planted headline's tx from FastNEAR's tx API, the target's model from the arena,
// and the dataset's verdict for that attack when the dataset already holds it. A landed tx never changes, so it is
// kept per process; a miss (not indexed yet, or FastNEAR down) is retried on the next request.
import board from "../data/board.json";
import { type Planted, plantedOf, sameText, type TxBody } from "../lib/card";
import { NET } from "../network";
import { ARENA, arenaView } from "./near";

const TX_API = process.env.FASTNEAR_TX_API ?? NET.txApi;
const seen = new Map<string, Planted>(); // ponytail: one process, a few hundred bytes a card; evicts past 500

export type Card = {
  planted: Planted | null;
  model: string | null;
  /** The share link's headline, only when its sha256 is the one on chain. */
  text: string | null;
  verdict: "fooled" | "held" | "untested" | null;
};

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
    if (p) {
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
  if (!planted) return { planted: null, model: null, text: null, verdict: null };
  const model = await arenaView("get_agent", { agent_pk: planted.target })
    .then((a) => a?.model_id ?? null)
    .catch(() => null);
  const shown = sameText(text, planted.payload_hash) ? text : null;
  const row = shown
    ? board.recent.find((a) => a.duel_id === planted.duel_id && a.agent_pk === planted.target && a.text === shown)
    : undefined;
  return { planted, model, text: shown, verdict: (row?.verdict as Card["verdict"]) ?? null };
}
