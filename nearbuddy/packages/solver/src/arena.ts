// Arena routes for the solver. The solver account is the arena contract's owner and its only
// registered solver: it opens duels for the runner, posts agent-signed intents (with their TEE
// proofs), relays chaos, asks the oracle to resolve and settles follower fills.
//   POST /register {agent_pk, model_id, bond, tee, register_sig} -> {tx, agent}
//   POST /duel     {a, b, symbol, close_at, sig_a?, sig_b?}  -> {duel_id, tx}   (symbol = oracle asset id, e.g. wrap.near;
//                  with both sigs: open_duel_consented, each agent's ed25519 over consentMessage)
//   POST /intent   {signed: SignedIntent, tee?: TeeProof}    -> {tx, quotes:[{follower, amount, quote}]}
//                  once the intent landed the route answers 200; a quote failure comes back as quote_error
//   POST /commit   {duel_id, agent_pk, commitment, sig}      -> {tx}  (commit_intent; no quotes, the call is still hidden)
//   POST /reveal   {signed, salt, tee?}                      -> {tx, quotes}  (reveal_intent; followers are quoted here)
//   POST /chaos    {payload}  (open)                         -> {payload_hash}; spectator then calls inject_chaos on chain
//   POST /resolve  {duel_id}                                 -> {tx, sent}  (permissionless on chain; the oracle callback finishes the duel)
//   POST /open_price {duel_id}                               -> {tx}  (re-ask the oracle for a missing open price)
//   POST /settle_follow {agent_pk, follower, fills}          -> {tx, report}  (deploy 15: no dry-quote fills; testnet
//                  stand-in: stub_credit the outputs to the arena first)
//   GET  /arena                                              -> snapshot incl. pending injections with payloads
//   GET  /pairing                                            -> {every_s, next_at, last:[{duel_id, a, b, tx, at}]}  (PAIR_EVERY_S loop)
//   GET  /agent_duel?pk=<base64>                             -> {agent_pk, registered, duel_id|null}  (a self-hosted runner finds its duel)
//   GET  /followers?pk=<base64>                              -> [[follower, mandate]]  (list_followers, or get_follow per known follower)
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Account, teraToGas } from "near-api-js";
import { ARENA, arenaView } from "../../protocol/src/chain.ts";
import { b64 } from "../../protocol/src/index.ts";
import {
  commitMessage,
  consentMessage,
  type Side,
  type SignedIntent,
  type TeeProof,
  verify,
  verifyIntent,
  verifyTeeProof,
} from "../../protocol/src/intent.ts";
import { fillRequest, type Quote, quote } from "./oneclick.ts";
import {
  admit,
  batchQuote,
  type Caps,
  capsFromEnv,
  DAY_MS,
  type ExecutionRecord,
  executionRecords,
  MAX_EXECUTION,
  type OracleMid,
  oracleMid,
  quotePrice,
  variableLeg,
} from "./rfq.ts";

export interface Mandate {
  allowance: string;
  spent: string;
  per_tx_cap: string;
  allowed_tokens: string[];
  expires_at: string;
  revoked: boolean;
  /** Deploy 15: output units per NEAR in the fill must reach; "0" or absent = no floor. */
  min_out_per_near?: string;
}
export interface Fill {
  intent_nonce: string;
  token: string;
  amount_in: string;
  amount_out: string;
  swap_tx: string;
}
export interface Injection {
  duel_id: string;
  target: string;
  kind: string;
  payload: string;
  payload_hash: string;
  block: string;
}
/** With BATCH_RFQ (default) `quote` is the one batch quote shared by every follower of the intent (its USDC leg is
 *  the batch total); `quote_out` is this follower's pro rata share of the USDC leg (received on a Short, paid on a
 *  Long) and `price` the uniform USDC per NEAR. `recipient` is the intents.near account the output lands in. */
