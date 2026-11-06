// NearBuddy solver = x402 facilitator that also underwrites.
// POST /verify  {x402Version, paymentPayload, paymentRequirements} -> {isValid, payer, invalidReason?}   (ms, off-chain)
// POST /settle                                                      -> settle_batch tx with everything carried
// GET  /ledger                                                      -> what the solver is carrying
// GET  /supported                                                   -> {kinds:[{x402Version, scheme, network}]}
// Carried IOUs persist to a JSON file so a restart loses nothing. Auto-settles on batch size, age, or owner withdrawal.
// `createServer(deps)` builds the request handler with no side effects; index.ts loads the account and listens.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { type Account, teraToGas } from "near-api-js";
import {
  CONTRACT,
  getMandate as chainGetMandate,
  getVault as chainGetVault,
  type Mandate,
  type SettlementReport,
  type Vault,
} from "../../protocol/src/chain.ts";
import { type SignedIou, verifyIou } from "../../protocol/src/index.ts";
import {
  NETWORK,
  SCHEME,
  type SettlementResponse,
  type VerifyRequest,
  type VerifyResponse,
  X402_VERSION,
} from "../../protocol/src/x402.ts";

type Route = { code: number; body: unknown } | null;
export interface ServerDeps {
  solverId: string;
  account: Pick<Account, "callFunctionRaw">;
  guarantor: { route(method: string | undefined, url: string | undefined, body: string): Promise<Route> };
  arena: {
    route(
      method: string | undefined,
      url: string | undefined,
      body: string,
      headers: Record<string, string | string[] | undefined>,
    ): Promise<Route>;
  };
  ledgerFile: string;
  /** settle when carrying this many */
  autoBatch: number;
  /** or when the oldest IOU is this old */
  autoAgeMs: number;
  getMandate?: (agent_pk: string) => Promise<Mandate | null>;
  getVault?: (owner: string) => Promise<Vault | null>;
}
export type SettleResult = { txHash: string; report: SettlementReport; count: number; gasTgas: number };
type Carried = { s: SignedIou; at: number };

