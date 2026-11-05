// Arena routes for the solver. The solver account is the arena contract's owner and its only
// registered solver: it opens duels for the runner, posts agent-signed intents, relays chaos,
// submits oracle-signed resolutions and settles follower fills.
//   POST /duel     {a, b, symbol, close_at}                  -> {duel_id, tx}
//   POST /intent   SignedIntent                              -> {tx, quotes:[{follower, amount, quote}]}
//   POST /chaos    {payload}  (open)                         -> {payload_hash}; spectator then calls inject_chaos on chain
//   POST /chaos_paid {duel_id, target, kind, payload}        -> {tx, payload_hash}  (solver pays; demo only)
//   POST /resolve  {resolution, oracle_sig}                  -> {tx}
//   POST /settle_follow {agent_pk, follower, fills}          -> {tx, report}
//   GET  /arena                                              -> snapshot incl. pending injections with payloads
import { createHash, timingSafeEqual } from "node:crypto";
import { teraToGas, type Account } from "near-api-js";
import { b64 } from "../../protocol/src/index.ts";
import { verifyIntent, type Resolution, type SignedIntent } from "../../protocol/src/intent.ts";
import { ARENA, arenaView } from "../../protocol/src/chain.ts";
import { quote, sellNearForUsdc, type Quote } from "./oneclick.ts";

export interface Mandate { allowance: string; spent: string; per_tx_cap: string; allowed_tokens: string[]; expires_at: string; revoked: boolean }
export interface Fill { intent_nonce: string; token: string; amount_in: string; amount_out: string; swap_tx: string }
export interface Injection { duel_id: string; target: string; kind: string; payload: string; payload_hash: string; block: string }
export interface FollowerQuote { follower: string; amount: string; quote?: Quote; error?: string }
interface IntentRecord { signed: SignedIntent; tx: string; quotes: FollowerQuote[]; at: number }