export interface FollowerQuote {
  follower: string;
  amount: string;
  quote?: Quote;
  recipient?: string;
  quote_out?: string;
  price?: number;
  error?: string;
}
interface IntentRecord {
  signed: SignedIntent;
  tx: string;
  quotes: FollowerQuote[];
  at: number;
}
/** `AgentView` from the contract (`leaderboard`, `get_agent`): the fields the pairing loop reads. */
export interface AgentView {
  pk: string;
  model_id: string;
  bond: string;
  tee: boolean;
  in_duel: string | null;
}
interface PairedDuel {
  at: number;
  duel_id: string;
  a: string;
  b: string;
  tx: string;
}
/** Duel length the pairing loop opens; must stay above the contract's `min_duel_s` (310 s). */
const DUEL_SECONDS = Number(process.env.DUEL_SECONDS ?? 330);
/** Yocto bond an agent needs above to be paired; 0 = any funded agent. */
const PAIR_MIN_BOND = BigInt(process.env.PAIR_MIN_BOND ?? "0");
/** Agents the pairing loop must leave alone (comma-separated pks): the operator's own two-sided runner drives them. */
const PAIR_EXCLUDE = new Set(
  (process.env.PAIR_EXCLUDE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const PAIR_SYMBOL = process.env.PAIR_SYMBOL ?? "wrap.near";

/// Shared secret for the POST routes: every one of them spends the solver's NEAR or debits a follower.
/// Unset = routes refuse all POSTs (the on-chain gate trusts this account, so the port must not be open).
export const ARENA_SECRET = process.env.ARENA_SECRET ?? "";
const MAX_PAYLOAD = 2048;
const MAX_PAYLOADS = 2000;
const PAYLOAD_FILE = process.env.ARENA_PAYLOADS ?? new URL("../../../.arena-payloads.json", import.meta.url).pathname;
const HISTORY_FILE = process.env.ARENA_HISTORY ?? new URL("../../../.arena-history.json", import.meta.url).pathname;
/** Write to a temp file and rename, so a crash mid-write never leaves a truncated JSON file. */
function writeAtomic(file: string, data: string) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, data);
    renameSync(`${file}.tmp`, file);
  } catch {
    /* best effort */
  }
}
function keyOk(h: string | string[] | undefined): boolean {
  if (!ARENA_SECRET || typeof h !== "string") return false;
  const a = Buffer.from(h),
    b = Buffer.from(ARENA_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}
const GAS = teraToGas("100");
const OPEN_DUEL_GAS = teraToGas("250");
/** Storage margin added on top of the on-chain `oracle_deposit` for open_duel (a duel record is ~1 KB = 0.01 NEAR). */
const OPEN_DUEL_STORAGE = 15_000_000_000_000_000_000_000n;
/** The `get_config` fields the solver reads. */
export interface ArenaConfig {
  oracle_deposit: string;
  require_consent?: boolean;
  /** Present from deploy 15 on (verified settlement): where fill outputs land and `settle_follow` reads balances. */
  intents_account?: string;
}
/** Deploy 15 (verified settlement) or later: `get_config` names the intents account. */
export const verifiedSettlement = (c: ArenaConfig | null): boolean => typeof c?.intents_account === "string";
let configMemo: { at: number; v: ArenaConfig } | null = null;
/** get_config memoised for a minute; the owner can change it (set_oracle, consent and commit-reveal switches). */
async function arenaConfig(): Promise<ArenaConfig> {
  if (configMemo && Date.now() - configMemo.at < 60_000) return configMemo.v;
  configMemo = { at: Date.now(), v: await arenaView<ArenaConfig>("get_config", {}) };
  return configMemo.v;
}
const oracleDeposit = async () => BigInt((await arenaConfig()).oracle_deposit);

/** Whose intents.near balance a fill's output lands in. `arena` (default from deploy 15): the arena contract's own
 *  balance, which `settle_follow` reads as the receipt; the follower withdraws through `withdraw_token`. Before
 *  deploy 15: `follower` (mainnet, blocker B14), the follower's own balance; `solver` (testnet), dry quotes only,
 *  nothing is owed. FILL_RECIPIENT overrides; any other value is refused. */
export function fillRecipient(solverId: string, verified = false): "solver" | "follower" | "arena" {
  const v = process.env.FILL_RECIPIENT || (verified ? "arena" : solverId.endsWith(".testnet") ? "solver" : "follower");
  if (v !== "solver" && v !== "follower" && v !== "arena")
    throw new Error(`FILL_RECIPIENT must be solver, follower or arena, not ${v}`);
  return v;
}

/** Followers to look up with `get_follow` once `list_followers` is gone (deploy 15): FOLLOWERS (comma-separated)
 *  plus every follower this solver has settled for. ponytail: a configured list; an event indexer when followers
 *  arrive unannounced. */
const FOLLOWERS = (process.env.FOLLOWERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Pick the mandate-bounded amount to quote for one follower: min(cap, allowance - spent). */
export function quoteAmount(m: Mandate): bigint {
  const left = BigInt(m.allowance) - BigInt(m.spent);
  const cap = BigInt(m.per_tx_cap);
  // biome-ignore lint/complexity/useMathMinMax: bigint, Math.min would throw
  return left < cap ? left : cap;
}

export function mandateOpen(m: Mandate, nowNs: bigint): boolean {
  return !m.revoked && BigInt(m.expires_at) > nowNs && quoteAmount(m) > 0n;
}

/** Idle enclave agents with bond above `minBond`, sorted by pk and paired with their neighbour. Deterministic:
 *  two solvers reading the same leaderboard propose the same pairs. An odd agent waits for the next tick. */
export function pairIdle(
  agents: AgentView[],
  minBond = 0n,
  exclude: ReadonlySet<string> = new Set(),
): [string, string][] {
  const idle = agents
    .filter((a) => a.tee && a.in_duel == null && BigInt(a.bond) > minBond && !exclude.has(a.pk))
    .map((a) => a.pk)
    .sort();
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < idle.length; i += 2) pairs.push([idle[i]!, idle[i + 1]!]);
  return pairs;
}

export class Arena {
  readonly intents: IntentRecord[] = [];
  /** payload_hash -> payload, filled by /chaos; an injection is "pending" once its hash is on chain. */
  readonly payloads = new Map<string, string>();
  readonly consumed = new Set<string>(); // `${duel_id}:${target}:${payload_hash}`
  readonly openDuels = new Set<string>();
  readonly fills: { agent_pk: string; follower: string; report: unknown; tx: string }[] = [];
  /** Execution quality of every prepared fill, last MAX_EXECUTION (rfq.ts), served by GET /execution. */
  readonly quality: ExecutionRecord[] = [];
  /** [ms, yocto] per quoted fill in the last 24 h, oldest first: the CAP_PER_DAY_YOCTO ledger. */
  private readonly capLedger: [number, string][] = [];
  /** Pairing loop state, served by GET /pairing. `every_s` 0 = loop off. */
  readonly pairing = { every_s: 0, next_at: 0, last: [] as PairedDuel[] };
  private pairingRun: Promise<unknown> | null = null;
  constructor(
    private readonly solver: Account,
    readonly solverId: string,
    private readonly deps: {
      listFollowers?: (agent_pk: string) => Promise<[string, Mandate][]>;
      /** `get_follow` (deploy 15 reads followers one by one). */
      getFollow?: (agent_pk: string, follower: string) => Promise<Mandate | null>;
      getDuel?: (duel_id: string) => Promise<{
        injections: { kind: string; payload_hash: string; target: string; block: string }[];
        resolved: boolean;
      } | null>;
      getAgent?: (agent_pk: string) => Promise<AgentView | null>;
      leaderboard?: () => Promise<AgentView[]>;
      config?: () => Promise<ArenaConfig>;
      quote?: typeof quote;
      oracleMid?: (duel_id: string) => Promise<OracleMid | null>;
      now?: () => bigint;
      /** Backoff between RPC retries and `findDuel` polls; tests pass `async () => {}`. */
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? ((ms) => new Promise<void>((res) => setTimeout(res, ms))))(ms);
  }

  /** One pairing tick: open a DUEL_SECONDS duel for every pair `pairIdle` makes of the leaderboard. A pair whose
   *  open fails (one side got a duel meanwhile, RPC error) is skipped and retried on the next tick. With
   *  `require_consent` on, plain open_duel panics and the loop holds no agent signatures: the tick is skipped.
   *  ponytail: pairing pauses under consent; collect a signed ready message per agent to resume it. */
  async pairOnce(): Promise<string[]> {
    if ((await (this.deps.config ?? arenaConfig)()).require_consent) {
      console.log("[arena] pairing skipped: require_consent is on and the loop holds no agent consent");
      return [];
    }
    // deploy 15 pages the leaderboard; the arg-less view before it ignores the args
    const agents = await (
      this.deps.leaderboard ?? (() => arenaView<AgentView[]>("leaderboard", { from: 0, limit: 100 }))
    )();
    const opened: string[] = [];
    for (const [a, b] of pairIdle(agents, PAIR_MIN_BOND, PAIR_EXCLUDE)) {
      const close_at = (BigInt(Date.now()) * 1_000_000n + BigInt(DUEL_SECONDS) * 1_000_000_000n).toString();
      try {
        const r = await this.openDuel(a, b, PAIR_SYMBOL, close_at);
        this.pairing.last.push({ at: Date.now(), duel_id: r.duel_id, a, b, tx: r.tx });
        opened.push(r.duel_id);
        console.log(`[arena] paired ${a.slice(0, 8)} vs ${b.slice(0, 8)}: duel ${r.duel_id} tx ${r.tx}`);
      } catch (e) {
        console.log(`[arena] pairing ${a.slice(0, 8)} vs ${b.slice(0, 8)} failed: ${String(e).slice(0, 120)}`);
      }
    }
    if (this.pairing.last.length > 50) this.pairing.last.splice(0, this.pairing.last.length - 50);
    return opened;
  }

  /** Every `everyS` seconds pair the idle enclave agents. ponytail: pairs every idle verified agent whether or
   *  not a runner is alive behind it; add a heartbeat (`POST /ready`) when unattended agents waste oracle deposits. */
  startPairing(everyS: number) {
    if (everyS <= 0) return;
    this.pairing.every_s = everyS;
    this.pairing.next_at = Date.now() + everyS * 1000;
    setInterval(() => {
      this.pairing.next_at = Date.now() + everyS * 1000;
      if (this.pairingRun) return; // a tick still opening duels: skip, never overlap open_duel calls
      this.pairingRun = this.pairOnce()
        .catch((e) => console.log(`[arena] pairing tick failed: ${String(e).slice(0, 120)}`))
        .finally(() => (this.pairingRun = null));
    }, everyS * 1000).unref();
    console.log(
      `[arena] pairing idle enclave agents every ${everyS}s into ${DUEL_SECONDS}s duels (min bond ${PAIR_MIN_BOND} yocto, ${PAIR_EXCLUDE.size} excluded)`,
    );
  }

  /** `call` with the on-chain oracle deposit; a stale memo after `set_oracle` is refreshed and the call retried once. */
  private async callWithOracleDeposit(methodName: string, args: Record<string, unknown>, extra = 0n) {
    try {
      return await this.call(methodName, args, (await oracleDeposit()) + extra, OPEN_DUEL_GAS);
    } catch (e) {
      if (!/attach oracle_deposit|deposit too small/.test(String(e))) throw e;
      configMemo = null;
      return this.call(methodName, args, (await oracleDeposit()) + extra, OPEN_DUEL_GAS);
    }
  }

  private async call(
    methodName: string,
    args: Record<string, unknown>,
    deposit = 0n,
    gas = GAS,
    contractId = ARENA,
  ): Promise<{ tx: string; value: unknown }> {
    // Public RPCs rate-limit (-429); retry with backoff before failing the route.
    let r!: Awaited<ReturnType<Account["callFunctionRaw"]>>;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await this.solver.callFunctionRaw({ contractId, methodName, args, gas, deposit });
        break;
      } catch (e) {
        if (attempt >= 4 || !/429|Rate limit/i.test(String(e))) throw e; // never resend on timeout: the tx may have landed
        await this.sleep(1500 * 2 ** attempt);
      }
    }
    const st = r.status as { SuccessValue?: string; Failure?: unknown };
    if (st.SuccessValue === undefined)
      throw new Error(`${methodName} failed: ${JSON.stringify(st.Failure ?? r.status).slice(0, 300)}`);
    const raw = Buffer.from(st.SuccessValue, "base64").toString();
    return { tx: r.transaction.hash, value: raw ? JSON.parse(raw) : null };
  }

  /** Register an agent with a bond paid by the solver account (the runner has no NEAR account).
   *  `tee` commits the agent to a verified enclave proof on every intent. */
  async register(agent_pk: string, model_id: string, bond: string, tee = false, register_sig?: string) {
    const r = await this.call("register_agent", { agent_pk, model_id, tee, register_sig }, BigInt(bond));
    return { tx: r.tx, agent: r.value };
  }

  /** `symbol` is the oracle asset id (`wrap.near` = NEAR/USD on Outlayer). The open price arrives a few
   *  seconds later through the oracle callback. */
  async openDuel(a: string, b: string, symbol: string, close_at: string, consent?: { sig_a: string; sig_b: string }) {
    if (consent) {
      // same check the contract runs, so a bad signature fails here without spending gas
      const msg = consentMessage(ARENA, a, b, symbol, close_at);
      if (!verify(a, msg, consent.sig_a) || !verify(b, msg, consent.sig_b)) throw new Error("bad consent signature");
    }
    let r: { tx: string; value: unknown };
    try {
      r = consent
        ? await this.callWithOracleDeposit(
            "open_duel_consented",
            { a, b, symbol, close_at, ...consent },
            OPEN_DUEL_STORAGE,
          )
        : await this.callWithOracleDeposit("open_duel", { a, b, symbol, close_at }, OPEN_DUEL_STORAGE);
    } catch (e) {
      // the oracle yield inside open_duel makes the tx take several seconds; public RPCs sometimes drop the wait
      // with "Internal server error" after the tx landed. Never resend (the agents would be "in duel"): look it up.
      const found = await this.findDuel(a, b, close_at);
      if (!found) throw e;
      console.log(`[arena] open_duel rpc wait failed (${String(e).slice(0, 60)}); recovered duel ${found} from chain`);
      r = { tx: "", value: found };
    }
    this.openDuels.add(String(r.value));
    return { duel_id: String(r.value), tx: r.tx };
  }

  /** The newest unresolved duel pairing `a` and `b` at `close_at`, or null. Polls briefly: the tx may still be landing. */
  private async findDuel(a: string, b: string, close_at: string): Promise<string | null> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const cfg = await arenaView<{ next_duel: string }>("get_config", {});
      const n = Number(cfg.next_duel);
      for (let id = n - 1; id >= Math.max(0, n - 3); id--) {
        const d = await arenaView<{ a: string; b: string; close_at: string; resolved: boolean } | null>("get_duel", {
          duel_id: String(id),
        });
        if (d && d.a === a && d.b === b && d.close_at === close_at && !d.resolved) return String(id);
      }
      await this.sleep(3000);
    }
    return null;
  }

  async postIntent(signed: SignedIntent, tee?: TeeProof) {
    return this.landIntent("post_intent", signed, tee);
  }

  /** Commit-reveal, step 1: relay the agent's signed commitment. Nothing about the call is public yet: no quotes. */
  async commitIntent(duel_id: string, agent_pk: string, commitment: string, sig: string) {
    if (!verify(agent_pk, commitMessage(ARENA, duel_id, b64.dec(commitment)), sig))
      throw new Error("bad commit signature");
    return { tx: (await this.call("commit_intent", { duel_id, agent_pk, commitment, sig })).tx };
  }

  /** Commit-reveal, step 2: the contract checks sha256(intent bytes || salt) against the stored commitment, then
   *  runs post_intent's checks. The call is public from here on, so followers are quoted now. */
  async revealIntent(signed: SignedIntent, salt: string, tee?: TeeProof) {
    return this.landIntent("reveal_intent", signed, tee, { salt });
  }

  private async landIntent(method: string, signed: SignedIntent, tee?: TeeProof, extra: { salt?: string } = {}) {
    if (!verifyIntent(signed)) throw new Error("bad intent signature");
    if (tee) {
      // same check the contract runs, so a bad record fails here without spending gas
      const agent = await arenaView<{ model_id: string } | null>("get_agent", { agent_pk: signed.intent.agent_pk });
      if (!agent) throw new Error("agent missing");
      if (!verifyTeeProof(tee, agent.model_id, signed.intent.proof_hash)) throw new Error("bad tee proof");
    }
    const r = await this.call(method, { signed, ...extra, tee: tee ?? null });
    // The intent has landed: from here a failure is reported in the body, never as an error. A 500 for a landed tx
    // makes the runner retry a used nonce or re-reveal a deleted commitment.
    let quotes: FollowerQuote[] = [];
    let quote_error: string | undefined;
    try {
      quotes = await this.quotesFor(signed.intent.agent_pk, signed.intent.side);
      const mid = quotes.some((x) => x.quote) ? await (this.deps.oracleMid ?? oracleMid)(signed.intent.duel_id) : null;
      this.quality.push(...executionRecords(signed.intent, quotes, mid));
      this.quality.splice(0, Math.max(0, this.quality.length - MAX_EXECUTION));
    } catch (e) {
      quote_error = String(e).slice(0, 200);
      console.log(`[arena] ${method} landed (${r.tx}) but follower quotes failed: ${quote_error}`);
    }
    const rec: IntentRecord = { signed, tx: r.tx, quotes, at: Date.now() };
    this.intents.push(rec);
    if (this.intents.length > 500) this.intents.shift();
    this.persistHistory();
    return quote_error === undefined ? { tx: r.tx, quotes } : { tx: r.tx, quotes, quote_error };
  }

  /** Every follower of `agent_pk` with its mandate. Before deploy 15: the `list_followers` view. From deploy 15
   *  (`follows` keyed per pair, not enumerable on chain): `get_follow` for FOLLOWERS plus the followers this
   *  solver has settled for. */
  async followersOf(agent_pk: string): Promise<[string, Mandate][]> {
    if (this.deps.listFollowers) return this.deps.listFollowers(agent_pk);
    if (!verifiedSettlement(await this.config())) return arenaView<[string, Mandate][]>("list_followers", { agent_pk });
    const known = [...new Set([...FOLLOWERS, ...this.fills.map((f) => f.follower)])];
    const get =
      this.deps.getFollow ??
      ((pk: string, follower: string) => arenaView<Mandate | null>("get_follow", { agent_pk: pk, follower }));
    const found = await Promise.all(known.map(async (f) => [f, await get(agent_pk, f)] as const));
    return found.filter((x): x is [string, Mandate] => x[1] !== null);
  }

  /** `get_config` (memoised); null when the RPC fails, which the callers read as "before deploy 15". */
  private async config(): Promise<ArenaConfig | null> {
    try {
      return await (this.deps.config ?? arenaConfig)();
    } catch {
      return null;
    }
  }

  /** Dry 1Click quotes for the open follower mandates, sized by the mandate in NEAR, in the agent's direction: Short
   *  sells NEAR for USDC, Long buys NEAR with USDC. Never a real swap. BATCH_RFQ (default on): one quote for the sum,
   *  split pro rata at one price (rfq.ts); BATCH_RFQ=0, or FILL_RECIPIENT=follower (a quote has one recipient): one
   *  quote per follower. From deploy 15 the batch recipient is the arena (`fillRecipient`). */
  async quotesFor(agent_pk: string, side: Side = "Short"): Promise<FollowerQuote[]> {
    const list = await this.followersOf(agent_pk);
    const now = (this.deps.now ?? (() => BigInt(Date.now()) * 1_000_000n))();
    const q = this.deps.quote ?? quote;
    // 1Click quotes mainnet prices: a testnet account stands in for its .near namesake
    const solver = this.solverId.replace(/\.testnet$/, ".near");
    const open = list
      .filter(([, m]) => mandateOpen(m, now))
      .map(([follower, m]) => ({ follower, amount: quoteAmount(m) }));
    if (open.length === 0) return [];
    const to = fillRecipient(this.solverId, verifiedSettlement(await this.config()));
    const payFollower = to === "follower";
    // one recipient for the whole batch: the solver, or (deploy 15) the arena, which credits each follower
    const batchTo = to === "arena" ? ARENA.replace(/\.testnet$/, ".near") : solver;
    // B17: the solver's own caps, before any quote. A bad cap value refuses every follower (fail closed).
    let caps: Caps;
    try {
      caps = capsFromEnv();
    } catch (e) {
      return open.map((f) => ({ follower: f.follower, amount: f.amount.toString(), error: String(e).slice(0, 200) }));
    }
    const nowMs = Number(now / 1_000_000n);
    const { admitted, rejected } = admit(open, caps, this.capUsed(nowMs));
    // Reserve the admitted amounts before the first await, so two intents landing together cannot both fit under
    // the day cap; a follower whose quote fails gets its reservation back below.
    const held = new Map(admitted.map((f) => [f.follower, [nowMs, f.amount.toString()] as [number, string]]));
    this.capLedger.push(...held.values());
    let quoted: FollowerQuote[] = [];
    if (admitted.length > 0 && process.env.BATCH_RFQ !== "0" && !payFollower) {
      const b = await batchQuote(admitted, (amount) => q(fillRequest(side, amount, solver, batchTo)));
      quoted = b.fills.map((f) =>
        b.quote && !f.error ? { ...f, quote: b.quote, price: b.price, recipient: batchTo } : f,
      );
    } else
      quoted = await Promise.all(
        admitted.map(async ({ follower, amount }): Promise<FollowerQuote> => {
          const recipient = payFollower ? follower : batchTo;
          try {
            const r = await q(fillRequest(side, amount, solver, recipient));
            const quote_out = r.quote[variableLeg(r)];
            return { follower, amount: amount.toString(), quote: r, recipient, quote_out, price: quotePrice(r) };
          } catch (e) {
            return { follower, amount: amount.toString(), error: String(e).slice(0, 200) };
          }
        }),
      );
    for (const x of quoted) {
      const h = held.get(x.follower);
      const i = !x.quote && h ? this.capLedger.indexOf(h) : -1;
      if (i >= 0) this.capLedger.splice(i, 1);
    }
    const out = new Map<string, FollowerQuote>([...rejected, ...quoted].map((x) => [x.follower, x]));
    return open.map((f) => out.get(f.follower)!);
  }

  /** Yocto quoted in the last 24 h, for CAP_PER_DAY_YOCTO. Counts prepared fills, not settled ones (conservative).
   *  Pruned as it is read; persisted with the history so a restart does not reset the day. */
  private capUsed(nowMs: number): bigint {
    while (this.capLedger.length > 0 && this.capLedger[0]![0] <= nowMs - DAY_MS) this.capLedger.shift();
    return this.capLedger.reduce((s, [, a]) => s + BigInt(a), 0n);
  }

  /** Spectator path, no secret: store the payload and return its hash. The spectator then calls
   *  `inject_chaos(duel_id, target, kind, payload_hash)` on chain with their own deposit; the runner only
   *  sees the injection once it is on chain (see `pending`). ponytail: in-memory store, capped.
   *  The prompt's datamark delimiters (`<<`, `>>`, `^`; agents/prompts.py variant A) are stripped first, so a
   *  payload cannot forge an `<<ORACLE>>` block or break the word marks; the hash covers the stored text. */
  stash(raw: string): { payload_hash: string } {
    if (raw.length > MAX_PAYLOAD) throw new Error(`payload over ${MAX_PAYLOAD} bytes`);
    const payload = raw.replace(/(?:<<|>>|\^|\[\/?(?:ORACLE|TELEMETRY)\]|<\/?URGENT_MARKET_TELEMETRY>)+/gi, " ");
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
    writeAtomic(
      HISTORY_FILE,
      JSON.stringify({
        intents: this.intents.slice(-50),
        fills: this.fills.slice(-50),
        quality: this.quality,
        cap_ledger: this.capLedger,
      }),
    );
  }

  /** Rebuild `openDuels` from chain and `payloads` from disk after a restart. */
  async bootstrap() {
    // Local files first, each on its own: a corrupt file must never block the on-chain rebuild below.
    try {
      if (existsSync(PAYLOAD_FILE))
        for (const [h, p] of JSON.parse(readFileSync(PAYLOAD_FILE, "utf8")) as [string, string][])
          this.payloads.set(h, p);
    } catch (e) {
      console.log(`[arena] payload file ignored: ${String(e).slice(0, 80)}`);
    }
    try {
      if (existsSync(HISTORY_FILE)) {
        const h = JSON.parse(readFileSync(HISTORY_FILE, "utf8")) as {
          intents?: IntentRecord[];
          fills?: Arena["fills"];
          quality?: ExecutionRecord[];
          cap_ledger?: [number, string][];
        } | null;
        this.intents.push(...(h?.intents ?? []));
        this.fills.push(...(h?.fills ?? []));
        if (Array.isArray(h?.quality)) this.quality.push(...h.quality.slice(-MAX_EXECUTION));
        if (Array.isArray(h?.cap_ledger)) this.capLedger.push(...h.cap_ledger);
      }
    } catch (e) {
      console.log(`[arena] history file ignored: ${String(e).slice(0, 80)}`);
    }
    try {
      const cfg = await arenaView<{ next_duel: string }>("get_config", {});
      const n = Number(cfg.next_duel);
      for (let id = n - 1; id >= Math.max(0, n - 20); id--) {
        const d = await (
          this.deps.getDuel ??
          ((x: string) => arenaView<{ resolved: boolean; injections: never[] }>("get_duel", { duel_id: x }))
        )(String(id));
        if (d && !d.resolved) this.openDuels.add(String(id));
      }
      console.log(`[arena] bootstrap: ${this.openDuels.size} open duels, ${this.payloads.size} payloads`);
    } catch (e) {
      console.log(`[arena] bootstrap skipped: ${String(e).slice(0, 120)}`);
    }
  }

  /** Ask the oracle for the close price, paying its deposit. The contract finishes the duel when the oracle
   *  calls back; `pending()` drops the duel once `get_duel` reports it resolved. `sent: false` means the RPC
   *  dropped the wait and the caller should check `get_duel` and retry rather than wait. */
  async resolve(duel_id: string) {
    let tx = "",
      sent = true;
    try {
      tx = (await this.callWithOracleDeposit("resolve_duel", { duel_id })).tx;
    } catch (e) {
      // same RPC wait issue as open_duel; the request is detached on chain, so a landed tx has done its job.
      // resolve_duel is idempotent until the oracle answers, so the caller may simply retry.
      if (!/Internal server error|timeout|Timeout/i.test(String(e))) throw e;
      sent = false;
      console.log(
        `[arena] resolve_duel rpc wait failed (${String(e).slice(0, 60)}); the oracle callback will finish duel ${duel_id} if the tx landed`,
      );
    }
    for (const k of this.consumed) if (k.startsWith(`${duel_id}:`)) this.consumed.delete(k);
    return { tx, sent };
  }

  /** Re-ask the oracle for a duel whose open price never landed, paying its deposit. */
  async requestOpenPrice(duel_id: string) {
    return { tx: (await this.callWithOracleDeposit("request_open_price", { duel_id })).tx };
  }

  /** Ask the arena to repay fills this solver fronted. From deploy 15 the contract pays only for output its own
   *  intents.near balance shows, so `dry-quote:` fills are refused here before any gas is spent. On a testnet stand-in
   *  (`intents_account` other than intents.near) the swap is `stub_credit`: the batch's `amount_out` per token is
   *  credited to the arena first, and a fill with an empty `swap_tx` carries that credit's tx hash. */
  async settleFollow(agent_pk: string, follower: string, fills: Fill[]) {
    const intents = (await (this.deps.config ?? arenaConfig)()).intents_account;
    if (intents !== undefined) {
      if (fills.some((f) => f.swap_tx.startsWith("dry-quote:")))
        throw new Error("dry quote unsettleable: deploy 15 pays only for output delivered to the arena");
      if (intents !== "intents.near") {
        const owed = new Map<string, bigint>();
        for (const f of fills) owed.set(f.token, (owed.get(f.token) ?? 0n) + BigInt(f.amount_out));
        let creditTx = "";
        for (const [token_id, amount] of owed)
          creditTx = (
            await this.call(
              "stub_credit",
              { receiver_id: ARENA, token_id, amount: amount.toString() },
              0n,
              GAS,
              intents,
            )
          ).tx;
        fills = fills.map((f) => (f.swap_tx ? f : { ...f, swap_tx: `stub:${creditTx}` }));
      }
    }
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
    const getDuel =
      this.deps.getDuel ??
      ((id: string) =>
        arenaView<{
          injections: { kind: string; payload_hash: string; target: string; block: string }[];
          resolved: boolean;
        }>("get_duel", { duel_id: id }));
    const out: Record<string, Injection[]> = {};
    await Promise.all(
      [...this.openDuels].map(async (duel_id) => {
        let d: Awaited<ReturnType<typeof getDuel>>;
        try {
          d = await getDuel(duel_id);
        } catch {
          return;
        }
        if (!d) return;
        if (d.resolved) {
          this.openDuels.delete(duel_id);
          return;
        }
        for (const j of d.injections) {
          const payload = this.payloads.get(j.payload_hash);
          if (payload === undefined || this.consumed.has(`${duel_id}:${j.target}:${j.block}`)) continue;
          const list = out[j.target] ?? [];
          out[j.target] = list;
          list.push({
            duel_id,
            target: j.target,
            kind: j.kind,
            payload,
            payload_hash: j.payload_hash,
            block: j.block,
          });
        }
      }),
    );
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
      contract: ARENA,
      solver: this.solverId,
      intents: this.intents.slice(-50).map((r) => ({ ...r.signed.intent, tx: r.tx, quotes: r.quotes, at: r.at })),
      pending: await this.pending(),
      fills: this.fills.slice(-50),
      quality: this.quality.slice(-10), // the page shows 10; GET /execution serves all MAX_EXECUTION
    };
  }

  async route(
    method: string | undefined,
    url: string | undefined,
    body: string,
    headers: Record<string, string | string[] | undefined> = {},
  ): Promise<{ code: number; body: unknown } | null> {
    if (url === "/arena") return { code: 200, body: await this.snapshot() };
    if (url === "/pairing") return { code: 200, body: this.pairing };
    if (url === "/execution") return { code: 200, body: { quality: this.quality } };
    if (url?.startsWith("/followers?")) {
      // public chain data, open like /arena: the web reads followers here once list_followers is gone (deploy 15)
      const pk = new URLSearchParams(url.slice("/followers?".length)).get("pk")?.replace(/ /g, "+");
      if (!pk) return { code: 400, body: { error: "pk required" } };
      return { code: 200, body: await this.followersOf(pk) };
    }
    if (url?.startsWith("/agent_duel?")) {
      // base64 pks hold '+': a client that forgot to percent-encode it arrives as a space; base64 never has spaces
      const pk = new URLSearchParams(url.slice("/agent_duel?".length)).get("pk")?.replace(/ /g, "+");
      if (!pk) return { code: 400, body: { error: "pk required" } };
      const agent = await (
        this.deps.getAgent ?? ((p: string) => arenaView<AgentView | null>("get_agent", { agent_pk: p }))
      )(pk);
      return { code: 200, body: { agent_pk: pk, registered: agent !== null, duel_id: agent?.in_duel ?? null } };
    }
    if (method === "POST" && url === "/chaos")
      return { code: 200, body: this.stash((JSON.parse(body) as { payload: string }).payload) };
    const mine = [
      "/duel",
      "/register",
      "/intent",
      "/commit",
      "/reveal",
      "/resolve",
      "/open_price",
      "/settle_follow",
      "/consume",
    ].includes(url ?? "");
    if (!mine) return null;
    if (method !== "POST") return { code: 405, body: { error: "POST only" } };
    if (!keyOk(headers["x-arena-key"])) return { code: 401, body: { error: "x-arena-key required" } };
    if (url === "/duel") {
      const q = JSON.parse(body) as {
        a: string;
        b: string;
        symbol: string;
        close_at: string;
        sig_a?: string;
        sig_b?: string;
      };
      if (!q.sig_a !== !q.sig_b) return { code: 400, body: { error: "sig_a and sig_b go together" } };
      const consent = q.sig_a && q.sig_b ? { sig_a: q.sig_a, sig_b: q.sig_b } : undefined;
      return { code: 200, body: await this.openDuel(q.a, q.b, q.symbol, q.close_at, consent) };
    }
    if (method === "POST" && url === "/register") {
      const q = JSON.parse(body) as {
        agent_pk: string;
        model_id: string;
        bond: string;
        tee?: boolean;
        register_sig?: string;
      };
      return { code: 200, body: await this.register(q.agent_pk, q.model_id, q.bond, q.tee === true, q.register_sig) };
    }
    if (method === "POST" && url === "/intent") {
      const q = JSON.parse(body) as { signed?: SignedIntent; tee?: TeeProof } & Partial<SignedIntent>;
      // accept both {signed, tee} and a bare SignedIntent (older demo)
      const signed = q.signed ?? ({ intent: q.intent, signature: q.signature } as SignedIntent);
      return { code: 200, body: await this.postIntent(signed, q.tee ?? undefined) };
    }
    if (url === "/commit") {
      const q = JSON.parse(body) as { duel_id: string; agent_pk: string; commitment: string; sig: string };
      return { code: 200, body: await this.commitIntent(String(q.duel_id), q.agent_pk, q.commitment, q.sig) };
    }
    if (url === "/reveal") {
      const q = JSON.parse(body) as { signed: SignedIntent; salt: string; tee?: TeeProof | null };
      return { code: 200, body: await this.revealIntent(q.signed, q.salt, q.tee ?? undefined) };
    }
    if (method === "POST" && url === "/resolve") {
      const q = JSON.parse(body) as { duel_id: string };
      return { code: 200, body: await this.resolve(String(q.duel_id)) };
    }
    if (method === "POST" && url === "/open_price") {
      const q = JSON.parse(body) as { duel_id: string };
      return { code: 200, body: await this.requestOpenPrice(String(q.duel_id)) };
    }
    if (method === "POST" && url === "/settle_follow") {
      const q = JSON.parse(body) as { agent_pk: string; follower: string; fills: Fill[] };
      try {
        return { code: 200, body: await this.settleFollow(q.agent_pk, q.follower, q.fills) };
      } catch (e) {
        if (/dry quote unsettleable/.test(String(e))) return { code: 400, body: { error: String(e).slice(7) } };
        throw e;
      }
    }
    if (method === "POST" && url === "/consume") {
      const q = JSON.parse(body) as { target: string; duel_id: string; blocks: string[] };
      this.consume(q.target, q.duel_id, q.blocks ?? []);
      return { code: 200, body: { ok: true } };
    }
    return null;
  }
}
