// Full-stack sandbox run: the real arena wasm on a local near-sandbox, the real solver (bun) and the real
// runner (Python, stub model) against it, with this script playing the Outlayer price oracle.
//
//   bun run e2e
//
// Needs, once:
//   - cargo-near: the wasm is built here with `cargo near build non-reproducible-wasm` (E2E_SKIP_BUILD=1 reuses
//     arena/target/near/nearbuddy_arena.wasm).
//   - a near-sandbox binary: NEAR_SANDBOX_BIN_PATH, else ~/.near/near-sandbox-*/near-sandbox, else the copy the
//     near-sandbox crate downloads into arena/target/debug/build/near-sandbox-*/out/.near/ the first time
//     `cd arena && cargo test --test test_arena_sandbox -- --ignored` runs.
//   - the runner venv: E2E_PYTHON, else agents/.venv/bin/python (see README), else python3 with requirements.txt.
//   - internet for the runner's Coinbase spot price and the solver's dry 1Click quote, unless E2E_OFFLINE=1: then
//     a local stand-in serves both (NEARBUDDY_COINBASE_URL for the runner, ONECLICK_URL for the solver) and the
//     follower check requires a quote. CI (.github/workflows/e2e-nightly.yml) runs offline; local runs stay live.
// Not in the per-push CI (sandbox download, ~4 minutes): nightly and on demand. Everything it writes goes to a temp dir printed at the start; the
// runner's dataset goes there through NEARBUDDY_DATA.
//
// Scenarios:
//   1. commit-reveal duel: owner turns commit-reveal on, the runner plays one duel with two stub agents, the oracle
//      stand-in answers open and close, the duel resolves. Checks commit events per committed row, one reveal per
//      agent (every other commitment replaced), the revealed intents scored, no no-reveal flags, the outcome, and
//      that EVERY reveal lands inside the intent lock (after the last moment the opponent could still commit).
//   2. SIGTERM mid-duel: the runner is killed after its second commit round; its held commitments must still be
//      revealed, and the duel resolves with no no-reveal flag. Stub A and B take opposite sides, so this duel is
//      decided: the loser's bond is slashed and the winner is paid the pool.
//   3. follower fill (deploy 15): two enclave agents (this script plays the enclave signer), a follower with a
//      mandate on one whose price floor comes from a quote, commit + reveal with a TeeProof through the solver, then
//      POST /settle_follow: the solver credits the output to the arena on the intents stub (stub_credit) and settles
//      against that balance. Checks the dry-quote refusal, the holding credited, the replay refusal and
//      withdraw_token of the holding to the follower's stub balance.
//   0. duplicate broadcast (runs first, own account): one signed transfer sent twice with identical bytes, as
//      sendFailover does when an endpoint times out after the broadcast, while the first copy is in flight and again
//      once it is final. The node must answer with the transaction's own outcome, never InvalidNonce (which
//      near-api-js would answer by re-signing: a second transfer).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Account, actions, JsonRpcProvider, KeyPairEd25519, type KeyPairString } from "near-api-js";
import { b64 } from "../packages/protocol/src/index.ts";
import {
  commitMessage,
  commitment,
  type Intent,
  proofHash,
  signIntent,
  teeText,
} from "../packages/protocol/src/intent.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const ARENA_DIR = join(ROOT, "arena");
const WASM = join(ARENA_DIR, "target/near/nearbuddy_arena.wasm");
const STUB_DIR = join(ROOT, "intents-stub");
const STUB_WASM = join(STUB_DIR, "target/near/nearbuddy_intents_stub.wasm");
const TMP = mkdtempSync(join(tmpdir(), "nearbuddy-e2e-"));
const NEAR = 10n ** 24n;
const MILLI = 10n ** 21n;
const S = 1_000_000_000n;
const OPEN_PX = 366_000_000n; // 3.66 USD, 8 decimals
const CLOSE_PX = 367_830_000n; // +0.5%
const MIN_DUEL_S = 20;
const LOCK_S = 10; // the most set_oracle allows for a 20 s floor; the final reveal must land inside it
const ORACLE_DEPOSIT = 20n * MILLI;
const FEE_BPS = 50n;
const OFFLINE = process.env.E2E_OFFLINE === "1";
const SPOT_CENTS = 366n;
const WNEAR = "nep141:wrap.near";

/** USDC base units (6 dp) for `yocto` wNEAR at `centsPerNear`, and back: the conversion a quote must agree with. */
const usdcForYocto = (yocto: bigint, centsPerNear = SPOT_CENTS) => (yocto * centsPerNear) / 100n / 10n ** 18n;
const yoctoForUsdc = (usdc: bigint, centsPerNear = SPOT_CENTS) => (usdc * 100n * 10n ** 18n) / centsPerNear;

/** E2E_OFFLINE stand-in for the two third parties: Coinbase spot (GET /v2/prices/<BASE>-USD/spot) and the 1Click
 *  dry quote (POST /v0/quote at SPOT_CENTS per NEAR). `amount` is the fixed leg: the origin for EXACT_INPUT (a Short
 *  sells exactly that much wNEAR), the destination for EXACT_OUTPUT (a Long buys exactly that much wNEAR). */