export const CHAOS_DEPOSIT = BigInt(process.env.CHAOS_DEPOSIT ?? "100000000000000000000000");
/// Shared secret for the POST routes: every one of them spends the solver's NEAR or debits a follower.
/// Unset = routes refuse all POSTs (the on-chain gate trusts this account, so the port must not be open).
export const ARENA_SECRET = process.env.ARENA_SECRET ?? "";
function keyOk(h: string | string[] | undefined): boolean {
  if (!ARENA_SECRET || typeof h !== "string") return false;
  const a = Buffer.from(h), b = Buffer.from(ARENA_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}
const GAS = teraToGas("100");

/** Pick the mandate-bounded amount to quote for one follower: min(cap, allowance - spent). */
export function quoteAmount(m: Mandate): bigint {
  const left = BigInt(m.allowance) - BigInt(m.spent);
  const cap = BigInt(m.per_tx_cap);
  return left < cap ? left : cap;
}

export function mandateOpen(m: Mandate, nowNs: bigint): boolean {
  return !m.revoked && BigInt(m.expires_at) > nowNs && quoteAmount(m) > 0n;
}

export class Arena {
  readonly intents: IntentRecord[] = [];
  /** payload_hash -> payload, filled by /chaos; an injection is "pending" once its hash is on chain. */
  readonly payloads = new Map<string, string>();
  readonly consumed = new Set<string>(); // `${duel_id}:${target}:${payload_hash}`
  readonly openDuels = new Set<string>();
  readonly fills: { agent_pk: string; follower: string; report: unknown; tx: string }[] = [];
  constructor(
    private readonly solver: Account,
    readonly solverId: string,
    private readonly deps: {
      listFollowers?: (agent_pk: string) => Promise<[string, Mandate][]>;
      getDuel?: (duel_id: string) => Promise<{ injections: { kind: string; payload_hash: string; target: string; block: string }[]; resolved: boolean } | null>;
      quote?: typeof quote;
      now?: () => bigint;
    } = {},
  ) {}

  private async call(methodName: string, args: Record<string, unknown>, deposit = 0n): Promise<{ tx: string; value: unknown }> {
    // Public RPCs rate-limit (-429); retry with backoff before failing the route.
    let r!: Awaited<ReturnType<Account["callFunctionRaw"]>>;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await this.solver.callFunctionRaw({ contractId: ARENA, methodName, args, gas: GAS, deposit });
        break;
      } catch (e) {
        if (attempt >= 4 || !/429|Rate limit/i.test(String(e))) throw e; // never resend on timeout: the tx may have landed
        await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
      }
    }
    const st = r.status as { SuccessValue?: string; Failure?: unknown };
    if (st.SuccessValue === undefined) throw new Error(`${methodName} failed: ${JSON.stringify(st.Failure ?? r.status).slice(0, 300)}`);
    const raw = Buffer.from(st.SuccessValue, "base64").toString();
    return { tx: r.transaction.hash, value: raw ? JSON.parse(raw) : null };
  }

  /** Register an agent with a bond paid by the solver account (the runner has no NEAR account). */
  async register(agent_pk: string, model_id: string, bond: string) {
    const r = await this.call("register_agent", { agent_pk, model_id }, BigInt(bond));
    return { tx: r.tx, agent: r.value };
  }

  async openDuel(a: string, b: string, symbol: string, close_at: string) {
    const r = await this.call("open_duel", { a, b, symbol, close_at });
    this.openDuels.add(String(r.value));
    return { duel_id: String(r.value), tx: r.tx };
  }

  async postIntent(signed: SignedIntent) {
    if (!verifyIntent(signed)) throw new Error("bad intent signature");
    const r = await this.call("post_intent", { signed });
    const quotes = await this.quotesFor(signed.intent.agent_pk);
    const rec: IntentRecord = { signed, tx: r.tx, quotes, at: Date.now() };
    this.intents.push(rec);
    if (this.intents.length > 500) this.intents.shift();
    return { tx: r.tx, quotes };
  }

  /** One dry 1Click quote per open follower mandate, sized by the mandate. Never a real swap. */
  async quotesFor(agent_pk: string): Promise<FollowerQuote[]> {
    const list = await (this.deps.listFollowers ?? ((pk) => arenaView<[string, Mandate][]>("list_followers", { agent_pk: pk })))(agent_pk);
    const now = (this.deps.now ?? (() => BigInt(Date.now()) * 1_000_000n))();
    const q = this.deps.quote ?? quote;
    const account = this.solverId.replace(/\.testnet$/, ".near");
    return Promise.all(list.filter(([, m]) => mandateOpen(m, now)).map(async ([follower, m]): Promise<FollowerQuote> => {
      const amount = quoteAmount(m);
      try {
        return { follower, amount: amount.toString(), quote: await q(sellNearForUsdc(amount, account)) };
      } catch (e) {
        return { follower, amount: amount.toString(), error: String(e).slice(0, 200) };
      }
    }));
  }

  /** Spectator path, no secret: store the payload and return its hash. The spectator then calls
   *  `inject_chaos(duel_id, target, kind, payload_hash)` on chain with their own deposit; the runner only
   *  sees the injection once it is on chain (see `pending`). ponytail: in-memory store, capped. */
  stash(payload: string): { payload_hash: string } {
    const payload_hash = b64.enc(createHash("sha256").update(payload).digest());
    this.payloads.set(payload_hash, payload);
    if (this.payloads.size > 500) this.payloads.delete(this.payloads.keys().next().value!);
    return { payload_hash };
  }

  /** Operator path (secret): the solver pays the deposit itself. Kept for the runner-less demo. */
  async injectChaos(duel_id: string, target: string, kind: string, payload: string) {
    const { payload_hash } = this.stash(payload);
    const r = await this.call("inject_chaos", { duel_id, target, kind, payload_hash }, CHAOS_DEPOSIT);
    return { tx: r.tx, payload_hash };
  }

  async resolve(resolution: Resolution, oracle_sig: string) {
    const tx = (await this.call("resolve", { resolution, oracle_sig })).tx;
    this.openDuels.delete(resolution.duel_id);
    for (const k of this.consumed) if (k.startsWith(`${resolution.duel_id}:`)) this.consumed.delete(k);
    return { tx };
  }

  async settleFollow(agent_pk: string, follower: string, fills: Fill[]) {
    const r = await this.call("settle_follow", { agent_pk, follower, fills });
    this.fills.push({ agent_pk, follower, report: r.value, tx: r.tx });
    return { tx: r.tx, report: r.value };
  }

  /** Injections on chain for open duels whose payload this solver holds and the runner has not prompted yet. */
  async pending(): Promise<Record<string, Injection[]>> {
    const out: Record<string, Injection[]> = {};
    const getDuel = this.deps.getDuel ?? ((id: string) => arenaView<{ injections: { kind: string; payload_hash: string; target: string; block: string }[]; resolved: boolean }>("get_duel", { duel_id: id }));
    for (const duel_id of this.openDuels) {
      const d = await getDuel(duel_id);
      if (!d || d.resolved) { this.openDuels.delete(duel_id); continue; }
      for (const j of d.injections) {
        const payload = this.payloads.get(j.payload_hash);
        if (payload === undefined || this.consumed.has(`${duel_id}:${j.target}:${j.payload_hash}`)) continue;
        (out[j.target] ??= []).push({ duel_id, target: j.target, kind: j.kind, payload, payload_hash: j.payload_hash, block: j.block });
      }
    }
    return out;
  }
  consume(target: string, duel_id: string, hashes: string[]) {
    for (const h of hashes) this.consumed.add(`${duel_id}:${target}:${h}`);
  }

  async snapshot() {
    return {
      contract: ARENA, solver: this.solverId,
      intents: this.intents.slice(-50).map((r) => ({ ...r.signed.intent, tx: r.tx, quotes: r.quotes, at: r.at })),
      pending: await this.pending(), fills: this.fills.slice(-50),
    };
  }

  async route(method: string | undefined, url: string | undefined, body: string, headers: Record<string, string | string[] | undefined> = {}): Promise<{ code: number; body: unknown } | null> {
    if (url === "/arena") return { code: 200, body: await this.snapshot() };
    if (method === "POST" && url === "/chaos") return { code: 200, body: this.stash((JSON.parse(body) as { payload: string }).payload) };
    const mine = ["/duel", "/register", "/intent", "/chaos_paid", "/resolve", "/settle_follow", "/consume"].includes(url ?? "");
    if (!mine) return null;
    if (method !== "POST") return { code: 405, body: { error: "POST only" } };
    if (!keyOk(headers["x-arena-key"])) return { code: 401, body: { error: "x-arena-key required" } };
    if (url === "/duel") {
      const q = JSON.parse(body) as { a: string; b: string; symbol: string; close_at: string };
      return { code: 200, body: await this.openDuel(q.a, q.b, q.symbol, q.close_at) };
    }
    if (method === "POST" && url === "/register") {
      const q = JSON.parse(body) as { agent_pk: string; model_id: string; bond: string };
      return { code: 200, body: await this.register(q.agent_pk, q.model_id, q.bond) };
    }
    if (method === "POST" && url === "/intent") return { code: 200, body: await this.postIntent(JSON.parse(body) as SignedIntent) };
    if (method === "POST" && url === "/chaos_paid") {
      const q = JSON.parse(body) as { duel_id: string; target: string; kind: string; payload: string };
      return { code: 200, body: await this.injectChaos(q.duel_id, q.target, q.kind, q.payload) };
    }
    if (method === "POST" && url === "/resolve") {
      const q = JSON.parse(body) as { resolution: Resolution; oracle_sig: string };
      return { code: 200, body: await this.resolve(q.resolution, q.oracle_sig) };
    }
    if (method === "POST" && url === "/settle_follow") {
      const q = JSON.parse(body) as { agent_pk: string; follower: string; fills: Fill[] };
      return { code: 200, body: await this.settleFollow(q.agent_pk, q.follower, q.fills) };
    }
    if (method === "POST" && url === "/consume") {
      const q = JSON.parse(body) as { target: string; duel_id: string; hashes: string[] };
      this.consume(q.target, q.duel_id, q.hashes ?? []);
      return { code: 200, body: { ok: true } };
    }
    return null;
  }
}
