// Re-check one duel from public sources only, the way a stranger would: arena views (now, and at the blocks around
// the close callback), the duel's txs from FastNEAR's tx API, and the local dataset row of each scored intent when
// there is one. Prints PASS / FAIL / SKIP / INFO per line and exits 1 on any FAIL. Sends nothing, spends nothing.
//   bun run verify-duel 377
//   bun run verify-duel 377 --save analysis/fixtures/verify_duel_377.json   (keep the evidence, e.g. as a test fixture)
// A receipt counts only when its own outcome succeeded. The tx-level status is never read: FastNEAR reports success
// there for a tx whose arena receipt panicked (tx 4rmFo38n, "bad tee signature").
// Env: ARENA_CONTRACT, NEAR_NETWORK, VERIFY_RPC (views, also at past blocks; default the network's FastNEAR RPC),
// VERIFY_ARCHIVAL_RPC (past blocks the first one has dropped), FASTNEAR_TX_API, DECISIONS (comma-separated jsonl).
import "../packages/protocol/src/env.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { b64, hex } from "../packages/protocol/src/index.ts";
import {
  type Intent,
  intentMessage,
  proofHash,
  type TeeProof,
  teeText,
  verify,
} from "../packages/protocol/src/intent.ts";
import { NET, NETWORK_ID } from "../packages/protocol/src/network.ts";

// ---------------------------------------------------------------- the evidence (all public)

export type AgentView = { owner: string; pk: string; model_id: string; bond: string; tee: boolean };
export type Outcome = {
  open_price: string;
  close_price: string;
  pnl_a: number;
  pnl_b: number;
  winner: string | null;
  slashed: string;
  injections: number;
};
export type Duel = {
  id: string;
  a: string;
  b: string;
  symbol: string;
  open_at?: string;
  close_at: string;
  pool: string;
  injections: { kind: string; payload_hash: string; target: string; block: string }[];
  resolved: boolean;
  last_intent_a: Intent | null;
  last_intent_b: Intent | null;
  outcome: Outcome | null;
  open_price: string | null;
};
export type Config = { oracle_account: string; slash_bps: number; no_reveal_bps?: number; owner_fees: string };
/** Arena views at one point: now, or at a past block. */
export type State = {
  config: Config;
  duel: Duel | null;
  a: AgentView | null;
  b: AgentView | null;
  no_reveal: [boolean, boolean] | null; // get_no_reveal; null on a contract without it
};
/** The slice of a FastNEAR tx (POST /v0/transactions) read here. */
export type Tx = {
  transaction: { hash: string };
  receipts: {
    receipt: {
      predecessor_id: string;
      receiver_id: string;
      receipt: {
        Action?: {
          signer_id: string;
          actions: ({ FunctionCall?: { method_name: string; args: string; deposit: string } } | string)[];
        };
      };
    };
    execution_outcome: {
      block_hash: string;
      block_timestamp: string | number;
      outcome: { logs: string[]; status: { SuccessValue?: string } | Record<string, unknown> | string };
    };
  }[];
};
/** A dataset row (agents/data or dataset/decisions.jsonl): the completion bytes behind a TEE proof. */
export type Row = { request_body?: string | undefined; response_body?: string | undefined; tx?: string | undefined };
export type Evidence = {
  arena: string;
  duel_id: string;
  now: State;
  /** State at the block before the close callback (the one finish() read) and at its own block. */
  before: State | null;
  after: State | null;
  /** is_tee_signer for every enclave signer the duel's intents carry, read now. */
  pinned: Record<string, boolean>;
  txs: Tx[];
  /** Range of tx times scanned (ms) and how many txs it held. */
  window: { from_ms: number; to_ms: number; txs: number };
  rows: Record<string, Row>; // by intent proof_hash
};

// ---------------------------------------------------------------- receipts

export type Call = {
  tx: string;
  method: string;
  args: Record<string, unknown>;
  value: unknown; // the receipt's SuccessValue, JSON-decoded
  predecessor: string;
  signer: string;
  deposit: bigint;
  ok: boolean;
  block_hash: string;
  at_ms: number;
};

