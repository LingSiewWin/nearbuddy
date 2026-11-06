// Read-only copier bot: would an outsider watching the arena contract profit by mirroring agents' public
// intents during the window before a follower fill lands? Polls the newest duel every 5 s, and for every new
// intent (nonce change on last_intent_a / last_intent_b) records the Coinbase NEAR-USD spot at detection,
// +15 s, +60 s, +90 s and the oracle close once the duel resolves. No keys, no chain writes.
//   bun analysis/copier_bot.ts --minutes 240     collect, append rows to analysis/data/copier.jsonl, print table
//   bun analysis/copier_bot.ts --report          table only, from the jsonl
// Return convention: positive bps = mirroring the intent (Long -> buy, Short -> sell) at detection made money.
// Close-horizon exit is the oracle close (price-oracle.testnet), entry is Coinbase: a small basis is baked in.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { JsonRpcProvider } from "near-api-js";

const RPC = process.env.COPIER_RPC ?? "https://test.rpc.fastnear.com"; // not NEAR_RPC: views go to FastNEAR to spare drpc
const ARENA = process.env.ARENA_CONTRACT ?? "arena.nearbuddy-solver.testnet";
const COINBASE = "https://api.coinbase.com/v2/prices/NEAR-USD/spot";
const POLL_MS = 5_000;
const FLUSH_DELAY_MS = 120_000; // > the +90 s horizon plus fetch slack
const HORIZONS_S = [15, 60, 90] as const;
const HARDENED = ["Ul+W6UJK", "qZ+N09R4"];
const NAIVE = ["8dPZ7znZ", "fwHajcL3"];
const OUT = new URL("./data/copier.jsonl", import.meta.url).pathname;

type Intent = { agent_pk: string; side: "Long" | "Short"; size_bps: number; nonce: string };
type Duel = {
  id: string;
  a: string;
  b: string;
  close_at: string;
  resolved: boolean;
  last_intent_a: Intent | null;
  last_intent_b: Intent | null;
  outcome: { open_price: string; close_price: string } | null;
  open_price: string | null;
};
type Row = {
  duel_id: string;
  agent_pk: string;
  agent: "hardened" | "naive" | "other";
  side: "Long" | "Short";
  size_bps: number;
  nonce: string;
  detected_at: string;
  open_price: string | null;
  p0: number | null;
  p15: number | null;
  p60: number | null;
  p90: number | null;
  close_price: string | null;
};

const provider = new JsonRpcProvider({ url: RPC });
const view = <T>(method: string, args: Record<string, unknown>) =>
  provider.callFunction({ contractId: ARENA, method, args }) as Promise<T>;
