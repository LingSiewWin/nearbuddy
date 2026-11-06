// One decisions-dataset row (the runner's decisions.jsonl format) slimmed for the web: the model's call, its
// own reasoning, the attack it was shown and a plain verdict. Used by scripts/snapshot.ts at build time and
// by the optional live tail in app/api/dataset.ts, so both produce the same rows.
import { createHash } from "node:crypto";
import { pushedSide, reasoning, type Side, type Verdict, verdict } from "./verdict";

export type Raw = {
  duel_id: string;
  agent_pk: string;
  model: string;
  hardened?: boolean;
  prompt_variant?: string | null;
  brief: string;
  injection: string | null;
  text: string | null;
  request_body?: string;
  response_body?: string;
  tee?: { kind?: number; request_hash: string; response_hash: string };
  intent?: { side: Side; size_bps: number; nonce: string };
  tx: string | null;
  verifiable?: boolean | string; // set by the exporter after re-verifying; absent in the runner's own file
};
export type Decision = {
  duel: string;
  agent: string;
  model: string;
  arm: string;
  side: Side;
  size: number;
  nonce: string;
  reason: string;
  brief: string;
  attack: string | null;
  pushed: Side | null;
  verdict: Verdict | null;
  tx: string | null;
};
export type Bytes = { req: string; res: string; reqHash: string; resHash: string };

export const sha = (s: string) => createHash("sha256").update(s).digest();
const hex = (b64: string | undefined) => (b64 ? Buffer.from(b64, "base64").toString("hex") : null);

/** Slims rows in file order; `last` carries each agent's previous side per duel across calls. */
export function slim(raws: Raw[], last = new Map<string, Side>()) {
  const rows: Decision[] = [];
  const attacks: Record<string, string> = {};
  const bodies: Record<string, Bytes> = {};
  let mismatched = 0;
  for (const r of raws) {
    if (r.injection) attacks[sha(r.injection).toString("base64")] = r.injection;
    if (!r.intent) continue; // a post that never landed
    const key = `${r.duel_id}:${r.agent_pk}`;
    const prev = last.get(key) ?? null;
    last.set(key, r.intent.side);
    // exported rows were re-verified; a runner row counts once its enclave-proved intent landed on chain
    const ok =
      r.verifiable === undefined ? r.tee?.kind === 2 && !!r.tx : r.verifiable === true || r.verifiable === "True";
    if (!ok) continue;
    const pushed = r.injection ? pushedSide(r.injection, prev) : null;
    rows.push({
      duel: r.duel_id,
      agent: r.agent_pk,
      model: r.model,
      arm: r.prompt_variant ?? (r.hardened ? "hardened" : "naive"),
      side: r.intent.side,
      size: r.intent.size_bps,
      nonce: r.intent.nonce, // runner start (ms) plus a counter: an order, not a time; the tx carries the time
      reason: reasoning(r.text),
      brief: r.brief,
      attack: r.injection,
      pushed,
      verdict: r.injection ? verdict(r.text, r.intent.side, pushed) : null,
      tx: r.tx,
    });
    // only bytes whose sha256 equals the hash the chain checked are published for in-browser verification
    const resHash = hex(r.tee?.response_hash);
    const reqHash = hex(r.tee?.request_hash);
    if (r.tx && r.request_body && r.response_body && resHash && reqHash) {
      if (sha(r.response_body).toString("hex") === resHash && sha(r.request_body).toString("hex") === reqHash)
        bodies[r.tx] = { req: r.request_body, res: r.response_body, reqHash, resHash };
      else mismatched++;
    }
  }
  return { rows, attacks, bodies, mismatched };
}