function offlineThirdParties(): Promise<string> {
  const decimals = (asset: string) => (asset === WNEAR ? 24 : 6);
  const fmt = (raw: bigint, d: number) => (Number(raw) / 10 ** d).toString();
  let spotReads = 0;
  const convert = (amount: bigint, from: string) => (from === WNEAR ? usdcForYocto(amount) : yoctoForUsdc(amount));
  const usd = (amount: bigint, asset: string) =>
    (Number(asset === WNEAR ? usdcForYocto(amount) : amount) / 1e6).toFixed(4);
  const srv = httpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code: number, v: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (req.method === "GET" && /^\/v2\/prices\/[A-Z]+-USD\/spot$/.test(req.url ?? ""))
        // the tape alternates 3.68 / 3.69: the stub models (agents/nearai.py, hash of the prompt) flip their call on
        // each new brief, so commit-reveal replaces commitments on chain instead of only keeping them
        return send(200, {
          data: { amount: (spotReads++ % 2 ? 3.69 : 3.68).toFixed(4), base: "NEAR", currency: "USD" },
        });
      if (req.method === "POST" && req.url === "/v0/quote") {
        const q = JSON.parse(body) as {
          swapType: string;
          amount: string;
          originAsset: string;
          destinationAsset: string;
          deadline: string;
        };
        const exactOut = q.swapType === "EXACT_OUTPUT";
        const fixed = BigInt(q.amount);
        const amountIn = exactOut ? convert(fixed, q.destinationAsset) : fixed;
        const out = exactOut ? fixed : convert(fixed, q.originAsset);
        const [din, dout] = [decimals(q.originAsset), decimals(q.destinationAsset)];
        const now = new Date().toISOString();
        return send(200, {
          timestamp: now,
          signature: "e2e-offline",
          quoteRequest: q,
          quote: {
            amountIn: amountIn.toString(),
            amountInFormatted: fmt(amountIn, din),
            amountInUsd: usd(amountIn, q.originAsset),
            minAmountIn: amountIn.toString(),
            amountOut: out.toString(),
            amountOutFormatted: fmt(out, dout),
            amountOutUsd: usd(out, q.destinationAsset),
            minAmountOut: ((out * 99n) / 100n).toString(),
            timeEstimate: 10,
            deadline: q.deadline,
            timestamp: now,
          },
        });
      }
      send(404, { error: `offline stand-in has no ${req.method} ${req.url}` });
    });
  });
  return new Promise((ok) =>
    srv.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(srv.address() as { port: number }).port}`)),
  );
}

// biome-ignore lint/suspicious/noExplicitAny: RPC and solver JSON are read untyped; the checks below are the schema
type J = any;
type Row = { scenario: string; check: string; ok: boolean; detail: string };
const results: Row[] = [];
function check(scenario: string, name: string, ok: boolean, detail = "") {
  results.push({ scenario, check: name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} [${scenario}] ${name}${detail ? `: ${detail}` : ""}`);
}
const log = (m: string) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- processes ----------------------------------------------------------------------------------
const children: ChildProcess[] = [];
function cleanup() {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

/** Spawn with stdout+stderr teed to a log file and kept in memory, so a scenario can wait for a line. */
function start(name: string, cmd: string, args: string[], env: Record<string, string> = {}, cwd = ROOT) {
  const file = join(TMP, `${name}.log`);
  const lines: string[] = [];
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(p);
  let buf = "";
  const onData = (d: Buffer) => {
    writeFileSync(file, d, { flag: "a" });
    buf += d.toString();
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const l of parts) {
      lines.push(l);
      if (process.env.E2E_VERBOSE) console.log(`  [${name}] ${l}`);
    }
  };
  p.stdout?.on("data", onData);
  p.stderr?.on("data", onData);
  const exited = new Promise<number | null>((r) => p.on("exit", (code, sig) => r(code ?? (sig ? 128 : null))));
  return { p, lines, exited, file };
}

async function until<T>(
  what: string,
  f: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs: number,
  everyMs = 500,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${String(last).slice(0, 200)})` : ""}`);
}

// ---- chain --------------------------------------------------------------------------------------
let RPC = "";
async function rpc<T = J>(method: string, params: unknown): Promise<T> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: T; error?: unknown };
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result as T;
}
let ARENA = "";
async function view<T = J>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return viewAt<T>(ARENA, method, args);
}
async function viewAt<T = J>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "optimistic", // txs return at EXECUTED_OPTIMISTIC; a final read lags them by a couple of blocks
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString()) as T;
}
const chainNow = async () => BigInt((await rpc<J>("block", { finality: "final" })).header.timestamp_nanosec);

type Tx = { hash: string; value: J; logs: string[] };
async function call(acct: Account, method: string, args: Record<string, unknown>, deposit = 0n): Promise<Tx> {
  const r = (await acct.callFunctionRaw({
    contractId: ARENA,
    methodName: method,
    args,
    deposit,
    gas: 300n * 10n ** 12n,
  })) as J;
  const raw = Buffer.from(r.status.SuccessValue ?? "", "base64").toString();
  const logs = r.receipts_outcome.flatMap((o: J) => o.outcome.logs as string[]);
  return { hash: r.transaction.hash, value: raw ? JSON.parse(raw) : null, logs };
}
/** EVENT_JSON logs of a landed transaction, every receipt included. */
async function txEvents(hash: string, sender: string): Promise<J[]> {
  const r = await rpc<J>("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
  return events(r.receipts_outcome.flatMap((o: J) => o.outcome.logs as string[]));
}
/** Chain time of the block of the transaction's successful arena receipt (the block_timestamp the contract compared
 *  with the lock), or null when no arena receipt succeeded. */
async function arenaReceiptTime(hash: string, sender: string): Promise<bigint | null> {
  const r = await rpc<J>("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
  const o = (r.receipts_outcome as J[]).find(
    (x) =>
      x.outcome.executor_id === ARENA && ("SuccessValue" in x.outcome.status || "SuccessReceiptId" in x.outcome.status),
  );
  return o ? BigInt((await rpc<J>("block", { block_id: o.block_hash })).header.timestamp_nanosec) : null;
}
const events = (logs: string[]) =>
  logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice("EVENT_JSON:".length)));

// ---- the oracle stand-in ------------------------------------------------------------------------
/** Plays Outlayer: scans every new block's chunks for an `oracle_call` receipt to the oracle account and answers
 *  `oracle_on_call` with a fixed open price and a +0.5% close price, stamped with the latest block time. */