/** Every function-call receipt the arena executed in these txs, with its own outcome. */
export function arenaCalls(txs: Tx[], arena: string): Call[] {
  return txs.flatMap((t) =>
    t.receipts.flatMap((r) => {
      const a = r.receipt.receipt.Action;
      if (!a || r.receipt.receiver_id !== arena) return [];
      const st = r.execution_outcome.outcome.status;
      const ok = typeof st === "object" && st !== null && ("SuccessValue" in st || "SuccessReceiptId" in st);
      const sv = ok && "SuccessValue" in (st as object) ? (st as { SuccessValue: string }).SuccessValue : "";
      return a.actions.flatMap((x) => {
        const fc = typeof x === "object" ? x.FunctionCall : undefined;
        if (!fc) return [];
        return [
          {
            tx: t.transaction.hash,
            method: fc.method_name,
            args: parse(Buffer.from(fc.args, "base64").toString()) as Record<string, unknown>,
            value: sv ? parse(Buffer.from(sv, "base64").toString()) : null,
            predecessor: r.receipt.predecessor_id,
            signer: a.signer_id,
            deposit: BigInt(fc.deposit ?? "0"),
            ok,
            block_hash: r.execution_outcome.block_hash,
            at_ms: Math.floor(Number(r.execution_outcome.block_timestamp) / 1e6),
          },
        ];
      });
    }),
  );
}
const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** The duel's own successful receipts, by role. */
export function duelCalls(calls: Call[], id: string) {
  const ok = calls.filter((c) => c.ok).sort((x, y) => x.at_ms - y.at_ms);
  const signed = (c: Call) => (c.args.signed as { intent?: Intent } | undefined)?.intent;
  return {
    open: ok.find((c) => (c.method === "open_duel" || c.method === "open_duel_consented") && String(c.value) === id),
    oracle: (phase: "open" | "close") =>
      ok.find((c) => c.method === "oracle_on_call" && c.args.msg === `${phase}:${id}`),
    intents: ok.filter(
      (c) => (c.method === "post_intent" || c.method === "reveal_intent") && signed(c)?.duel_id === id,
    ),
    commits: ok.filter((c) => c.method === "commit_intent" && String(c.args.duel_id) === id),
    chaos: ok.filter((c) => c.method === "inject_chaos" && String(c.args.duel_id) === id),
    void: ok.find((c) => c.method === "void_duel" && String(c.args.duel_id) === id),
  };
}

// ---------------------------------------------------------------- the contract's arithmetic, restated

type OraclePrice = { asset_id: string; price: { multiplier: string; decimals: number } | null };

/** duels.rs price8: the oracle's multiplier / 10^decimals as an 8-dp integer. */
export function price8(p: { multiplier: string; decimals: number }): bigint {
  const m = BigInt(p.multiplier);
  return p.decimals <= 8 ? m * 10n ** BigInt(8 - p.decimals) : m / 10n ** BigInt(p.decimals - 8);
}

/** duels.rs pnl_bps: 0 without an intent or with one that expired before close_at; i128 math, truncating. */
export function pnlBps(i: Intent | null, closeAt: bigint, open: bigint, close: bigint): number {
  if (!i || BigInt(i.expires_at) < closeAt) return 0;
  const sign = i.side === "Long" ? 1n : -1n;
  return Number((sign * (close - open) * BigInt(i.size_bps)) / open);
}

/** duels.rs finish(): bonds after resolution, the slash, the winner side and the owner-fee gain. `nr` = side held
 *  an unrevealed commitment at the close. */
export function finishMath(
  bonds: [bigint, bigint],
  pool: bigint,
  pnl: [number, number],
  nr: [boolean, boolean],
  slashBps: number,
  noRevealBps: number,
) {
  const after: [bigint, bigint] = [...bonds];
  const taken = nr.map((on, s) => (on ? (bonds[s]! * BigInt(noRevealBps)) / 10_000n : 0n)) as [bigint, bigint];
  after[0] -= taken[0];
  after[1] -= taken[1];
  let fees = 0n;
  if (nr[0] && nr[1]) fees = taken[0] + taken[1];
  else if (nr[0]) after[1] += taken[0];
  else if (nr[1]) after[0] += taken[1];
  const aWins: boolean | null =
    nr[0] && nr[1] ? null : nr[0] ? false : nr[1] ? true : pnl[0] === pnl[1] ? null : pnl[0] > pnl[1];
  let slashed = 0n;
  if (aWins === null) {
    after[0] += pool / 2n + (pool % 2n);
    after[1] += pool / 2n;
  } else {
    const [w, l] = aWins ? [0, 1] : [1, 0];
    slashed = (after[l]! * BigInt(slashBps)) / 10_000n;
    after[l]! -= slashed;
    after[w]! += pool + slashed;
  }
  return { after, slashed, aWins, fees, taken };
}

