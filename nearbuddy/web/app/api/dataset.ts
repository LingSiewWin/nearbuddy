// The decisions dataset as the web app sees it. Always: the build-time snapshot (app/data/decisions.json,
// from ../dataset/decisions.jsonl). Optionally, when DECISIONS_LIVE points at the runner's decisions.jsonl
// (a local demo next to a running runner), the newest rows of that file too, re-read at most every 3 s, so
// a live duel shows each model's reasoning as it decides. On a host without the runner it is unset.
// app/data/*.json is gitignored and written by scripts/snapshot.ts, so it is read at runtime, not imported:
// a fresh clone typechecks without it, and a missing file is an empty dataset. next.config.ts traces
// app/data into the API functions so a deployed function finds it next to process.cwd().
import { readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { type Bytes, type Decision, type Raw, slim } from "../lib/rows";

export type { Decision };

const read = <T>(name: string, empty: T): T => {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "app/data", name), "utf8")) as T;
  } catch {
    return empty;
  }
};
const snap = read<{ rows: Decision[]; attacks: Record<string, string>; built: number }>("decisions.json", {
  rows: [],
  attacks: {},
  built: 0,
});
const known = new Set(snap.rows.map((r) => r.tx));
export const datasetBuilt = snap.built;

const LIVE = process.env.DECISIONS_LIVE;
const TAIL = 4 * 1024 * 1024; // last 4 MB of the file: hundreds of rows
let live: { at: number; rows: Decision[]; attacks: Record<string, string> } = { at: 0, rows: [], attacks: {} };

async function tail() {
  if (!LIVE || Date.now() - live.at < 3_000) return live;
  try {
    const size = (await stat(LIVE)).size;
    const f = await open(LIVE, "r");
    const buf = Buffer.alloc(Math.min(TAIL, size));
    await f.read(buf, 0, buf.length, size - buf.length);
    await f.close();
    const lines = buf
      .toString("utf8")
      .split("\n")
      .slice(size > TAIL ? 1 : 0); // drop a cut first line
    const raws = lines.flatMap((l) => {
      try {
        return l ? [JSON.parse(l) as Raw] : [];
      } catch {
        return [];
      }
    });
    const s = slim(raws);
    live = { at: Date.now(), rows: s.rows.filter((r) => !known.has(r.tx)), attacks: s.attacks };
  } catch {
    live = { ...live, at: Date.now() };
  }
  return live;
}

/** Every known decision, oldest first. */
export async function getDecisions(): Promise<Decision[]> {
  const t = await tail();
  return t.rows.length ? [...snap.rows, ...t.rows] : snap.rows;
}
/** The attack text behind an on-chain payload hash, when any source knows it. */
export async function attackText(hash: string): Promise<string | null> {
  return snap.attacks[hash] ?? (await tail()).attacks[hash] ?? null;
}

let bodies: Record<string, Bytes> | null = null;
/** The exact request/response bytes behind one decision tx, only where their sha256 matched the chain. */
export function decisionBytes(tx: string): Bytes | null {
  bodies ??= read<Record<string, Bytes>>("bodies.json", {});
  return Object.hasOwn(bodies, tx) ? (bodies[tx] ?? null) : null;
}
