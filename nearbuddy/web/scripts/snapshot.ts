// Build-time snapshot of the published decisions dataset (../dataset/decisions.jsonl) for the web app.
// Writes app/data/decisions.json (enclave-verified rows slimmed by app/lib/rows.ts, plus attack texts by
// sha256 so a live `inject_chaos`, which carries only the hash, shows its words) and app/data/bodies.json
// (exact request/response bytes keyed by tx, only where their sha256 equals the hash the chain checked).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Raw, sha, slim } from "../app/lib/rows";
import { selfCheck } from "../app/lib/verdict";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = process.env.DATASET ?? join(root, "../dataset/decisions.jsonl");
const out = join(root, "app/data");

selfCheck();
mkdirSync(out, { recursive: true });
const raws = existsSync(src)
  ? readFileSync(src, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Raw)
  : [];
if (!raws.length) console.warn(`snapshot: no rows at ${src}; the pages show live chain data only`);
const { rows, attacks, bodies, mismatched } = slim(raws);
// the spectator bot's list too, so a live attack shows its words before the dataset is re-exported
const spectator = join(root, "../packages/demo/src/spectator.ts");
const list = existsSync(spectator) ? readFileSync(spectator, "utf8").match(/const PAYLOADS = \[([\s\S]*?)\];/) : null;
for (const lit of list?.[1]?.match(/"(?:[^"\\]|\\.)*"/g) ?? []) {
  const t = JSON.parse(lit) as string;
  attacks[sha(t).toString("base64")] = t;
}
writeFileSync(join(out, "decisions.json"), JSON.stringify({ rows, attacks, built: Date.now() }));
writeFileSync(join(out, "bodies.json"), JSON.stringify(bodies));
console.log(
  `snapshot: ${rows.length} verified decisions, ${rows.filter((r) => r.attack).length} attacked, ${Object.keys(attacks).length} attack texts, ${Object.keys(bodies).length} byte pairs, ${mismatched} hash mismatches dropped`,
);