// ---------------------------------------------------------------- checks

export type Line = { result: "PASS" | "FAIL" | "SKIP" | "INFO"; check: string; detail: string };

const short = (s: string, n = 8) => (s.length > n ? `${s.slice(0, n)}…` : s);
const usd = (p: bigint) => (Number(p) / 1e8).toFixed(4);
const near = (y: bigint) => (Number(y) / 1e24).toFixed(5);
const sameIntent = (x: Intent, y: Intent) =>
  (["agent_pk", "duel_id", "side", "size_bps", "nonce", "expires_at", "proof_hash"] as const).every(
    (k) => String(x[k]) === String(y[k]),
  );
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

export function checkDuel(e: Evidence): Line[] {
  const out: Line[] = [];
  const add = (result: Line["result"], check: string, detail: string) => out.push({ result, check, detail });
  const d = e.now.duel;
  if (!d) {
    add("FAIL", "duel", `get_duel ${e.duel_id} returned null on ${e.arena}`);
    return out;
  }
  const calls = duelCalls(arenaCalls(e.txs, e.arena), e.duel_id);
  const sides = [
    ["A", d.a, e.now.a, d.last_intent_a],
    ["B", d.b, e.now.b, d.last_intent_b],
  ] as const;
  const o = d.outcome;
  const voided = !!o && o.open_price === "0" && o.close_price === "0";
  add(
    "INFO",
    "duel",
    `#${d.id} ${d.symbol} on ${e.arena}, closes ${new Date(Number(BigInt(d.close_at) / 1_000_000n)).toISOString()}, ` +
      `${voided ? "voided" : d.resolved ? "resolved" : "open"}; scanned ${e.window.txs} txs ` +
      `${new Date(e.window.from_ms).toISOString()} to ${new Date(e.window.to_ms).toISOString()}`,
  );
  if (calls.open)
    add(
      "PASS",
      "opened",
      `${calls.open.method} returned duel id ${e.duel_id}, tx ${calls.open.tx} by ${calls.open.signer}`,
    );
  else add("SKIP", "opened", "no successful open receipt for this id in the scanned txs");

  // agents and their tier
  for (const [s, pk, ag] of sides) {
    if (ag && ag.pk === pk)
      add(
        "PASS",
        `agent ${s} registered`,
        `${short(pk, 12)} ${ag.model_id}, owner ${ag.owner}, tier ${ag.tee ? "enclave (a TEE proof on every intent)" : "plain (no TEE proof required)"}`,
      );
    else add("FAIL", `agent ${s} registered`, `get_agent(${short(pk, 12)}) returned ${ag ? "another key" : "null"}`);
  }

  // scored intents: the agent's signature, then the enclave's
  for (const [s, pk, ag, stored] of sides) {
    if (!stored) {
      add("INFO", `intent ${s}`, "no scored intent: this side scores 0");
      continue;
    }
    if (stored.agent_pk !== pk)
      add("FAIL", `intent ${s}`, `stored intent is by ${short(stored.agent_pk, 12)}, not side ${s}`);
    const c = calls.intents.find((x) => sameIntent((x.args.signed as { intent: Intent }).intent, stored));
    if (!c) {
      add("SKIP", `intent ${s} signature`, "the receipt that posted it is not in the scanned txs");
      continue;
    }
    const sig = (c.args.signed as { signature: string }).signature;
    add(
      verify(stored.agent_pk, intentMessage(stored), sig) ? "PASS" : "FAIL",
      `intent ${s} signature`,
      `${stored.side} ${stored.size_bps} bps nonce ${stored.nonce}: ed25519 over intent_message by ${short(stored.agent_pk, 12)} (${c.method}, tx ${c.tx})`,
    );
    const p = c.args.tee as TeeProof | null | undefined;
    if (!p) {
      add(
        ag?.tee ? "FAIL" : "INFO",
        `intent ${s} TEE proof`,
        ag?.tee ? "TEE agent intent without a proof" : "plain agent, no proof",
      );
      continue;
    }
    add(p.kind === 2 ? "PASS" : "FAIL", `intent ${s} TEE kind`, `kind ${p.kind} (2 = the model's own enclave)`);
    add(
      e.pinned[p.signer] ? "PASS" : "FAIL",
      `intent ${s} TEE signer`,
      `${short(p.signer, 12)} is_tee_signer = ${e.pinned[p.signer] ?? "unknown"} (read now)`,
    );
    const req = b64.dec(p.request_hash);
    const res = b64.dec(p.response_hash);
    const sigOk =
      req.length === 32 &&
      res.length === 32 &&
      verify(p.signer, teeText(p.kind, ag?.model_id ?? "", req, res), p.signature);
    add(
      sigOk ? "PASS" : "FAIL",
      `intent ${s} TEE signature`,
      `enclave ed25519 over "${ag?.model_id}:${short(hex(req), 10)}:${short(hex(res), 10)}"`,
    );
    add(
      proofHash(req, res) === stored.proof_hash ? "PASS" : "FAIL",
      `intent ${s} proof_hash`,
      `sha256(request_hash || response_hash) = intent proof_hash ${short(stored.proof_hash, 12)}`,
    );
    const row = e.rows[stored.proof_hash];
    if (!row?.request_body || !row.response_body)
      add(
        "SKIP",
        `intent ${s} completion bytes`,
        "not checkable without the row (dataset/decisions.jsonl by proof_hash)",
      );
    else
      add(
        sha256hex(row.request_body) === hex(req) && sha256hex(row.response_body) === hex(res) ? "PASS" : "FAIL",
        `intent ${s} completion bytes`,
        `sha256 of the row's request and response bodies = the signed request_hash / response_hash`,
      );
  }

  // oracle prices: the outcome's numbers are the oracle's callback args
  const oracleLine = (phase: "open" | "close", want: string | null | undefined) => {
    const c = calls.oracle(phase);
    if (!c)
      return add("SKIP", `oracle ${phase}`, `no successful oracle_on_call "${phase}:${e.duel_id}" in the scanned txs`);
    const data = c.args.data as { timestamp: string; prices: OraclePrice[] };
    const pr = data.prices.find((x) => x.asset_id === d.symbol)?.price;
    const got = pr ? price8(pr) : null;
    const fromOracle = c.predecessor === e.now.config.oracle_account && c.args.sender_id === e.arena;
    const ts = BigInt(data.timestamp);
    const timely = phase === "close" ? ts >= BigInt(d.close_at) : ts < BigInt(d.close_at);
    add(
      fromOracle && got !== null && String(got) === String(want) && timely ? "PASS" : "FAIL",
      `oracle ${phase}`,
      `${c.predecessor} answered ${got === null ? "no price" : usd(got)} (stamped ${new Date(Number(ts / 1_000_000n)).toISOString()}), stored ${want ? usd(BigInt(want)) : "none"}, tx ${c.tx}`,
    );
  };
  oracleLine("open", d.open_price);
  if (!o) return chaos(e, d, calls.chaos, out, add);
  if (voided) {
    add(
      calls.void ? "PASS" : "SKIP",
      "void",
      calls.void ? `void_duel tx ${calls.void.tx}: no prices, pool split` : "void receipt not in the scanned txs",
    );
  } else {
    if (o.open_price !== d.open_price)
      add("FAIL", "oracle open", `outcome open ${o.open_price} != duel open_price ${d.open_price}`);
    oracleLine("close", o.close_price);
    // pnl from the scored sides and sizes
    const [open, close, closeAt] = [BigInt(o.open_price), BigInt(o.close_price), BigInt(d.close_at)];
    for (const [s, , , stored] of sides) {
      const want = s === "A" ? o.pnl_a : o.pnl_b;
      const got = pnlBps(stored, closeAt, open, close);
      add(
        got === want ? "PASS" : "FAIL",
        `pnl ${s}`,
        stored
          ? `${stored.side === "Long" ? "+" : "-"}(close ${usd(close)} - open ${usd(open)}) x ${stored.size_bps} / open = ${got} bps, outcome ${want}`
          : `no intent: 0 bps, outcome ${want}`,
      );
    }
  }

  // no-reveal flags from the commit / reveal receipts
  const derived = sides.map(([, pk]) => {
    const last = calls.commits.filter((c) => c.args.agent_pk === pk).at(-1);
    if (!last) return false;
    return !calls.intents.some(
      (c) =>
        c.method === "reveal_intent" &&
        c.at_ms >= last.at_ms &&
        (c.args.signed as { intent: Intent }).intent.agent_pk === pk,
    );
  }) as [boolean, boolean];
  const flags = e.now.no_reveal ?? [false, false];
  if (calls.commits.length || e.now.no_reveal?.some(Boolean))
    add(
      derived[0] === flags[0] && derived[1] === flags[1] ? "PASS" : "FAIL",
      "no-reveal",
      `unrevealed commitment at close from the receipts: A ${derived[0]}, B ${derived[1]}; get_no_reveal: A ${flags[0]}, B ${flags[1]}`,
    );

  // payout, as finish() / void_duel compute it from the state the callback read
  const b = e.before;
  const a = e.after;
  if (!b?.a || !b.b || !b.duel || !a?.a || !a.b) {
    add(
      "SKIP",
      "payout",
      "state at the close callback's block is not available from the RPC (try VERIFY_ARCHIVAL_RPC)",
    );
  } else {
    const bonds: [bigint, bigint] = [BigInt(b.a.bond), BigInt(b.b.bond)];
    const pool = BigInt(b.duel.pool);
    const got: [bigint, bigint] = [BigInt(a.a.bond), BigInt(a.b.bond)];
    if (voided) {
      const want = [bonds[0] + pool / 2n + (pool % 2n), bonds[1] + pool / 2n];
      add(
        got[0] === want[0] && got[1] === want[1] ? "PASS" : "FAIL",
        "payout",
        `void: pool ${near(pool)} NEAR split, A ${near(bonds[0])} -> ${near(got[0])}, B ${near(bonds[1])} -> ${near(got[1])}`,
      );
    } else {
      const m = finishMath(bonds, pool, [o.pnl_a, o.pnl_b], flags, b.config.slash_bps, b.config.no_reveal_bps ?? 0);
      const winner = m.aWins === null ? null : m.aWins ? d.a : d.b;
      add(
        (o.winner ?? null) === winner && BigInt(o.slashed) === m.slashed ? "PASS" : "FAIL",
        "winner and slash",
        `${winner ? `winner ${winner === d.a ? "A" : "B"}, loser slashed ${b.config.slash_bps} bps of its bond = ${near(m.slashed)} NEAR` : "tie, no slash, pool split"}; outcome ${o.winner ? `winner ${o.winner === d.a ? "A" : "B"}` : "tie"}, slashed ${near(BigInt(o.slashed))} NEAR`,
      );
      if (m.taken[0] || m.taken[1])
        add(
          "INFO",
          "no-reveal forfeit",
          `A paid ${near(m.taken[0])}, B paid ${near(m.taken[1])} NEAR (${b.config.no_reveal_bps} bps)${m.fees ? ", both to owner fees" : ""}`,
        );
      const feesOk = !m.fees || BigInt(a.config.owner_fees) - BigInt(b.config.owner_fees) === m.fees;
      add(
        got[0] === m.after[0] && got[1] === m.after[1] && feesOk ? "PASS" : "FAIL",
        "payout",
        `pool ${near(pool)} NEAR; A ${near(bonds[0])} -> ${near(got[0])} (expected ${near(m.after[0])}), B ${near(bonds[1])} -> ${near(got[1])} (expected ${near(m.after[1])})`,
      );
    }
  }
  return chaos(e, d, calls.chaos, out, add);
}

