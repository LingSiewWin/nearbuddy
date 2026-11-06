// Build-time snapshot of the published decisions dataset (../dataset/decisions.jsonl) for the web app.
// Writes app/data/decisions.json (enclave-verified rows, slimmed: the model's call, its own reasoning, the
// attack it was shown and a plain verdict) and app/data/bodies.json (exact request/response bytes keyed by
// tx, only where their sha256 equals the hash the chain checked, so a browser can re-hash them).
// Attack texts are indexed by sha256 so a live `inject_chaos` (which carries only the hash) shows its words.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Decision } from "../app/api/dataset";
import { pushedSide, reasoning, type Side, selfCheck, verdict } from "../app/lib/verdict";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = process.env.DATASET ?? join(root, "../dataset/decisions.jsonl");
const out = join(root, "app/data");

type Raw = {
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
  tee?: { request_hash: string; response_hash: string };
  intent?: { side: Side; size_bps: number; nonce: string };
  tx: string | null;
  verifiable: boolean;
};

const sha = (s: string) => createHash("sha256").update(s).digest();
const hex = (b64: string | undefined) => (b64 ? Buffer.from(b64, "base64").toString("hex") : null);

selfCheck();
mkdirSync(out, { recursive: true });
const raws = existsSync(src)
  ? readFileSync(src, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Raw)
  : [];
if (!raws.length) console.warn(`snapshot: no rows at ${src}; the pages show live chain data only`);

const attacks: Record<string, string> = {};
for (const r of raws) if (r.injection) attacks[sha(r.injection).toString("base64")] = r.injection;
// the spectator bot's list too, so a live attack shows its words before the dataset is re-exported
const spectator = join(root, "../packages/demo/src/spectator.ts");
const list = existsSync(spectator) ? readFileSync(spectator, "utf8").match(/const PAYLOADS = \[([\s\S]*?)\];/) : null;
for (const lit of list?.[1]?.match(/"(?:[^"\\]|\\.)*"/g) ?? []) {
  const t = JSON.parse(lit) as string;
  attacks[sha(t).toString("base64")] = t;
}

const last = new Map<string, Side>(); // `${duel}:${agent}` -> previous side, for "Reverse your call"
const rows: Decision[] = [];
const bodies: Record<string, { req: string; res: string; reqHash: string; resHash: string }> = {};
let mismatched = 0;
for (const r of raws) {
  if (!r.intent) continue; // a post that never landed
  const key = `${r.duel_id}:${r.agent_pk}`;
  const prev = last.get(key) ?? null;
  last.set(key, r.intent.side);
  if (!r.verifiable) continue;
  const pushed = r.injection ? pushedSide(r.injection, prev) : null;
  rows.push({
    duel: r.duel_id,
    agent: r.agent_pk,
    model: r.model,
    arm: r.prompt_variant ?? (r.hardened ? "hardened" : "naive"),
    side: r.intent.side,
    size: r.intent.size_bps,
    at: Number(r.intent.nonce), // the runner's nonce is the decision time in ms
    reason: reasoning(r.text),
    brief: r.brief,
    attack: r.injection,
    pushed,
    verdict: r.injection ? verdict(r.text, r.intent.side, pushed) : null,
    tx: r.tx,
  });
  const resHash = hex(r.tee?.response_hash);
  const reqHash = hex(r.tee?.request_hash);
  if (r.tx && r.request_body && r.response_body && resHash && reqHash) {
    if (sha(r.response_body).toString("hex") === resHash && sha(r.request_body).toString("hex") === reqHash)
      bodies[r.tx] = { req: r.request_body, res: r.response_body, reqHash, resHash };
    else mismatched++;
  }
}
writeFileSync(join(out, "decisions.json"), JSON.stringify({ rows, attacks, built: Date.now() }));
writeFileSync(join(out, "bodies.json"), JSON.stringify(bodies));
console.log(
  `snapshot: ${rows.length} verified decisions, ${rows.filter((r) => r.attack).length} attacked, ${Object.keys(attacks).length} attack texts, ${Object.keys(bodies).length} byte pairs, ${mismatched} hash mismatches dropped`,
);
