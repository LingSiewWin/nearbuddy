// GET /api/follower?account=X: one follower's state on the arena (deploy 15), read-only. Views: vault, pending
// withdrawal, holdings per token, the mandate for each agent it followed. History from FastNEAR's tx API: its own txs
// (follow / unfollow / deposit / request_withdraw / withdraw / withdraw_token) and, for settled fills, the arena's txs
// back to its first follow (the solver signs settle_follow, so those txs are not in the follower's own index).
// Receipt-level success only (lib/follower). Parsed arena txs are kept across requests, so a repeat scan fetches only
// new hashes. A body is kept 30 s per account, a failed build 45 s.
import { type FollowerRec, type SettledFill, TOKENS } from "../../cells";
import { followedAgents, followerActivity, forFollower, settledFills } from "../../lib/follower";
import type { Tx } from "../../lib/verify";
import { NET } from "../../network";
import { ARENA, arenaConfigAnyDeploy, arenaView, json } from "../near";

const TX_API = process.env.FASTNEAR_TX_API ?? NET.txApi;
const TTL = 30_000;
const ERROR_TTL = 45_000;
const OWN_PAGES = 3; // 200 txs a page: a follower's own history
const ARENA_PAGES = 6; // ponytail: fills older than ~1200 arena txs before now are not read; index settles if that bites
// NEAR account ids: 2-64 chars, lowercase parts joined by "-" / "_" inside a part and "." between parts
const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

const kept = new Map<string, { until: number; body: string; status: number }>(); // per account, oldest out past 500
const inflight = new Map<string, Promise<string>>();
const fillsByTx = new Map<string, SettledFill[]>(); // arena tx hash -> fills it settled, any follower; [] when none

async function txApi<T>(path: string, body: unknown): Promise<T> {
  let last = "";
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${TX_API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    }).catch((x) => ({ ok: false, status: String(x) }) as const);
    if (r.ok && "json" in r) return (await r.json()) as T;
    last = String(r.status);
    await new Promise((s) => setTimeout(s, 400 * 2 ** i)); // FastNEAR 429s a cold burst
  }
  throw new Error(`fastnear ${path} ${last}`);
}

type Page = { account_txs: { transaction_hash: string; tx_block_timestamp: string }[]; resume_token?: string };
const ms = (ns: string) => Number(BigInt(ns) / 1_000_000n);

/** Up to `pages` pages of an account's txs, newest first, stopping once a page reaches back past `fromMs`. */
async function txList(account: string, pages: number, fromMs = 0) {
  const out: { hash: string; at_ms: number }[] = [];
  let resume: string | undefined;
  for (let p = 0; p < pages; p++) {
    const page = await txApi<Page>("/account", { account_id: account, ...(resume ? { resume_token: resume } : {}) });
    for (const t of page.account_txs) out.push({ hash: t.transaction_hash, at_ms: ms(t.tx_block_timestamp) });
    const oldest = out.at(-1)?.at_ms ?? 0;
    if (!page.resume_token || oldest < fromMs) return { list: out, complete: true };
    resume = page.resume_token;
  }
  return { list: out, complete: false };
}

async function txBodies(hashes: string[]): Promise<Tx[]> {
  const out: Tx[] = [];
  for (let i = 0; i < hashes.length; i += 20)
    out.push(
      ...(await txApi<{ transactions: Tx[] }>("/transactions", { tx_hashes: hashes.slice(i, i + 20) })).transactions,
    );
  return out;
}