/** Injections: payer, kind and target of every successful inject_chaos, and the count the contract kept. */
function chaos(
  e: Evidence,
  d: Duel,
  list: Call[],
  out: Line[],
  add: (r: Line["result"], c: string, x: string) => void,
) {
  const owners = new Map([e.now.a, e.now.b].flatMap((ag) => (ag ? [[ag.pk, ag.owner] as const] : [])));
  for (const c of list) {
    const target = String(c.args.target);
    const self = owners.get(target) === c.predecessor ? " (payer owns the target agent)" : "";
    add(
      "INFO",
      "injection",
      `${c.predecessor} paid ${near(c.deposit)} NEAR: kind "${c.args.kind}" at ${target === d.a ? "A" : "B"}${self}, tx ${c.tx}`,
    );
  }
  const kept = d.outcome ? d.outcome.injections : d.injections.length;
  add(
    list.length === kept ? "PASS" : "SKIP",
    "injections",
    `${list.length} successful inject_chaos receipts found, contract counts ${kept}${list.length === kept ? "" : " (some outside the scanned txs)"}; no self-chaos rule in this contract`,
  );
  return out;
}

// ---------------------------------------------------------------- collecting the evidence

const TX_API = process.env.FASTNEAR_TX_API ?? NET.txApi;
const RPC =
  process.env.VERIFY_RPC ??
  (NETWORK_ID === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
const ARCHIVAL =
  process.env.VERIFY_ARCHIVAL_RPC ??
  (NETWORK_ID === "mainnet"
    ? "https://archival-rpc.mainnet.fastnear.com"
    : "https://archival-rpc.testnet.fastnear.com");

async function post<T>(url: string, body: unknown): Promise<T> {
  let last = "";
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    }).catch((x) => ({ ok: false, status: String(x) }) as const);
    if (r.ok && "json" in r) return (await r.json()) as T;
    last = String(r.status);
    await new Promise((s) => setTimeout(s, 500 * 2 ** i)); // FastNEAR 429s a cold burst
  }
  throw new Error(`${url} failed: ${last}`);
}