const agentClass = (pk: string): Row["agent"] =>
  HARDENED.some((p) => pk.startsWith(p)) ? "hardened" : NAIVE.some((p) => pk.startsWith(p)) ? "naive" : "other";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function spot(): Promise<number | null> {
  try {
    const r = await fetch(COINBASE, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;
    return Number(((await r.json()) as { data: { amount: string } }).data.amount);
  } catch {
    return null;
  }
}

// ---- stats ------------------------------------------------------------------------------------
const ret = (side: Row["side"], p0: number, p1: number) => (side === "Long" ? 1 : -1) * ((p1 - p0) / p0) * 10_000;

function stats(xs: number[]) {
  const n = xs.length;
  if (n === 0) return { n, mean: NaN, hit: NaN, lo: NaN, hi: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const half = (1.96 * sd) / Math.sqrt(n);
  return { n, mean, hit: xs.filter((x) => x > 0).length / n, lo: mean - half, hi: mean + half };
}

function report(rows: Row[]) {
  const horizons: [string, (r: Row) => number | null][] = [
    ...HORIZONS_S.map((h): [string, (r: Row) => number | null] => [
      `+${h}s`,
      (r) => r[`p${h}` as "p15" | "p60" | "p90"],
    ]),
    ["close", (r) => (r.close_price ? Number(r.close_price) / 1e8 : null)],
  ];
  const groups: [string, (r: Row) => boolean][] = [
    ["all", () => true],
    ["hardened", (r) => r.agent === "hardened"],
    ["naive", (r) => r.agent === "naive"],
  ];
  const f = (x: number, d = 2) => (Number.isNaN(x) ? "-" : x.toFixed(d));
  console.log(`\n${rows.length} intents in ${OUT}`);
  console.log("group     horizon  n     mean_bps  hit    ci95");
  for (const [g, inG] of groups) {
    for (const [h, px] of horizons) {
      const xs = rows.filter(inG).flatMap((r) => {
        const p1 = px(r);
        return r.p0 && p1 ? [ret(r.side, r.p0, p1)] : [];
      });
      const s = stats(xs);
      console.log(
        `${g.padEnd(9)} ${h.padEnd(8)} ${String(s.n).padEnd(5)} ${f(s.mean).padStart(8)}  ${f(s.hit)}  [${f(s.lo)}, ${f(s.hi)}]`,
      );
    }
  }
}

const readRows = (): Row[] =>
  existsSync(OUT)
    ? readFileSync(OUT, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Row)
    : [];

// ---- collection -------------------------------------------------------------------------------
const pending = new Map<string, Row[]>(); // duel id -> rows waiting for the oracle close
const seen = new Set<string>(); // `${duel}:${pk}:${nonce}`
let written = 0;

function flush(duelId: string, closePrice: string | null) {
  for (const row of pending.get(duelId) ?? []) {
    row.close_price = closePrice;
    appendFileSync(OUT, `${JSON.stringify(row)}\n`);
    written++;
  }
  pending.delete(duelId);
}

async function onIntent(d: Duel, it: Intent) {
  const t0 = Date.now();
  const row: Row = {
    duel_id: d.id,
    agent_pk: it.agent_pk,
    agent: agentClass(it.agent_pk),
    side: it.side,
    size_bps: it.size_bps,
    nonce: it.nonce,
    detected_at: new Date(t0).toISOString(),
    open_price: d.open_price ?? null,
    p0: await spot(),
    p15: null,
    p60: null,
    p90: null,
    close_price: null,
  };
  console.log(`${row.detected_at} duel ${d.id} ${row.agent} ${it.agent_pk.slice(0, 8)} ${it.side} @ ${row.p0}`);
  for (const h of HORIZONS_S) {
    await sleep(Math.max(0, t0 + h * 1000 - Date.now()));
    row[`p${h}` as "p15" | "p60" | "p90"] = await spot();
  }
  pending.set(d.id, [...(pending.get(d.id) ?? []), row]);
}

async function collect(minutes: number) {
  mkdirSync(new URL("./data/", import.meta.url).pathname, { recursive: true });
  const deadline = Date.now() + minutes * 60_000;
  const tracked = new Map<string, Duel>(); // unresolved duels we have seen
  const done = new Set<string>(); // duels already scheduled for flush
  let first = true;
  const stop = () => {
    for (const id of [...pending.keys()]) flush(id, null); // unresolved at exit: close stays null
    console.log(`\nwrote ${written} rows`);
    report(readRows());
    process.exit(0);
  };
  process.on("SIGINT", stop);
  console.log(`watching ${ARENA} via ${RPC}, ${minutes} min, rows -> ${OUT}`);
  while (Date.now() < deadline) {
    try {
      const { next_duel } = await view<{ next_duel: string }>("get_config", {});
      const newest = String(Number(next_duel) - 1);
      const ids = new Set([newest, ...tracked.keys()]);
      for (const id of ids) {
        const d = await view<Duel | null>("get_duel", { duel_id: id });
        if (!d) continue;
        for (const it of [d.last_intent_a, d.last_intent_b]) {
          if (!it) continue;
          const key = `${d.id}:${it.agent_pk}:${it.nonce}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (first) continue; // intents already on chain at startup: detection time unknown, skip
          void onIntent(d, it);
        }
        if (done.has(id)) continue;
        if (d.resolved) {
          tracked.delete(id);
          done.add(id);
          // give in-flight +90 s fetches time to land before writing the duel's rows
          setTimeout(() => flush(id, d.outcome?.close_price ?? null), FLUSH_DELAY_MS);
        } else if (Date.now() > Number(BigInt(d.close_at) / 1_000_000n) + 15 * 60_000) {
          tracked.delete(id);
          done.add(id); // never resolved; write what we have
          setTimeout(() => flush(id, null), FLUSH_DELAY_MS);
        } else tracked.set(id, d);
      }
      first = false;
    } catch (e) {
      console.error(`poll failed: ${(e as Error).message}`);
    }
    await sleep(POLL_MS);
  }
  await sleep(FLUSH_DELAY_MS + 5_000); // let the last scheduled flushes run
  stop();
}

const args = process.argv.slice(2);
if (args.includes("--report")) report(readRows());
else await collect(Number(args[args.indexOf("--minutes") + 1] || 60));
