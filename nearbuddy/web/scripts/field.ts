// The decision field's data: `bun scripts/field.ts` rewrites app/data/field.json from the published decisions
// dataset, one character per recorded decision, grouped by duel and agent. The attack verdicts are the board's own
// (lib/fool.ts attacksOf), so the field and the scoreboard cannot disagree. app/__tests__/ui-field.test.ts fails
// when the file no longer matches ../dataset/decisions.jsonl: re-run this after every dataset export.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isStubModel } from "../app/cells";
import { pushedSide } from "../app/lib/against";
import { attacksOf, type Row } from "../app/lib/fool";
import type { FieldData } from "../app/ui/field";

const DATASET = fileURLToPath(new URL("../../dataset/decisions.jsonl", import.meta.url));
export const OUT = fileURLToPath(new URL("../app/data/field.json", import.meta.url));
const big = (s: string | undefined) => {
  try {
    return BigInt(s ?? "0");
  } catch {
    return 0n;
  }
};

/** One character per row: `.` a decision with no headline in view; `:` a headline was in view; `f` the first
 *  decision after a new headline, fooled; `h` the same, held; `n` the same, did not count; `-` no decision posted. */
export function build(path = DATASET): FieldData {
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l, i) => ({ ...(JSON.parse(l) as Row), i }));
  // the same order attacksOf reads in, so its attacks line up with the rows that saw a new headline first
  const decided = rows
    .filter((r) => !!r.intent?.side && !isStubModel(r.model))
    .sort((x, y) => {
      const [dx, dy] = [big(x.duel_id), big(y.duel_id)];
      const [nx, ny] = [big(x.intent?.nonce), big(y.intent?.nonce)];
      return dx < dy ? -1 : dx > dy ? 1 : nx < ny ? -1 : nx > ny ? 1 : 0;
    });
  const attacks = attacksOf(rows, pushedSide);
  const mark = new Map<number, string>();
  const seen = new Map<string, Set<string>>();
  let next = 0;
  for (const r of decided) {
    const key = `${r.duel_id}:${r.agent_pk}`;
    const old = seen.get(key) ?? new Set<string>();
    const fresh = (r.injection ?? "").split("\n").filter((l) => l && !old.has(l));
    if (!fresh.length) continue;
    for (const l of fresh) old.add(l);
    seen.set(key, old);
    const a = attacks[next++];
    if (!a || a.duel_id !== r.duel_id || a.agent_pk !== r.agent_pk) throw new Error(`attack order broke at row ${r.i}`);
    mark.set(r.i, a.verdict === "fooled" ? "f" : a.verdict === "held" ? "h" : "n");
  }
  if (next !== attacks.length) throw new Error("not every attack found its row");
  const models: string[] = [];
  const duels = new Map<string, Map<string, { m: number; rows: typeof rows }>>();
  for (const r of rows) {
    if (!models.includes(r.model)) models.push(r.model);
    const d = duels.get(r.duel_id) ?? new Map();
    const a = d.get(r.agent_pk) ?? { m: models.indexOf(r.model), rows: [] };
    a.rows.push(r);
    d.set(r.agent_pk, a);
    duels.set(r.duel_id, d);
  }
  return {
    source: "dataset/decisions.jsonl",
    rows: rows.length,
    models,
    duels: [...duels.entries()]
      .sort(([x], [y]) => (big(x) < big(y) ? -1 : 1))
      .map(([id, agents]) => ({
        id,
        agents: [...agents.values()].map((a) => ({
          m: a.m,
          d: a.rows
            .sort((x, y) => (big(x.intent?.nonce) < big(y.intent?.nonce) ? -1 : big(x.intent?.nonce) > big(y.intent?.nonce) ? 1 : x.i - y.i))
            .map((r) => mark.get(r.i) ?? (!r.intent?.side ? "-" : r.injection ? ":" : "."))
            .join(""),
        })),
      })),
  };
}

if (import.meta.main) {
  const body = build();
  writeFileSync(OUT, `${JSON.stringify(body)}\n`);
  console.log(`field: ${body.rows} rows, ${body.duels.length} duels, ${body.models.length} models -> ${OUT}`);
}
