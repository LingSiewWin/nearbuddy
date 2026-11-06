// The published decisions dataset as the web app sees it: app/data/*.json, written by scripts/snapshot.ts at
// build time from ../dataset/decisions.jsonl. Rows are enclave-verified decisions with the model's own
// reasoning and, when attacked, the attack text and a plain verdict.
import data from "../data/decisions.json";
import type { Side, Verdict } from "../lib/verdict";

export type Decision = {
  duel: string;
  agent: string;
  model: string;
  arm: string;
  side: Side;
  size: number;
  at: number;
  reason: string;
  brief: string;
  attack: string | null;
  pushed: Side | null;
  verdict: Verdict | null;
  tx: string | null;
};
const d = data as unknown as { rows: Decision[]; attacks: Record<string, string>; built: number };
export const decisions = d.rows;
export const attackTexts = d.attacks;
export const datasetBuilt = d.built;
