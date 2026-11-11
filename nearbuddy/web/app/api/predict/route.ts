// GET /api/predict?duel=<id>: every prediction market of one duel with its crowd split and whether it takes a call now
// (api/predict.ts). GET /api/predict?account=<account>: the calls that account holds, open or scored and not yet
// claimed, and `owed`, the board row's storage its next claim keeps back (get_stats; "0" once kept). The terminal
// reads these instead of the RPC.
// Every tab on the live duel asks for the same URL, so the CDN keeps each body 3 s (stale-while-revalidate 10 s). A
// duel's body is also kept 3 s in this process and built once at a time, and its last good body beats a 502 while the
// RPC is throttled. An account's body is built per request: only that account's tab asks for it.
import { arenaView, json, jsonBody, predictView } from "../near";
import { MAX_INJECTIONS, marketsOf, type Opens } from "../predict";

const EDGE = "public, s-maxage=3, stale-while-revalidate=10";
const TTL = 3_000;
const ID_RE = /^(0|[1-9]\d{0,11})$/;
// a NEAR account id: 2 to 64 characters, lowercase letters and digits joined by single - _ or . separators
const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** An arena without `chaos_open` (deploy 17) fails that view; asked again after this long, not on every build. */
const NO_VIEW_MS = 5 * 60_000;

const cache = new Map<string, { at: number; body: string }>();
const inflight = new Map<string, Promise<string>>();
let noChaosOpen = 0;

const bad = (error: string) => json(JSON.stringify({ error }), 400);
const failed = (e: unknown) =>
  json(JSON.stringify({ error: String(e instanceof Error ? e.message : e).slice(0, 200) }), 502);

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const duel = q.get("duel");
  const account = q.get("account");
  if (duel !== null && !ID_RE.test(duel)) return bad("duel must be a duel number");
  if (account !== null && !ACCOUNT_RE.test(account)) return bad("account must be a NEAR account id");
  if ((duel === null) === (account === null)) return bad("ask for one duel=<id> or one account=<account>");
  if (account !== null) {
    try {
      const [held, stats] = await Promise.all([
        predictView("get_predictions", { account }),
        predictView("get_stats", { account }),
      ]);
      return json(jsonBody({ at: Date.now(), account, held, owed: stats?.storage_owed ?? "0" }), 200, EDGE);
    } catch (e) {
      return failed(e);
    }
  }
  const id = duel as string;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return json(hit.body, 200, EDGE);
  let p = inflight.get(id);
  if (!p) {
    p = build(id).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  try {
    return json(await p, 200, EDGE);
  } catch (e) {
    // a stale body may say open after the market closed: serve it only while it is under 30 s old
    return hit && Date.now() - hit.at < 30_000 ? json(hit.body, 200, EDGE) : failed(e);
  }
}

/** Whether a failed view call failed because the contract has no such method (any provider's error says so). */
const noMethod = (e: unknown): boolean =>
  [e, ...((e as { errors?: unknown[] } | null)?.errors ?? [])].some(
    (x) => x instanceof Error && /method is not found|MethodNotFound/i.test(`${x.name} ${x.message}`),
  );

async function build(id: string): Promise<string> {
  const [duel, lock, chaos, called] = await Promise.all([
    arenaView("get_duel", { duel_id: id }),
    arenaView("duel_lock", { duel_id: id }),
    arenaView("get_chaos", { duel_id: id }),
    predictView("get_duel_markets", { duel_id: id }),
  ]);
  if (!duel) throw new Error(`no duel #${id}`);
  const pending = chaos.slice(0, MAX_INJECTIONS).flatMap((c, i) => (c.outcome === "Pending" ? [i] : []));
  let opens: Opens = null;
  if (pending.length && Date.now() - noChaosOpen > NO_VIEW_MS) {
    try {
      const got = await Promise.all(pending.map((index) => arenaView("chaos_open", { duel_id: id, index })));
      opens = new Map(pending.map((index, k) => [index, got[k] ?? null]));
    } catch (e) {
      if (!noMethod(e)) throw e; // an RPC failure is no answer: serve the last good body, never a guessed label
      noChaosOpen = Date.now();
    }
  }
  const markets = marketsOf(duel, lock, chaos, opens, called, BigInt(Date.now()) * 1_000_000n);
  const body = jsonBody({ at: Date.now(), duel_id: id, markets });
  cache.set(id, { at: Date.now(), body });
  if (cache.size > 100) cache.delete(cache.keys().next().value as string);
  return body;
}