class Oracle {
  answered = new Map<string, Tx>(); // msg -> answer tx
  errors: string[] = [];
  private height = 0;
  private stop = false;
  constructor(private readonly acct: Account) {}
  async run() {
    this.height = (await rpc<J>("block", { finality: "final" })).header.height;
    while (!this.stop) {
      try {
        const tip = (await rpc<J>("block", { finality: "final" })).header.height as number;
        for (let h = this.height + 1; h <= tip; h++) {
          let block: J;
          try {
            block = await rpc("block", { block_id: h });
          } catch {
            continue; // skipped height
          }
          for (const ch of block.chunks) {
            if (ch.height_included !== h) continue;
            const chunk = await rpc<J>("chunk", { chunk_id: ch.chunk_hash });
            for (const rc of chunk.receipts) {
              if (rc.receiver_id !== this.acct.accountId || !rc.receipt?.Action) continue;
              for (const a of rc.receipt.Action.actions) {
                if (a.FunctionCall?.method_name !== "oracle_call") continue;
                const args = JSON.parse(Buffer.from(a.FunctionCall.args, "base64").toString());
                await this.answer(rc.predecessor_id, args.msg, args.asset_ids?.[0] ?? "wrap.near");
              }
            }
          }
          this.height = h;
        }
      } catch (e) {
        this.errors.push(String(e).slice(0, 200));
      }
      await sleep(400);
    }
  }
  private async answer(sender: string, msg: string, asset: string) {
    const ts = await chainNow();
    const px = msg.startsWith("open:") ? OPEN_PX : CLOSE_PX;
    const data = {
      timestamp: ts.toString(),
      recency_duration_sec: 300,
      prices: [{ asset_id: asset, price: { multiplier: px.toString(), decimals: 8 } }],
    };
    try {
      const tx = await call(this.acct, "oracle_on_call", { sender_id: sender, data, msg });
      this.answered.set(msg, tx);
      log(`oracle answered ${msg} at ${px} (${tx.hash})`);
    } catch (e) {
      this.errors.push(`${msg}: ${String(e).slice(0, 200)}`);
      log(`oracle answer ${msg} failed: ${String(e).slice(0, 160)}`);
    }
  }
  halt() {
    this.stop = true;
  }
}

/** NEAR/USD in cents from Coinbase spot (the live run's reference for the 1Click quote), or 0n when unreachable. */
async function liveSpotCents(): Promise<bigint> {
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/NEAR-USD/spot", { signal: AbortSignal.timeout(5000) });
    return BigInt(Math.round(Number(((await r.json()) as { data: { amount: string } }).data.amount) * 100));
  } catch {
    return 0n;
  }
}

// ---- setup helpers ------------------------------------------------------------------------------
function sandboxBin(): string {
  if (process.env.NEAR_SANDBOX_BIN_PATH) return process.env.NEAR_SANDBOX_BIN_PATH;
  const sub = (dir: string, prefix: string) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((d) => d.startsWith(prefix))
          .map((d) => join(dir, d))
      : [];
  const build = join(ARENA_DIR, "target/debug/build");
  const found = [join(process.env.HOME ?? "", ".near"), ...sub(build, "near-sandbox-").map((d) => join(d, "out/.near"))]
    .flatMap((d) => sub(d, "near-sandbox-"))
    .map((d) => join(d, "near-sandbox"))
    .filter(existsSync);
  if (!found.length)
    throw new Error(
      "near-sandbox binary not found: set NEAR_SANDBOX_BIN_PATH, or run `cd arena && cargo test --test test_arena_sandbox -- --ignored` once",
    );
  return found.sort().at(-1)!;
}

function python(): string {
  if (process.env.E2E_PYTHON) return process.env.E2E_PYTHON;
  const venv = join(ROOT, "agents/.venv/bin/python");
  return existsSync(venv) ? venv : "python3";
}