/** Fills settled for `account` in the arena's txs since `fromMs`, reading only txs not parsed before. */
async function arenaFills(account: string, fromMs: number) {
  const { list, complete } = await txList(ARENA, ARENA_PAGES, fromMs);
  const inWindow = list.filter((t) => t.at_ms >= fromMs);
  const fresh = inWindow.map((t) => t.hash).filter((h) => !fillsByTx.has(h));
  const got = await txBodies(fresh); // a tx not indexed yet is absent here, and read again next time
  for (const t of got) fillsByTx.set(t.transaction.hash, []);
  for (const f of settledFills(got, ARENA)) fillsByTx.get(f.tx)?.push(f);
  while (fillsByTx.size > 20_000) fillsByTx.delete(fillsByTx.keys().next().value as string);
  const fills = forFollower(
    inWindow.flatMap((t) => fillsByTx.get(t.hash) ?? []),
    account,
  );
  return {
    fills: fills.sort((x, y) => y.at_ms - x.at_ms),
    scan: { from_ms: fromMs, oldest_ms: list.at(-1)?.at_ms ?? null, txs: inWindow.length, complete },
  };
}

async function build(account: string): Promise<string> {
  const config = await arenaConfigAnyDeploy();
  const deploy15 = !!config.intents_account; // absent on a contract before deploy 15
  const [vault, pending, own] = await Promise.all([
    arenaView("get_vault", { account }).catch(() => null),
    arenaView("get_pending_withdraw", { account }).catch(() => null),
    txList(account, OWN_PAGES),
  ]);
  const activity = followerActivity(await txBodies(own.list.map((t) => t.hash)), ARENA, account);
  const agents = followedAgents(activity);
  const mandates = await Promise.all(
    agents.map(async (agent_pk) => ({
      agent_pk,
      model_id: (await arenaView("get_agent", { agent_pk }).catch(() => null))?.model_id ?? null,
      mandate: await arenaView("get_follow", { agent_pk, follower: account }).catch(() => null),
    })),
  );
  const tokens = new Set([
    ...Object.keys(TOKENS),
    ...mandates.flatMap((m) => m.mandate?.allowed_tokens ?? []),
    ...activity.flatMap((x) => (x.token ? [x.token] : [])),
  ]);
  const holdings = deploy15
    ? (
        await Promise.all(
          [...tokens].map(async (token) => ({
            token,
            amount: (await arenaView("get_holding", { follower: account, token_id: token }).catch(() => null)) ?? "0",
          })),
        )
      ).filter((h) => h.amount !== "0" || TOKENS[h.token])
    : [];
  const firstFollow = activity.find((x) => x.kind === "follow")?.at_ms;
  const { fills, scan } =
    firstFollow === undefined
      ? { fills: [], scan: { from_ms: null, oldest_ms: null, txs: 0, complete: true } }
      : await arenaFills(account, firstFollow - 60_000);
  const rec: FollowerRec = {
    at: Date.now(),
    account,
    arena: ARENA,
    deploy15,
    vault,
    pending: pending ? { amount: pending[0], ready_at: pending[1] } : null,
    holdings,
    mandates,
    fills,
    fills_scan: scan,
    activity: activity.reverse(), // newest first
  };
  return JSON.stringify(rec);
}

const keep = (account: string, body: string, ttl: number, status = 200) => {
  kept.set(account, { until: Date.now() + ttl, body, status });
  if (kept.size > 500) kept.delete(kept.keys().next().value as string);
};

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account");
  if (!account || !ACCOUNT_RE.test(account))
    return json(JSON.stringify({ error: "account must be a NEAR account id" }), 400);
  const hit = kept.get(account);
  if (hit && Date.now() < hit.until) return json(hit.body, hit.status);
  let p = inflight.get(account);
  if (!p) {
    p = build(account).finally(() => inflight.delete(account));
    inflight.set(account, p);
  }
  try {
    const body = await p;
    keep(account, body, TTL);
    return json(body);
  } catch (e) {
    if (hit?.status === 200) {
      keep(account, hit.body, ERROR_TTL); // the last good body, and no rebuild for a while
      return json(hit.body);
    }
    const body = JSON.stringify({ error: String(e).slice(0, 200) });
    keep(account, body, ERROR_TTL, 502);
    return json(body, 502);
  }
}
