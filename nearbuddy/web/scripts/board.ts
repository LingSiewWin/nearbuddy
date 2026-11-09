// Snapshot of the "hardest to fool" board from the published decisions dataset: `bun scripts/board.ts` rewrites
// app/data/board.json (a few KB, committed, served by /api/board). app/__tests__/board.test.ts fails when the file
// no longer matches ../dataset/decisions.jsonl, so re-run this after every dataset export.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pushedSide } from "../../packages/demo/src/against";
import { attacksOf, type Row, scores } from "../app/lib/fool";

const DATASET = fileURLToPath(new URL("../../dataset/decisions.jsonl", import.meta.url));
export const OUT = fileURLToPath(new URL("../app/data/board.json", import.meta.url));
const RECENT = 40;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The board body for one dataset file: per-model scores and the newest attacks, newest first. */
export function build(path = DATASET) {
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
  const attacks = attacksOf(rows, pushedSide);
  return {
    source: "dataset/decisions.jsonl",
    rows: rows.length,
    models: scores(attacks),
    recent: attacks
      .slice(-RECENT)
      .reverse()
      .map((a) => ({ ...a, text: cut(a.text, 280), reply: cut(a.reply, 280) })),
  };
}

if (import.meta.main) {
  const body = build();
  writeFileSync(OUT, `${JSON.stringify(body, null, 1)}\n`);
  console.log(
    `board: ${body.rows} rows, ${body.models.map((m) => `${m.model} ${m.fooled}/${m.tested}`).join(", ")} -> ${OUT}`,
  );
}