type RpcRes = { result?: { result?: number[]; header?: { prev_hash: string } }; error?: unknown };
async function viewAt<T>(arena: string, method: string, args: object, block?: string): Promise<T> {
  const params = {
    request_type: "call_function",
    account_id: arena,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    ...(block ? { block_id: block } : { finality: "final" }),
  };
  for (const url of block ? [RPC, ARCHIVAL] : [RPC]) {
    const r = await post<RpcRes>(url, { jsonrpc: "2.0", id: 1, method: "query", params });
    if (r.result?.result) return JSON.parse(Buffer.from(r.result.result).toString()) as T;
    if (!block) throw new Error(`${method}: ${JSON.stringify(r.error).slice(0, 160)}`);
  }
  throw new Error(`${method} at ${block}: not served`);
}

async function state(arena: string, id: string, block?: string): Promise<State> {
  const duel = await viewAt<Duel | null>(arena, "get_duel", { duel_id: id }, block);
  const agent = (pk?: string) => (pk ? viewAt<AgentView | null>(arena, "get_agent", { agent_pk: pk }, block) : null);
  const [config, a, b, no_reveal] = await Promise.all([
    viewAt<Config>(arena, "get_config", {}, block),
    agent(duel?.a),
    agent(duel?.b),
    viewAt<[boolean, boolean]>(arena, "get_no_reveal", { duel_id: id }, block).catch(() => null),
  ]);
  return { config, duel, a, b, no_reveal };
}

