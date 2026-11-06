// Arena routes for the solver. The solver account is the arena contract's owner and its only
// registered solver: it opens duels for the runner, posts agent-signed intents (with their TEE
// proofs), relays chaos, asks the oracle to resolve and settles follower fills.
//   POST /register {agent_pk, model_id, bond, tee}           -> {tx, agent}
//   POST /duel     {a, b, symbol, close_at}                  -> {duel_id, tx}   (symbol = oracle asset id, e.g. wrap.near)
//   POST /intent   {signed: SignedIntent, tee?: TeeProof}    -> {tx, quotes:[{follower, amount, quote}]}
//   POST /chaos    {payload}  (open)                         -> {payload_hash}; spectator then calls inject_chaos on chain
//   POST /resolve  {duel_id}                                 -> {tx}  (permissionless on chain; the oracle callback finishes the duel)
//   POST /settle_follow {agent_pk, follower, fills}          -> {tx, report}
//   GET  /arena                                              -> snapshot incl. pending injections with payloads
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { teraToGas, type Account } from "near-api-js";
import { b64 } from "../../protocol/src/index.ts";
import { verifyIntent, verifyTeeProof, type SignedIntent, type TeeProof } from "../../protocol/src/intent.ts";
import { ARENA, arenaView } from "../../protocol/src/chain.ts";
import { quote, sellNearForUsdc, type Quote } from "./oneclick.ts";

export interface Mandate { allowance: string; spent: string; per_tx_cap: string; allowed_tokens: string[]; expires_at: string; revoked: boolean }
export interface Fill { intent_nonce: string; token: string; amount_in: string; amount_out: string; swap_tx: string }
export interface Injection { duel_id: string; target: string; kind: string; payload: string; payload_hash: string; block: string }
export interface FollowerQuote { follower: string; amount: string; quote?: Quote; error?: string }
interface IntentRecord { signed: SignedIntent; tx: string; quotes: FollowerQuote[]; at: number }