type Row0 = Record<string, J>;
const readRows = (file: string): Row0[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** Signed bps the contract scores for one intent: sign * (close - open) * size / open, truncated like i128 `/`. */
function pnl(intent: { side: string; size_bps: number } | null, open: bigint, close: bigint): number {
  if (!intent) return 0;
  const sign = intent.side === "Long" ? 1n : -1n;
  return Number((sign * (close - open) * BigInt(intent.size_bps)) / open);
}

// ---- main ---------------------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  log(`temp dir ${TMP}`);
  if (!process.env.E2E_SKIP_BUILD) {
    for (const dir of [ARENA_DIR, STUB_DIR]) {
      log(`building  (cargo near build non-reproducible-wasm)`);
      const b = spawnSync("cargo", ["near", "build", "non-reproducible-wasm"], { cwd: dir, stdio: "inherit" });
      if (b.status !== 0) throw new Error(`cargo near build failed in `);
    }
  }
  const wasm = readFileSync(WASM);
  const stubWasm = readFileSync(STUB_WASM);

  // 1. sandbox
  const bin = sandboxBin();
  const home = join(TMP, "sandbox");
  const init = spawnSync(bin, ["--home", home, "init"], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`sandbox init failed: ${init.stderr.slice(-400)}`);
  // the genesis validator is test.near; every id ending in .near names mainnet to the network guard (config.py,
  // network.ts), so it becomes sandbox.testnet and every account below a subaccount of it
  for (const f of ["genesis.json", "validator_key.json"]) {
    const path = join(home, f);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll('"test.near"', '"sandbox.testnet"'));
  }
  const [rpcPort, netPort] = [await freePort(), await freePort()];
  RPC = `http://127.0.0.1:${rpcPort}`;
  start("sandbox", bin, [
    "--home",
    home,
    "run",
    "--rpc-addr",
    `127.0.0.1:${rpcPort}`,
    "--network-addr",
    `127.0.0.1:${netPort}`,
  ]);
  await until("sandbox RPC", async () => (await rpc<J>("status", [])).sync_info.latest_block_height > 2, 60_000);
  log(`near-sandbox ${bin} on ${RPC}`);

  // 2. accounts, all on the genesis key
  const vk = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8")) as {
    account_id: string;
    public_key: string;
    secret_key: KeyPairString;
  };
  const provider = new JsonRpcProvider({ url: RPC });
  const root = new Account(vk.account_id, provider, vk.secret_key);
  const id = (n: string) => `${n}.${vk.account_id}`;
  for (const [n, near] of [
    ["arena", 50n],
    ["owner", 100n],
    ["oracle", 20n],
    ["follower", 20n],
    ["intents", 10n],
    ["dup", 5n],
  ] as const)
    await root.createSubAccount({ accountOrPrefix: id(n), publicKey: vk.public_key, nearToTransfer: near * NEAR });
  const acct = (n: string) => new Account(id(n), provider, vk.secret_key);
  const [arena, owner, oracleAcct, follower, intents] = ["arena", "owner", "oracle", "follower", "intents"].map(
    acct,
  ) as [Account, Account, Account, Account, Account];
  ARENA = id("arena");
  const INTENTS = intents.accountId; // the intents.near stand-in: mt_batch_balance_of, mt_transfer, stub_credit
  await intents.deployContract(new Uint8Array(stubWasm));

  // 3. deploy + init + config (all owner calls happen before the solver starts: it shares the owner key)
  await arena.deployContract(new Uint8Array(wasm));
  await call(arena, "init", {
    owner: owner.accountId,
    oracle_account: oracleAcct.accountId,
    oracle_deposit: ORACLE_DEPOSIT.toString(),
    slash_bps: 1000,
    fee_bps: Number(FEE_BPS),
    min_chaos_deposit: (100n * MILLI).toString(),
    intents_account: INTENTS,
    max_vault_total: (1000n * NEAR).toString(),
  });
  // deploy 15: owner calls take exactly 1 yoctoNEAR
  await call(owner, "add_solver", { account_id: owner.accountId }, 1n);
  await call(
    owner,
    "set_oracle",
    {
      oracle_account: oracleAcct.accountId,
      oracle_deposit: ORACLE_DEPOSIT.toString(),
      min_duel_s: MIN_DUEL_S,
      intent_lock_s: LOCK_S,
    },
    1n,
  );
  await call(owner, "set_commit_reveal", { enabled: true, no_reveal_bps: 1000 }, 1n);
  const enclave = KeyPairEd25519.fromRandom();
  const enclavePk = b64.enc(enclave.getPublicKey().data);
  await call(owner, "add_tee_signer", { signer: enclavePk, label: "e2e enclave stand-in" }, 1n);
  const cfg = await view("get_config");
  log(
    `arena ${ARENA} deployed: commit_reveal ${cfg.commit_reveal}, min_duel_s ${cfg.min_duel_s}, lock ${cfg.intent_lock_s}s`,
  );

  const oracle = new Oracle(oracleAcct);
  void oracle.run();

  // 4. solver
  const offline = OFFLINE ? await offlineThirdParties() : "";
  if (offline) log(`E2E_OFFLINE: Coinbase spot and 1Click quotes from ${offline}`);
  const solverPort = await freePort();
  const SOLVER_URL = `http://127.0.0.1:${solverPort}`;
  const SECRET = randomBytes(16).toString("hex");
  const chainEnv = {
    NEAR_RPC: RPC,
    NEAR_SEND_RPC: RPC,
    NEAR_RPC_FALLBACK: RPC,
    ARENA_CONTRACT: ARENA,
    ARENA_SECRET: SECRET,
    SOLVER_ID: owner.accountId,
  };
  const solver = start("solver", "bun", ["packages/solver/src/index.ts"], {
    ...chainEnv,
    NEARBUDDY_CONTRACT: ARENA, // clearinghouse routes are unused here; keep every read on the sandbox
    [`NEAR_KEY_${owner.accountId.replace(/[.-]/g, "_").toUpperCase()}`]: vk.secret_key,
    SOLVER_PORT: String(solverPort),
    SOLVER_LEDGER: join(TMP, "solver-ledger.json"),
    ARENA_PAYLOADS: join(TMP, "arena-payloads.json"),
    ARENA_HISTORY: join(TMP, "arena-history.json"),
    PAIR_EVERY_S: "0",
    FOLLOWERS: follower.accountId, // deploy 15 has no list_followers: the solver reads this follower's mandate
    ...(offline ? { ONECLICK_URL: offline } : {}),
  });
  await until("solver", async () => (await fetch(`${SOLVER_URL}/pairing`)).ok, 30_000);
  log(`solver on ${SOLVER_URL}`);
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${SOLVER_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-arena-key": SECRET },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as J;
    if (!r.ok) throw new Error(`${path} ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  };

  const runnerEnv = (data: string) => ({
    ...chainEnv,
    SOLVER_URL,
    NEAR_AI_API_KEY: "", // stub model, non-TEE agents
    AGENT_SEED_A: "", // fresh random agent keys, whatever the env file holds
    AGENT_SEED_B: "",
    AGENT_KEY_A: "",
    AGENT_KEY_B: "",
    NEARBUDDY_DATA: data, // never the real agents/data/decisions.jsonl
    PYTHONUNBUFFERED: "1",
    ...(offline ? { NEARBUDDY_COINBASE_URL: offline, PYTH_API_KEY: "" } : {}),
  });
  // `--commit-reveal` first: night-loop.sh and second-loop.sh treat any `agents/runner.py --rounds` (or
  // `--pair-tag p2 --rounds`) process as a rival driver and wait it out, so this runner must never match them
  const runnerArgs = (duelS: number) => [
    join(ROOT, "agents/runner.py"),
    "--commit-reveal",
    "--rounds",
    "1",
    "--duel-seconds",
    String(duelS),
    "--cycle-seconds",
    "6",
  ];

  /** Asserts shared by scenarios 1 and 2: every committed row was committed then revealed on chain, the duel's
   *  scored intents are the last revealed ones, no no-reveal flag, the outcome matches the oracle prices. */
  async function checkDuel(sc: string, duelId: string, rows: Row0[], resolveTx: Tx | undefined, lockReveal = false) {
    const mine = rows.filter((r) => String(r.duel_id) === duelId);
    // the contract keeps one commitment per agent: every committed row is either the one revealed or replaced by a
    // later commit; an unchanged call keeps the held commitment and commits nothing
    const committed = mine.filter((r) => r.commitment);
    const accounted = committed.filter((r) => r.committed_tx && (r.revealed_tx || r.replaced_by));
    const revealed = committed.filter((r) => r.committed_tx && r.revealed_tx);
    const agents = [...new Set(committed.map((r) => r.agent_pk as string))];
    const onePerAgent = agents.every((pk) => revealed.filter((r) => r.agent_pk === pk).length === 1);
    check(
      sc,
      "dataset: every commitment revealed or replaced, one reveal per agent",
      committed.length >= 2 && accounted.length === committed.length && agents.length === 2 && onePerAgent,
      `${committed.length} committed (${revealed.length} revealed, ${committed.length - revealed.length} replaced), ` +
        `${mine.filter((r) => r.kept_commitment).length} kept, errors: ${JSON.stringify(mine.filter((r) => r.error).map((r) => r.error))}`,
    );
    let commitsOk = 0,
      revealsOk = 0;
    for (const r of accounted) {
      const ce = await txEvents(r.committed_tx, owner.accountId);
      if (ce.some((e) => e.event === "commit" && e.data.agent_pk === r.agent_pk && e.data.commitment === r.commitment))
        commitsOk++;
    }
    for (const r of revealed) {
      const re = await txEvents(r.revealed_tx, owner.accountId);
      if (
        re.some(
          (e) => e.event === "intent" && e.data.agent_pk === r.agent_pk && String(e.data.nonce) === r.intent.nonce,
        )
      )
        revealsOk++;
    }
    check(
      sc,
      "commit event on chain for every committed row",
      commitsOk === accounted.length && commitsOk > 0,
      `${commitsOk}/${accounted.length}`,
    );
    check(
      sc,
      "intent (reveal) event on chain for every revealed row",
      revealsOk === revealed.length && revealsOk > 0,
      `${revealsOk}/${revealed.length}`,
    );

    const d = await view("get_duel", { duel_id: duelId });
    const lastOf = (pk: string) =>
      revealed
        .filter((r) => r.agent_pk === pk)
        .sort((x, y) => Number(BigInt(y.intent.nonce) - BigInt(x.intent.nonce)))[0]?.intent;
    const la = lastOf(d.a),
      lb = lastOf(d.b);
    check(
      sc,
      "scored intents are the last revealed ones",
      d.last_intent_a?.nonce === la?.nonce && d.last_intent_b?.nonce === lb?.nonce && !!la && !!lb,
      `chain a=${d.last_intent_a?.nonce} b=${d.last_intent_b?.nonce}, dataset a=${la?.nonce} b=${lb?.nonce}`,
    );
    const o = d.outcome;
    const ea = pnl(d.last_intent_a, OPEN_PX, CLOSE_PX),
      eb = pnl(d.last_intent_b, OPEN_PX, CLOSE_PX);
    check(
      sc,
      "outcome recorded at the oracle prices, pnl from the revealed sides",
      d.resolved &&
        !!o &&
        o.open_price === OPEN_PX.toString() &&
        o.close_price === CLOSE_PX.toString() &&
        o.pnl_a === ea &&
        o.pnl_b === eb &&
        o.winner === (ea === eb ? null : ea > eb ? d.a : d.b),
      o
        ? `open ${o.open_price} close ${o.close_price} pnl_a ${o.pnl_a} (want ${ea}) pnl_b ${o.pnl_b} (want ${eb}) winner ${String(o.winner).slice(0, 8)}`
        : "no outcome",
    );
    const nr = await view<[boolean, boolean]>("get_no_reveal", { duel_id: duelId });
    const resolveEvents = resolveTx ? events(resolveTx.logs) : [];
    check(
      sc,
      "no no-reveal flags",
      !nr[0] &&
        !nr[1] &&
        !resolveEvents.some((e) => e.event === "no_reveal") &&
        resolveEvents.some((e) => e.event === "resolve"),
      `get_no_reveal ${JSON.stringify(nr)}, resolve tx events ${resolveEvents.map((e) => e.event).join(",") || "none"}`,
    );
    if (lockReveal) {
      // commit-reveal only hides a call if it opens after the last moment the opponent can still commit: EVERY
      // reveal, timed at its arena receipt (where the contract checks the lock), not only the scored one
      const lockAt = BigInt(d.close_at) - BigInt(LOCK_S) * S;
      const early: string[] = [];
      for (const r of revealed) {
        const t = await arenaReceiptTime(r.revealed_tx, owner.accountId);
        if (t === null || t < lockAt)
          early.push(
            `nonce ${r.intent.nonce} ${t === null ? "untimed" : `${Number((lockAt - t) / 1_000_000n) / 1000} s before the lock`}`,
          );
      }
      if (OFFLINE)
        check(
          sc,
          "a changed call replaced the held commitment on chain",
          committed.some((r) => r.replaced_by),
          `${committed.filter((r) => r.replaced_by).length} replaced`,
        );
      check(
        sc,
        "every reveal lands inside the intent lock",
        early.length === 0 && revealed.length > 0,
        early.join(", ") || `all ${revealed.length} inside`,
      );
    }
  }

  // ---- scenario 0: the same signed tx broadcast twice ---------------------------------------------
  {
    const sc = "0 duplicate broadcast";
    const dup = acct("dup");
    const signed = await dup.createSignedTransaction({ receiverId: dup.accountId, actions: [actions.transfer(1n)] });
    const send = (w: "NONE" | "FINAL") =>
      provider.sendTransactionUntil(signed, w).then(
        (r) => ({ hash: r.transaction?.hash ?? "", status: r.status, error: "" }),
        (e: Error) => ({ hash: "", status: undefined, error: `${e.name}: ${e.message}` }),
      );
    const first = await send("NONE"); // broadcast, no wait: the endpoint "timed out" after taking it
    const inFlight = await send("FINAL"); // the failover's resend, identical bytes
    check(
      sc,
      "resending an in-flight tx returns its outcome, not InvalidNonce",
      !first.error && !inFlight.error && inFlight.hash !== "",
      inFlight.error ||
        `first ${first.error || "accepted"}, resend ${inFlight.hash} ${JSON.stringify(inFlight.status)}`,
    );
    const late = await send("FINAL"); // and once more after it is final
    check(
      sc,
      "resending an executed tx returns its outcome, not InvalidNonce",
      !late.error && late.hash === inFlight.hash,
      late.error || `${late.hash} ${JSON.stringify(late.status)}`,
    );
  }

  // ---- scenario 1: one commit-reveal duel ---------------------------------------------------------
  {
    const sc = "1 commit-reveal";
    log(`${sc}: runner, one 60 s duel, 6 s cycles`);
    const data = join(TMP, "decisions-1.jsonl");
    const r = start("runner-1", python(), runnerArgs(60), runnerEnv(data));
    // the live loops' rival checks, taken from the scripts so a change there shows up here
    const rivals = [
      [/pgrep -f '([^']+)'/, "scripts/night-loop.sh"],
      [/pgrep -f "([^"]+)"/, "scripts/second-loop.sh"],
    ].map(([re, f]) => (re as RegExp).exec(readFileSync(join(ROOT, f as string), "utf8"))?.[1]?.replace("$PAIR", "p2"));
    try {
      await until("the runner's first commit", () => r.lines.some((l) => l.includes("committed nonce")), 90_000, 200);
      const seen = rivals.map((pat) =>
        pat
          ? spawnSync("pgrep", ["-f", pat], { encoding: "utf8" }).stdout.split(/\s+/).includes(String(r.p.pid))
          : true,
      );
      check(
        sc,
        "runner invisible to the live loops' rival pgrep",
        rivals.every(Boolean) && !seen.some(Boolean),
        `pid ${r.p.pid} vs ${rivals.map((x) => x ?? "pattern not found").join(" ; ")}`,
      );
    } catch (e) {
      check(sc, "runner invisible to the live loops' rival pgrep", false, String(e).slice(0, 160));
    }
    const code = await Promise.race([r.exited, sleep(240_000).then(() => "timeout" as const)]);
    check(sc, "runner exits 0", code === 0, `exit ${code}, log ${r.file}`);
    const duelId = r.lines.map((l) => /\[round 0\] duel (\d+)/.exec(l)?.[1]).find(Boolean);
    if (!duelId) check(sc, "runner opened a duel", false, r.lines.slice(-5).join(" | "));
    else {
      check(
        sc,
        "commit-reveal on in the runner",
        r.lines.some((l) => l.includes("commit-reveal on")),
      );
      await checkDuel(sc, duelId, readRows(data), oracle.answered.get(`close:${duelId}`), true);
    }
  }

  // ---- scenario 2: SIGTERM mid-duel ----------------------------------------------------------------
  {
    const sc = "2 sigterm";
    log(`${sc}: runner killed after its second commit round`);
    const data = join(TMP, "decisions-2.jsonl");
    const r = start("runner-2", python(), runnerArgs(60), runnerEnv(data));
    const commitsOf = (who: string) =>
      r.lines.filter((l) => l.includes(`  ${who} committed nonce`) || l.includes(`  ${who} keeps its commitment`))
        .length;
    let killedAt = 0;
    try {
      await until("second B commit", () => commitsOf("B") >= 2, 120_000, 200);
      r.p.kill("SIGTERM");
      killedAt = r.lines.length;
      log(`${sc}: SIGTERM sent`);
    } catch (e) {
      check(sc, "runner reached its second commit round", false, String(e).slice(0, 200));
    }
    const code = await Promise.race([r.exited, sleep(60_000).then(() => "timeout" as const)]);
    const duelId = r.lines.map((l) => /\[round 0\] duel (\d+)/.exec(l)?.[1]).find(Boolean);
    if (killedAt && duelId) {
      const afterKill = r.lines.slice(killedAt);
      const revealed = ["A", "B"].filter((w) => afterKill.some((l) => l.includes(`  ${w} revealed`)));
      check(sc, "runner exits on SIGTERM (143)", code === 143, `exit ${code}, log ${r.file}`);
      check(
        sc,
        "held commitments revealed after SIGTERM",
        revealed.length === 2,
        `revealed after kill: ${revealed.join(",") || "none"}`,
      );
      const d = await view("get_duel", { duel_id: duelId });
      const closeAt = BigInt(d.close_at);
      log(`${sc}: waiting for close_at, then resolving duel ${duelId} through the solver`);
      await until("chain clock past close_at", async () => (await chainNow()) >= closeAt + 2n * S, 120_000, 1000);
      const bond = async (pk: string) => BigInt((await view("get_agent", { agent_pk: pk })).bond);
      const before = { a: await bond(d.a), b: await bond(d.b) };
      await post("/resolve", { duel_id: duelId });
      const o = await until("outcome", async () => (await view("get_duel", { duel_id: duelId })).outcome, 60_000, 1000);
      await checkDuel(sc, duelId, readRows(data), oracle.answered.get(`close:${duelId}`));
      // stub A and B take opposite sides, so the duel is decided: the loser pays slash_bps of its bond into the
      // pool and the winner takes the pool (no chaos here, so the pool is exactly the slash)
      const after = { a: await bond(d.a), b: await bond(d.b) };
      const [w, l] = o.winner === d.a ? (["a", "b"] as const) : (["b", "a"] as const);
      const slashed = (before[l] * 1000n) / 10_000n;
      check(
        sc,
        "decided duel: loser slashed 10%, winner paid the pool",
        o.winner !== null &&
          o.slashed === slashed.toString() &&
          after[l] === before[l] - slashed &&
          after[w] === before[w] + slashed,
        `winner ${w.toUpperCase()} slashed ${o.slashed} (want ${slashed}); ${l.toUpperCase()} ${before[l]} -> ${after[l]}, ${w.toUpperCase()} ${before[w]} -> ${after[w]}`,
      );
    } else if (duelId) check(sc, "runner opened a duel", true, duelId);
    else check(sc, "runner opened a duel", false, r.lines.slice(-5).join(" | "));
  }

  // ---- scenario 3: follower mandate filled through settle_follow (deploy 15) -----------------------
  {
    const sc = "3 follower fill";
    log(`${sc}: two enclave agents, a follower on one, commit + reveal with a TeeProof, verified settle_follow`);
    const MODEL = "e2e/enclave-model";
    const [t1, t2] = [KeyPairEd25519.fromRandom(), KeyPairEd25519.fromRandom()];
    const pk = (k: KeyPairEd25519) => b64.enc(k.getPublicKey().data);
    // deploy 15 binds the contract id into the register bytes: sign what the contract says it verifies
    const regMsg = new Uint8Array(
      Buffer.from(await view<string>("register_message", { owner: owner.accountId }), "base64"),
    );
    for (const k of [t1, t2])
      await post("/register", {
        agent_pk: pk(k),
        model_id: MODEL,
        bond: (500n * MILLI).toString(),
        tee: true,
        register_sig: b64.enc(k.sign(regMsg).signature),
      });
    const cap = 200n * MILLI;
    // the mandate's price floor: 95% of a quote for the cap (the stand-in offline, 1Click live)
    if (offline) process.env.ONECLICK_URL = offline;
    const { quote, sellNearForUsdc, USDC_NEAR } = await import("../packages/solver/src/oneclick.ts");
    const { priceFloor } = await import("../packages/protocol/src/chain.ts");
    let floor = 1n;
    try {
      const fq = await quote(sellNearForUsdc(cap, owner.accountId.replace(/\.testnet$/, ".near")));
      floor = priceFloor(cap, BigInt(fq.quote.amountOut));
    } catch (e) {
      log(`${sc}: no quote for the floor (${String(e).slice(0, 80)}); floor 1`);
    }
    await call(follower, "deposit", {}, 2n * NEAR);
    const vault0 = BigInt(await view<string>("get_vault", { account: follower.accountId }));
    const now = await chainNow();
    await call(follower, "follow", {
      agent_pk: pk(t1),
      mandate: {
        allowance: NEAR.toString(),
        spent: "0",
        per_tx_cap: cap.toString(),
        allowed_tokens: [],
        expires_at: (now + 3600n * S).toString(),
        revoked: false,
        min_out_per_near: floor.toString(),
      },
    });
    const vault1 = BigInt(await view<string>("get_vault", { account: follower.accountId }));
    const closeAt = BigInt(Date.now()) * 1_000_000n + 40n * S;
    const duel = await post("/duel", { a: pk(t1), b: pk(t2), symbol: "wrap.near", close_at: closeAt.toString() });
    const duelId = String(duel.duel_id);
    await until("open price", async () => (await view("get_duel", { duel_id: duelId })).open_price, 30_000);
    const req = createHash("sha256").update("e2e request bytes").digest();
    const res = createHash("sha256").update("e2e response bytes").digest();
    // Short sells NEAR for USDC: the follower's output is USDC, priced by the floor above
    const intent: Intent = {
      agent_pk: pk(t1),
      duel_id: duelId,
      side: "Short",
      size_bps: 5000,
      nonce: "1",
      expires_at: (closeAt + 60n * S).toString(),
      proof_hash: proofHash(req, res),
    };
    const tee = {
      kind: 2 as const,
      request_hash: b64.enc(req),
      response_hash: b64.enc(res),
      signer: enclavePk,
      signature: b64.enc(enclave.sign(teeText(2, MODEL, req, res)).signature),
    };
    const salt = randomBytes(32);
    const c = commitment(intent, salt);
    await post("/commit", {
      duel_id: duelId,
      agent_pk: pk(t1),
      commitment: b64.enc(c),
      sig: b64.enc(t1.sign(commitMessage(ARENA, duelId, c)).signature),
    });
    const revealed = await post("/reveal", { signed: signIntent(t1, intent), salt: b64.enc(salt), tee });
    const q = (revealed.quotes ?? []).find((x: J) => x.follower === follower.accountId);
    check(
      sc,
      "follower quoted at reveal (from FOLLOWERS: deploy 15 has no list_followers)",
      !!q && (!OFFLINE || !!q.quote), // live, a 1Click outage still counts as quoted (the error is the entry)
      q
        ? q.quote
          ? `quote out ${q.quote_out} to ${q.recipient}`
          : `quote error: ${String(q.error).slice(0, 80)}`
        : JSON.stringify(revealed.quotes),
    );
    if (q?.quote) {
      // quote_out is the USDC leg in 6 dp whichever the side (paid on a Long, received on a Short): within 5% of
      // amount (yocto wNEAR) at the reference price, or a leg was read in the wrong unit
      const cents = OFFLINE ? SPOT_CENTS : await liveSpotCents();
      if (cents) {
        const want = usdcForYocto(BigInt(q.amount), cents);
        const got = BigInt(q.quote_out ?? "0");
        const off = got > want ? got - want : want - got;
        check(
          sc,
          "follower quote_out is the USDC leg at the spot price (within 5%)",
          want > 0n && off * 100n <= want * 5n,
          `${q.quote.quoteRequest?.swapType} quote_out ${got} USDC units, want ~${want} (${q.amount} yocto at ${cents} cents)`,
        );
      } else log(`${sc}: live spot price unavailable; quote_out plausibility not checked`);
    }
    check(
      sc,
      "the batched quote delivers to the arena",
      !q?.quote || q.recipient === ARENA.replace(/\.testnet$/, ".near"),
      `recipient ${q?.recipient}`,
    );
    const amountIn = q ? BigInt(q.amount) : cap;
    const amountOut = q?.quote_out ? BigInt(q.quote_out) : (amountIn * floor) / NEAR + 1n;
    const fill = (swap_tx: string) => ({
      intent_nonce: "1",
      token: USDC_NEAR,
      amount_in: amountIn.toString(),
      amount_out: amountOut.toString(),
      swap_tx,
    });
    // a dry quote is not a swap: refused before any chain call
    const dry = await post("/settle_follow", {
      agent_pk: pk(t1),
      follower: follower.accountId,
      fills: [fill("dry-quote:e2e")],
    }).catch((e) => String(e));
    check(
      sc,
      "a dry-quote fill is refused",
      typeof dry === "string" && dry.includes("400") && dry.includes("dry quote unsettleable"),
      String(dry).slice(0, 120),
    );
    // the swap: the solver credits amount_out to the arena on the stub, then settle_follow reads that balance
    const settled = await post("/settle_follow", { agent_pk: pk(t1), follower: follower.accountId, fills: [fill("")] });
    const vault2 = BigInt(await view<string>("get_vault", { account: follower.accountId }));
    const debit = amountIn + (amountIn * FEE_BPS) / 10_000n;
    check(
      sc,
      "settle_follow settles the fill against the arena's intents balance",
      settled.report?.settled === 1 &&
        settled.report.rejected.length === 0 &&
        settled.report.debited === debit.toString(),
      `report ${JSON.stringify(settled.report)} tx ${settled.tx}`,
    );
    check(
      sc,
      "follower vault debited amount_in + fee",
      vault1 - vault2 === debit,
      `vault ${vault0} -> ${vault1} (follow storage) -> ${vault2}`,
    );
    const holding = BigInt(await view<string>("get_holding", { follower: follower.accountId, token_id: USDC_NEAR }));
    const accounted = BigInt(await view<string>("get_accounted", { token_id: USDC_NEAR }));
    check(
      sc,
      "holding credited == amount_out, and accounted with it",
      holding === amountOut && accounted === amountOut,
      `holding ${holding} accounted ${accounted} amount_out ${amountOut}`,
    );
    const m = await view("get_follow", { agent_pk: pk(t1), follower: follower.accountId });
    check(sc, "mandate spent updated by the debit (fee inside)", m?.spent === debit.toString(), `spent ${m?.spent}`);
    const again = await post("/settle_follow", {
      agent_pk: pk(t1),
      follower: follower.accountId,
      fills: [fill("")],
    }).catch((e) => String(e));
    check(
      sc,
      "a replayed fill is refused (nothing settled: the transaction fails)",
      typeof again === "string" && again.includes("duplicate fill"),
      String(again).slice(0, 160),
    );
    // the follower takes the output to its own account on the stub
    const out = await call(follower, "withdraw_token", { token_id: USDC_NEAR, amount: holding.toString() }, 1n);
    const onStub = BigInt(
      await viewAt<string>(INTENTS, "mt_balance_of", { account_id: follower.accountId, token_id: USDC_NEAR }),
    );
    const left = BigInt(await view<string>("get_holding", { follower: follower.accountId, token_id: USDC_NEAR }));
    check(
      sc,
      "withdraw_token moves the holding to the follower's intents balance",
      out.value === true && onStub === holding && left === 0n,
      `returned ${out.value}, stub balance ${onStub}, holding left ${left}, tx ${out.hash}`,
    );
  }

  oracle.halt();
  check(
    "all",
    "oracle stand-in answered without errors",
    oracle.errors.length === 0,
    oracle.errors.join(" | ").slice(0, 300),
  );
  check("all", "solver stayed up", solver.p.exitCode === null, `log ${solver.file}`);
  log(`done in ${Math.round((Date.now() - t0) / 1000)} s, logs in ${TMP}`);
}

function table() {
  const w = [16, 66, 4];
  const line = (a: string, b: string, c: string, d = "") =>
    `${a.padEnd(w[0]!)} ${b.padEnd(w[1]!)} ${c.padEnd(w[2]!)} ${d}`;
  console.log(`\n${line("SCENARIO", "CHECK", "RES", "DETAIL")}`);
  console.log("-".repeat(140));
  for (const r of results) console.log(line(r.scenario, r.check, r.ok ? "PASS" : "FAIL", r.detail.slice(0, 160)));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}`);
  return failed;
}

main()
  .catch((e) => {
    check("setup", "run completed", false, String(e instanceof Error ? e.stack : e).slice(0, 400));
  })
  .finally(() => {
    const failed = table();
    cleanup();
    process.exit(failed || !results.length ? 1 : 0);
  });