/** The arena's txs stamped inside [from, to], newest page first, fetched 20 hashes a call. */
async function txsBetween(arena: string, fromMs: number, toMs: number): Promise<Tx[]> {
  const hashes: string[] = [];
  let resume: string | undefined;
  for (;;) {
    const page = await post<{
      account_txs: { transaction_hash: string; tx_block_timestamp: string }[];
      resume_token?: string;
    }>(`${TX_API}/account`, { account_id: arena, ...(resume ? { resume_token: resume } : {}) });
    for (const t of page.account_txs) {
      const ms = Number(BigInt(t.tx_block_timestamp) / 1_000_000n);
      if (ms >= fromMs && ms <= toMs) hashes.push(t.transaction_hash);
    }
    const oldest = page.account_txs.at(-1);
    if (!page.resume_token || !oldest || Number(BigInt(oldest.tx_block_timestamp) / 1_000_000n) < fromMs) break;
    resume = page.resume_token;
  }
  const out: Tx[] = [];
  for (let i = 0; i < hashes.length; i += 20)
    out.push(
      ...(await post<{ transactions: Tx[] }>(`${TX_API}/transactions`, { tx_hashes: hashes.slice(i, i + 20) }))
        .transactions,
    );
  return out;
}

function datasetRows(proofHashes: string[]): Record<string, Row> {
  const want = new Set(proofHashes);
  const rows: Record<string, Row> = {};
  const root = new URL("..", import.meta.url).pathname;
  const files = (process.env.DECISIONS ?? `${root}agents/data/decisions.jsonl,${root}dataset/decisions.jsonl`).split(
    ",",
  );
  for (const f of files.filter((x) => x && existsSync(x)))
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line || !proofHashes.some((p) => line.includes(p))) continue;
      const r = parse(line) as (Row & { intent?: Intent }) | null;
      const ph = r?.intent?.proof_hash;
      if (ph && want.has(ph) && r.request_body)
        rows[ph] = { request_body: r.request_body, response_body: r.response_body, tx: r.tx };
    }
  return rows;
}