/// Shared secret for the POST routes: every one of them spends the solver's NEAR or debits a follower.
/// Unset = routes refuse all POSTs (the on-chain gate trusts this account, so the port must not be open).
export const ARENA_SECRET = process.env.ARENA_SECRET ?? "";
export const MAX_PAYLOAD = 2048;
export const MAX_PAYLOADS = 2000;
const PAYLOAD_FILE = process.env.ARENA_PAYLOADS ?? new URL("../../../.arena-payloads.json", import.meta.url).pathname;
const HISTORY_FILE = process.env.ARENA_HISTORY ?? new URL("../../../.arena-history.json", import.meta.url).pathname;
/** Write to a temp file and rename, so a crash mid-write never leaves a truncated JSON file. */
function writeAtomic(file: string, data: string) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, data);
    renameSync(`${file}.tmp`, file);
  } catch { /* best effort */ }
}
function keyOk(h: string | string[] | undefined): boolean {
  if (!ARENA_SECRET || typeof h !== "string") return false;
  const a = Buffer.from(h), b = Buffer.from(ARENA_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}
const GAS = teraToGas("100");
/** open_duel: oracle_call deposit (0.02 NEAR, mostly refunded by the oracle) plus the duel record's storage. */
const OPEN_DUEL_GAS = teraToGas("250");
const OPEN_DUEL_DEPOSIT = 35_000_000_000_000_000_000_000n;

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

  private async call(methodName: string, args: Record<string, unknown>, deposit = 0n, gas = GAS): Promise<{ tx: string; value: unknown }> {
    // Public RPCs rate-limit (-429); retry with backoff before failing the route.
    let r!: Awaited<ReturnType<Account["callFunctionRaw"]>>;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await this.solver.callFunctionRaw({ contractId: ARENA, methodName, args, gas, deposit });
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

  /** Register an agent with a bond paid by the solver account (the runner has no NEAR account).
   *  `tee` commits the agent to a verified enclave proof on every intent. */
  async register(agent_pk: string, model_id: string, bond: string, tee = false) {
    const r = await this.call("register_agent", { agent_pk, model_id, tee }, BigInt(bond));
    return { tx: r.tx, agent: r.value };
  }

  /** `symbol` is the oracle asset id (`wrap.near` = NEAR/USD on Outlayer). The open price arrives a few
   *  seconds later through the oracle callback. */
  async openDuel(a: string, b: string, symbol: string, close_at: string) {
    const r = await this.call("open_duel", { a, b, symbol, close_at }, OPEN_DUEL_DEPOSIT, OPEN_DUEL_GAS);
    this.openDuels.add(String(r.value));
    return { duel_id: String(r.value), tx: r.tx };
  }

  async postIntent(signed: SignedIntent, tee?: TeeProof) {
    if (!verifyIntent(signed)) throw new Error("bad intent signature");
    if (tee) {
      // same check the contract runs, so a bad record fails here without spending gas
      const agent = await arenaView<{ model_id: string } | null>("get_agent", { agent_pk: signed.intent.agent_pk });
      if (!agent) throw new Error("agent missing");
      if (!verifyTeeProof(tee, agent.model_id, signed.intent.proof_hash)) throw new Error("bad tee proof");
    }
    const r = await this.call("post_intent", { signed, tee: tee ?? null });
    const quotes = await this.quotesFor(signed.intent.agent_pk);
    const rec: IntentRecord = { signed, tx: r.tx, quotes, at: Date.now() };
    this.intents.push(rec);
    if (this.intents.length > 500) this.intents.shift();
    this.persistHistory();
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
    if (payload.length > MAX_PAYLOAD) throw new Error(`payload over ${MAX_PAYLOAD} bytes`);
    const payload_hash = b64.enc(createHash("sha256").update(payload).digest());
    this.payloads.set(payload_hash, payload);
    while (this.payloads.size > MAX_PAYLOADS) this.payloads.delete(this.payloads.keys().next().value!);
    this.persistPayloads();
    return { payload_hash };
  }

  /** Payloads survive a restart (a spectator pays on chain after handing us the text). */
  private persistPayloads() {
    writeAtomic(PAYLOAD_FILE, JSON.stringify([...this.payloads.entries()]));
  }
  /** The last 50 intents and fills only exist here (the page's SOLVER panel reads them). */
  private persistHistory() {
    writeAtomic(HISTORY_FILE, JSON.stringify({ intents: this.intents.slice(-50), fills: this.fills.slice(-50) }));
  }

  /** Rebuild `openDuels` from chain and `payloads` from disk after a restart. */
  async bootstrap() {
    // Local files first, each on its own: a corrupt file must never block the on-chain rebuild below.
    try {
      if (existsSync(PAYLOAD_FILE)) for (const [h, p] of JSON.parse(readFileSync(PAYLOAD_FILE, "utf8")) as [string, string][]) this.payloads.set(h, p);
    } catch (e) { console.log(`[arena] payload file ignored: ${String(e).slice(0, 80)}`); }
    try {
      if (existsSync(HISTORY_FILE)) {
        const h = JSON.parse(readFileSync(HISTORY_FILE, "utf8")) as { intents?: IntentRecord[]; fills?: Arena["fills"] } | null;
        this.intents.push(...(h?.intents ?? []));
        this.fills.push(...(h?.fills ?? []));
      }
    } catch (e) { console.log(`[arena] history file ignored: ${String(e).slice(0, 80)}`); }
    try {
      const cfg = await arenaView<{ next_duel: string }>("get_config", {});
      const n = Number(cfg.next_duel);
      for (let id = n - 1; id >= Math.max(0, n - 20); id--) {
        const d = await (this.deps.getDuel ?? ((x: string) => arenaView<{ resolved: boolean; injections: never[] }>("get_duel", { duel_id: x })))(String(id));
        if (d && !d.resolved) this.openDuels.add(String(id));
      }
      console.log(`[arena] bootstrap: ${this.openDuels.size} open duels, ${this.payloads.size} payloads`);
    } catch (e) {
      console.log(`[arena] bootstrap skipped: ${String(e).slice(0, 120)}`);
    }
  }

  /** Ask the oracle for the close price. The contract finishes the duel when the oracle calls back;
   *  `pending()` drops the duel once `get_duel` reports it resolved. */
  async resolve(duel_id: string) {
    const tx = (await this.call("resolve_duel", { duel_id }, 0n, OPEN_DUEL_GAS)).tx;
    for (const k of this.consumed) if (k.startsWith(`${duel_id}:`)) this.consumed.delete(k);
    return { tx };
  }

  async settleFollow(agent_pk: string, follower: string, fills: Fill[]) {
    const r = await this.call("settle_follow", { agent_pk, follower, fills });
    this.fills.push({ agent_pk, follower, report: r.value, tx: r.tx });
    this.persistHistory();
    return { tx: r.tx, report: r.value };
  }

  private pendingMemo: { at: number; v: Record<string, Injection[]> } | null = null;
  /** Injections on chain for open duels whose payload this solver holds and the runner has not prompted yet.
   *  One view per open duel, in parallel, memoised for 3 s; an RPC error skips that duel for this call. */
  async pending(): Promise<Record<string, Injection[]>> {
    if (this.pendingMemo && Date.now() - this.pendingMemo.at < 3000) return this.pendingMemo.v;
    const getDuel = this.deps.getDuel ?? ((id: string) => arenaView<{ injections: { kind: string; payload_hash: string; target: string; block: string }[]; resolved: boolean }>("get_duel", { duel_id: id }));
    const out: Record<string, Injection[]> = {};
    await Promise.all([...this.openDuels].map(async (duel_id) => {
      let d: Awaited<ReturnType<typeof getDuel>>;
      try { d = await getDuel(duel_id); } catch { return; }
      if (!d) return;
      if (d.resolved) { this.openDuels.delete(duel_id); return; }
      for (const j of d.injections) {
        const payload = this.payloads.get(j.payload_hash);
        if (payload === undefined || this.consumed.has(`${duel_id}:${j.target}:${j.block}`)) continue;
        (out[j.target] ??= []).push({ duel_id, target: j.target, kind: j.kind, payload, payload_hash: j.payload_hash, block: j.block });
      }
    }));
    this.pendingMemo = { at: Date.now(), v: out };
    return out;
  }
  /** Keyed by block, so two spectators injecting the same text are two prompts. */
  consume(target: string, duel_id: string, blocks: string[]) {
    for (const b of blocks) this.consumed.add(`${duel_id}:${target}:${b}`);
    this.pendingMemo = null;
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
    const mine = ["/duel", "/register", "/intent", "/resolve", "/settle_follow", "/consume"].includes(url ?? "");
    if (!mine) return null;
    if (method !== "POST") return { code: 405, body: { error: "POST only" } };
    if (!keyOk(headers["x-arena-key"])) return { code: 401, body: { error: "x-arena-key required" } };
    if (url === "/duel") {
      const q = JSON.parse(body) as { a: string; b: string; symbol: string; close_at: string };
      return { code: 200, body: await this.openDuel(q.a, q.b, q.symbol, q.close_at) };
    }
    if (method === "POST" && url === "/register") {
      const q = JSON.parse(body) as { agent_pk: string; model_id: string; bond: string; tee?: boolean };
      return { code: 200, body: await this.register(q.agent_pk, q.model_id, q.bond, q.tee === true) };
    }
    if (method === "POST" && url === "/intent") {
      const q = JSON.parse(body) as { signed?: SignedIntent; tee?: TeeProof } & Partial<SignedIntent>;
      // accept both {signed, tee} and a bare SignedIntent (older demo)
      const signed = q.signed ?? ({ intent: q.intent, signature: q.signature } as SignedIntent);
      return { code: 200, body: await this.postIntent(signed, q.tee ?? undefined) };
    }
    if (method === "POST" && url === "/resolve") {
      const q = JSON.parse(body) as { duel_id: string };
      return { code: 200, body: await this.resolve(String(q.duel_id)) };
    }
    if (method === "POST" && url === "/settle_follow") {
      const q = JSON.parse(body) as { agent_pk: string; follower: string; fills: Fill[] };
      return { code: 200, body: await this.settleFollow(q.agent_pk, q.follower, q.fills) };
    }
    if (method === "POST" && url === "/consume") {
      const q = JSON.parse(body) as { target: string; duel_id: string; blocks: string[] };
      this.consume(q.target, q.duel_id, q.blocks ?? []);
      return { code: 200, body: { ok: true } };
    }
    return null;
  }
}
