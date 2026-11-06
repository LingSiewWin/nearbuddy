// Build-time snapshot of the published decisions dataset (../dataset/decisions.jsonl) for the web app.
// Writes app/data/decisions.json (enclave-verified rows slimmed by app/lib/rows.ts, plus attack texts by
// sha256 so a live `inject_chaos`, which carries only the hash, shows its words) and app/data/bodies.json
// (exact request/response bytes keyed by tx, only where their sha256 equals the hash the chain checked).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Raw, sha, slim } from "../app/lib/rows";
import { selfCheck } from "../app/lib/verdict";
import { networkFile } from "../app/network";

const root = fileURLToPath(new URL("..", import.meta.url));
// dataset/ on testnet, dataset-mainnet/ on mainnet (agents/export_dataset.py), so tx hashes match the explorer
const src = process.env.DATASET ?? join(root, `../${networkFile("dataset")}/decisions.jsonl`);
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
// the spectator bot's lists too, so a live attack shows its words before the dataset is re-exported: every
// top-level `const NAME = [ "..." | '...', ... ];` in spectator.ts (PAYLOADS before the holdout split, TRAIN
// and HOLDOUT after it), the same lists analysis/experiment_report.py reads
const spectator = process.env.SPECTATOR ?? join(root, "../packages/demo/src/spectator.ts");
const lists = existsSync(spectator) ? readFileSync(spectator, "utf8") : "";
let texts = 0;
for (const [, body] of lists.matchAll(/^const [A-Z_]+ = \[([\s\S]*?)\n\];/gm)) {
  const code = body!.replace(/^\s*\/\/.*$/gm, ""); // a comment's apostrophe would open a bogus literal
  for (const [, dq, sq] of code.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
    const t = JSON.parse(`"${dq ?? sq!.replace(/\\'/g, "'").replace(/\\?"/g, '\\"')}"`) as string;
    attacks[sha(t).toString("base64")] = t;
    texts++;
  }
}
if (lists && !texts) console.warn(`snapshot: no attack lists found in ${spectator}; live attacks show only a hash`);
writeFileSync(join(out, "decisions.json"), JSON.stringify({ rows, attacks, built: Date.now() }));
writeFileSync(join(out, "bodies.json"), JSON.stringify(bodies));
console.log(
  `snapshot: ${rows.length} verified decisions, ${rows.filter((r) => r.attack).length} attacked, ${Object.keys(attacks).length} attack texts (${texts} from the spectator), ${Object.keys(bodies).length} byte pairs, ${mismatched} hash mismatches dropped`,
);