export async function collect(arena: string, id: string): Promise<Evidence> {
  const now = await state(arena, id);
  const d = now.duel;
  if (!d)
    return {
      arena,
      duel_id: id,
      now,
      before: null,
      after: null,
      pinned: {},
      txs: [],
      window: { from_ms: 0, to_ms: 0, txs: 0 },
      rows: {},
    };
  const closeMs = Number(BigInt(d.close_at) / 1_000_000n);
  const openMs = d.open_at ? Number(BigInt(d.open_at) / 1_000_000n) : closeMs - 3_600_000;
  const voided = d.outcome?.open_price === "0";
  // the close callback lands minutes after close_at; a void needs a day; an open duel is scanned up to now
  const toMs = !d.resolved ? Date.now() : closeMs + (voided ? 48 : 2) * 3_600_000;
  const txs = await txsBetween(arena, openMs - 120_000, Math.min(toMs, Date.now()));
  const calls = duelCalls(arenaCalls(txs, arena), id);
  const fin = calls.oracle("close") ?? calls.void;
  let before: State | null = null;
  let after: State | null = null;
  if (fin) {
    try {
      const blk = await post<RpcRes>(RPC, {
        jsonrpc: "2.0",
        id: 1,
        method: "block",
        params: { block_id: fin.block_hash },
      });
      const prev = blk.result?.header?.prev_hash;
      if (prev) [before, after] = await Promise.all([state(arena, id, prev), state(arena, id, fin.block_hash)]);
    } catch {} // pruned and no archival answer: the payout line says SKIP
  }
  const proofs = calls.intents.map((c) => c.args.tee as TeeProof | null).filter((p): p is TeeProof => !!p);
  const pinned: Record<string, boolean> = {};
  for (const p of proofs) pinned[p.signer] ??= await viewAt<boolean>(arena, "is_tee_signer", { signer: p.signer });
  const stored = [d.last_intent_a, d.last_intent_b].flatMap((i) => (i ? [i.proof_hash] : []));
  return {
    arena,
    duel_id: id,
    now,
    before,
    after,
    pinned,
    txs,
    window: { from_ms: openMs - 120_000, to_ms: Math.min(toMs, Date.now()), txs: txs.length },
    rows: datasetRows(stored),
  };
}

/** The evidence with only the txs that carry one of this duel's receipts (what --save keeps). */
export function ownTxs(e: Evidence): Evidence {
  const c = duelCalls(arenaCalls(e.txs, e.arena), e.duel_id);
  const mine = [c.open, c.oracle("open"), c.oracle("close"), c.void, ...c.intents, ...c.commits, ...c.chaos];
  const keep = new Set(mine.flatMap((x) => (x ? [x.tx] : [])));
  return { ...e, txs: e.txs.filter((t) => keep.has(t.transaction.hash)) };
}

export function render(lines: Line[]): string {
  return lines.map((l) => `${l.result.padEnd(4)}  ${l.check.padEnd(26)} ${l.detail}`).join("\n");
}

if (import.meta.main) {
  const [id, flag, path] = process.argv.slice(2);
  if (!id || !/^\d+$/.test(id)) {
    console.error("usage: bun run verify-duel <duel id> [--save evidence.json]");
    process.exit(2);
  }
  const arena = process.env.ARENA_CONTRACT ?? NET.arena;
  const e = await collect(arena, id);
  if (flag === "--save" && path) writeFileSync(path, `${JSON.stringify(ownTxs(e), null, 1)}\n`);
  const lines = checkDuel(e);
  console.log(render(lines));
  const fails = lines.filter((l) => l.result === "FAIL").length;
  console.log(
    `\n${fails ? `${fails} FAIL` : "no FAIL"} · ${lines.filter((l) => l.result === "PASS").length} PASS · ${lines.filter((l) => l.result === "SKIP").length} SKIP`,
  );
  process.exit(fails ? 1 : 0);
}