export function createServer(deps: ServerDeps) {
  const { solverId: SOLVER_ID, account, ledgerFile: LEDGER_FILE, autoBatch: AUTO_BATCH, autoAgeMs: AUTO_AGE_MS } = deps;
  const getMandate = deps.getMandate ?? chainGetMandate;
  const getVault = deps.getVault ?? chainGetVault;

  // ---- persisted state -------------------------------------------------------------------------
  let ledger: Carried[] = [];
  const seen = new Set<string>(); // agent_pk:nonce
  const pending = new Map<string, bigint>(); // off-chain tally per agent key, incl. unsettled
  function load() {
    if (!existsSync(LEDGER_FILE)) return;
    ledger = JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as Carried[];
    for (const { s } of ledger) {
      seen.add(`${s.iou.agent_pk}:${s.iou.nonce}`);
      pending.set(s.iou.agent_pk, (pending.get(s.iou.agent_pk) ?? 0n) + BigInt(s.iou.amount));
    }
    if (ledger.length) console.log(`[solver] restored ${ledger.length} carried IOUs from ${LEDGER_FILE}`);
  }
  function save() {
    mkdirSync(dirname(LEDGER_FILE), { recursive: true });
    writeFileSync(LEDGER_FILE, JSON.stringify(ledger));
  }

  // ---- chain read cache -------------------------------------------------------------------------
  const cache = new Map<string, { at: number; v: unknown }>();
  async function cached<T>(k: string, f: () => Promise<T>, ttlMs = 3000): Promise<T> {
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
    const v = await f();
    cache.set(k, { at: Date.now(), v });
    return v;
  }

  // ---- underwriting -----------------------------------------------------------------------------
  async function underwrite(s: SignedIou): Promise<{ ok: boolean; reason?: string }> {
    const { iou } = s;
    const key = `${iou.agent_pk}:${iou.nonce}`;
    if (seen.has(key)) return { ok: false, reason: "duplicate nonce" };
    if (!verifyIou(s)) return { ok: false, reason: "bad signature" };
    if (BigInt(iou.expires_at) <= BigInt(Date.now()) * 1_000_000n + 60_000_000_000n)
      return { ok: false, reason: "iou expires too soon to settle" };

    const m = await cached<Mandate | null>(`m:${iou.agent_pk}`, () => getMandate(iou.agent_pk));
    if (!m) return { ok: false, reason: "no mandate on chain" };
    if (m.revoked) return { ok: false, reason: "mandate revoked" };
    if (m.owner !== iou.owner) return { ok: false, reason: "owner mismatch" };
    if (BigInt(m.expires_at) <= BigInt(Date.now()) * 1_000_000n) return { ok: false, reason: "mandate expired" };
    const amt = BigInt(iou.amount);
    if (amt === 0n || amt > BigInt(m.per_tx_cap)) return { ok: false, reason: "amount exceeds per_tx_cap" };
    if (m.allowed_payees.length && !m.allowed_payees.includes(iou.payee))
      return { ok: false, reason: "payee not allowed" };
    const carried = pending.get(iou.agent_pk) ?? 0n;
    if (BigInt(m.spent) + carried + amt > BigInt(m.allowance))
      return { ok: false, reason: "allowance exhausted (incl. unsettled)" };

    const v = await cached<Vault | null>(`v:${iou.owner}`, () => getVault(iou.owner));
    if (!v) return { ok: false, reason: "no vault" };
    if (v.pending_withdraw) {
      void settle().catch(() => {});
      return { ok: false, reason: "owner has a withdrawal pending" };
    }
    // Solver policy: only underwrite what the vault can already cover, so stake is never at risk.
    const ownerCarried = ledger
      .filter((c) => c.s.iou.owner === iou.owner)
      .reduce((a, c) => a + BigInt(c.s.iou.amount), 0n);
    if (BigInt(v.balance) < ownerCarried + amt) return { ok: false, reason: "vault balance below carried exposure" };

    seen.add(key);
    pending.set(iou.agent_pk, carried + amt);
    ledger.push({ s, at: Date.now() });
    save();
    if (ledger.length >= AUTO_BATCH) void settle().catch((e) => console.error("[solver] auto-settle failed:", e));
    return { ok: true };
  }

  // ---- settlement -------------------------------------------------------------------------------
  let settling: Promise<SettleResult | null> | null = null;
  function settle(): Promise<SettleResult | null> {
    // ponytail: single in-flight settlement; a second caller awaits the first.
    if (settling) return settling;
    settling = doSettle().finally(() => (settling = null));
    return settling;
  }
  async function doSettle(): Promise<SettleResult | null> {
    if (!ledger.length) return null;
    const batch = ledger.slice(0, 200);
    const res = await account.callFunctionRaw({
      contractId: CONTRACT,
      methodName: "settle_batch",
      args: { ious: batch.map((c) => c.s) },
      gas: teraToGas("300"),
    });
    const status = res.status as { SuccessValue?: string };
    if (!status.SuccessValue) throw new Error(`settle failed: ${JSON.stringify(res.status)}`);
    const report = JSON.parse(Buffer.from(status.SuccessValue, "base64").toString()) as SettlementReport;
    ledger = ledger.slice(batch.length);
    // Rebuild the off-chain tally from what is still carried; chain state now holds the rest.
    pending.clear();
    for (const { s } of ledger) pending.set(s.iou.agent_pk, (pending.get(s.iou.agent_pk) ?? 0n) + BigInt(s.iou.amount));
    cache.clear();
    save();
    const outcomes = [res.transaction_outcome, ...res.receipts_outcome] as { outcome: { gas_burnt: number } }[];
    const gasTgas = outcomes.reduce((a, o) => a + Number(o.outcome.gas_burnt), 0) / 1e12;
    console.log(
      `[solver] settled ${batch.length} IOUs in tx ${res.transaction.hash}, ${gasTgas.toFixed(2)} TGas, rejected ${report.rejected.length}`,
    );
    return { txHash: res.transaction.hash as string, report, count: batch.length, gasTgas };
  }

  // ---- http -------------------------------------------------------------------------------------
  function json(res: ServerResponse, code: number, body: unknown) {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
  const ledgerView = () => ({
    solver: SOLVER_ID,
    carrying: ledger.length,
    oldest_ms: ledger.length ? Date.now() - ledger[0]!.at : 0,
    exposure: [...pending.entries()].map(([pk, v]) => ({ agent_pk: pk, yocto: v.toString() })),
  });

  /** Restore the carried ledger from disk and arm the age-based auto-settle timer. */
  function start() {
    load();
    setInterval(() => {
      if (ledger.length && Date.now() - ledger[0]!.at >= AUTO_AGE_MS)
        void settle().catch((e) => console.error("[solver] auto-settle failed:", e));
    }, 5_000).unref();
  }

  async function handler(req: IncomingMessage, res: ServerResponse) {
    const body = await new Promise<string>((r, rej) => {
      let b = "";
      req.on("data", (c) => {
        b += c;
        if (b.length > 65_536) {
          rej(new Error("body over 64 KiB"));
          req.destroy();
        }
      });
      req.on("end", () => r(b));
    });
    try {
      if (req.method === "POST" && req.url === "/verify") {
        const v = JSON.parse(body) as VerifyRequest;
        const pp = v.paymentPayload;
        if (v.x402Version !== X402_VERSION || pp.accepted.scheme !== SCHEME || pp.accepted.network !== NETWORK)
          return json(res, 200, { isValid: false, invalidReason: "unsupported_scheme" } satisfies VerifyResponse);
        if (
          pp.payload.iou.payee !== v.paymentRequirements.payTo ||
          BigInt(pp.payload.iou.amount) < BigInt(v.paymentRequirements.amount)
        )
          return json(res, 200, {
            isValid: false,
            invalidReason: "iou does not satisfy requirements",
          } satisfies VerifyResponse);
        const out = await underwrite(pp.payload);
        return json(res, 200, {
          isValid: out.ok,
          payer: pp.payload.iou.owner,
          invalidReason: out.reason,
          extra: { solver: SOLVER_ID },
        } satisfies VerifyResponse);
      }
      if (req.method === "POST" && req.url === "/settle") {
        const r = await settle();
        const out: SettlementResponse & {
          report?: SettlementReport;
          count?: number;
          gasTgas?: number;
          txHash?: string;
        } = r
          ? {
              success: true,
              transaction: r.txHash,
              network: NETWORK,
              amount: r.report.total_paid,
              txHash: r.txHash,
              report: r.report,
              count: r.count,
              gasTgas: r.gasTgas,
            }
          : { success: true, transaction: "", network: NETWORK, errorReason: "nothing to settle" };
        return json(res, 200, out);
      }
      if (req.url === "/ledger") return json(res, 200, ledgerView());
      if (req.url === "/supported")
        return json(res, 200, { kinds: [{ x402Version: X402_VERSION, scheme: SCHEME, network: NETWORK }] });
      const g = await deps.guarantor.route(req.method, req.url, body);
      if (g) return json(res, g.code, g.body);
      const a = await deps.arena.route(req.method, req.url, body, req.headers);
      if (a) return json(res, a.code, a.body);
      json(res, 404, { error: "not found" });
    } catch (e) {
      // a body that is not JSON is the caller's fault; anything else (chain, RPC, 1Click) is ours
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[solver] ${req.method} ${req.url} failed:`, error.slice(0, 300));
      json(res, e instanceof SyntaxError ? 400 : 500, { error });
    }
  }

  return { handler, start, settle };
}
