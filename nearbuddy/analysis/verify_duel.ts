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
import type { Chaos, ChaosConfig } from "../packages/protocol/src/abi/arena.ts";
import { b64, hex } from "../packages/protocol/src/index.ts";
import {
  type Intent,
  intentMessage,
  proofHash,
  type TeeProof,
  teeText,
  verify,
} from "../packages/protocol/src/intent.ts";
import { type KeylessInputs, keylessRequest, parseDecision, SLOT_TTL_NS } from "../packages/protocol/src/keyless.ts";
import { NET, NETWORK_ID } from "../packages/protocol/src/network.ts";

// ---------------------------------------------------------------- the evidence (all public)

export type AgentView = { owner: string; pk: string; model_id: string; bond: string; tee: boolean; shield?: number };
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
export type Config = {
  oracle_account: string;
  oracle_deposit?: string;
  slash_bps: number;
  no_reveal_bps?: number;
  owner_fees: string;
  /** The global intent lock in seconds: before deploy 15 every duel read this value. */
  intent_lock_s?: number;
  /** Present from deploy 15 on: how the verifier tells v15 rules (self-chaos, forfeit shield) from v14. */
  intents_account?: string;
  /** Present from deploy 17 on: the chaos terms, and how the verifier tells deploy-17 settlement from the pool rule. */
  chaos?: ChaosConfig;
};
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
          actions: (
            | { FunctionCall?: { method_name: string; args: string; deposit: string }; Transfer?: { deposit: string } }
            | string
          )[];
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
  // Deploy 15 (absent in evidence saved before it; those lines then SKIP):
  /** duel_lock(duel_id) read now, ns: the intent lock this duel ran under. null on a contract without the view. */
  lock_ns?: string | null;
  /** Per block holding a successful inject_chaos for this duel: the duel's pool at the block before and at it. */
  chaos_pools?: Record<string, [string, string]>;
  /** At the open receipt's block: the arena account's storage_usage before and after, get_config there, and how many
   *  other successful arena receipts ran in that block (any of them makes the storage delta inexact). */
  open_block?: { storage_before: number; storage_after: number; config: Config; others?: number } | null;
  // Deploy 17 (absent in evidence saved before it):
  /** get_chaos(duel_id) read now: every planted headline with its stake, outcome and payout (kept after the finish).
   *  null when it was not read: a contract before deploy 17, or a failed read. */
  chaos?: Chaos[] | null;
  // Deploy 18 (absent in evidence saved before it):
  /** get_keyless for each side, read now: a keyless agent's strategy and template, null for a keyed agent. */
  keyless?: Record<string, { strategy: string; template: number } | null>;
  /** get_model_signer for every enclave key a submit_completion carries, read now: the model it is pinned to. */
  model_signers?: Record<string, string | null>;
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
  /** Block time in ns (FastNEAR may send a lossy JSON number; sub-microsecond error at most). */
  at_ns: bigint;
};

/** yoctoNEAR the arena transferred to `to` inside tx `hash` (the open_duel refund). */
export function transfersFromArena(txs: Tx[], arena: string, hash: string, to: string): bigint {
  return txs
    .filter((t) => t.transaction.hash === hash)
    .flatMap((t) => t.receipts)
    .filter((r) => r.receipt.predecessor_id === arena && r.receipt.receiver_id === to)
    .flatMap((r) => r.receipt.receipt.Action?.actions ?? [])
    .reduce((s, a) => s + (typeof a === "object" && a.Transfer ? BigInt(a.Transfer.deposit) : 0n), 0n);
}

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
            at_ns: BigInt(String(r.execution_outcome.block_timestamp)),
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
  const oracle = (phase: "open" | "close") =>
    ok.find((c) => c.method === "oracle_on_call" && c.args.msg === `${phase}:${id}`);
  const voided = ok.find((c) => c.method === "void_duel" && String(c.args.duel_id) === id);
  // operator era (testnet duels before #257): the operator key's signed `resolve` scored the duel, no oracle callback
  const resolve = ok.find(
    (c) => c.method === "resolve" && String((c.args.resolution as { duel_id?: unknown } | undefined)?.duel_id) === id,
  );
  return {
    open: ok.find((c) => (c.method === "open_duel" || c.method === "open_duel_consented") && String(c.value) === id),
    oracle,
    intents: ok.filter(
      (c) => (c.method === "post_intent" || c.method === "reveal_intent") && signed(c)?.duel_id === id,
    ),
    commits: ok.filter((c) => c.method === "commit_intent" && String(c.args.duel_id) === id),
    chaos: ok.filter((c) => c.method === "inject_chaos" && String(c.args.duel_id) === id),
    // deploy 18: keyless agents' decision slots, their committed completions and reveals, and the oracle ticks
    slots: ok.filter((c) => c.method === "open_slot" && String(c.args.duel_id) === id),
    submissions: ok.filter((c) => c.method === "submit_completion" && String(c.args.duel_id) === id),
    // the first deploy-18 draft: a hidden commit, then a reveal
    completions: ok.filter((c) => c.method === "commit_completion" && String(c.args.duel_id) === id),
    reveals: ok.filter((c) => c.method === "reveal_completion" && String(c.args.duel_id) === id),
    ticks: ok.filter((c) => c.method === "oracle_on_call" && c.args.msg === `tick:${id}`),
    void: voided,
    resolve,
    /** The receipt that scored or voided the duel: the payout state is read at its block. */
    closing: oracle("close") ?? voided ?? resolve,
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

/** Deploy 17's injections at finish, from their get_chaos records: the records, the duel's agents [A, B], the
 *  terms finish() read, and whether the duel was voided (void_duel: the oracle never answered). */
export type ChaosSettle = {
  records: Pick<Chaos, "target" | "stake" | "outcome">[];
  pks: [string, string];
  terms: Pick<ChaosConfig, "fee_bps" | "share_bps">;
  voided?: boolean;
};

/** chaos.rs settle_records: every stake leaves the pool and pays `fee = stake * fee_bps / 10_000` to owner fees,
 *  whatever its outcome, except an expired one in a `voided` duel (the oracle never answered, not the injector's
 *  doing: no fee). A held stake less the fee goes to the target's bond (payout 0). Every other one is owed back less
 *  the fee (a pending one settles as expired), plus, for a flip at `loser`, its share of `pot` by stake (weights in
 *  bps, rounded down; only the shares paid leave the loser's bond). */
export function settleRecords(
  list: ChaosSettle["records"],
  loser: string | null,
  pot: bigint,
  feeBps: number,
  voided = false,
) {
  const fooled = (c: ChaosSettle["records"][number]) => c.outcome === "Flipped" && c.target === loser;
  const weight = list.filter(fooled).reduce((s, c) => s + BigInt(c.stake), 0n);
  let [taken, fees, shares] = [0n, 0n, 0n];
  const credits: [string, bigint][] = [];
  const payouts = list.map((c) => {
    const stake = BigInt(c.stake);
    const expired = c.outcome === "Expired" || c.outcome === "Pending";
    const fee = voided && expired ? 0n : (stake * BigInt(feeBps)) / 10_000n;
    taken += stake;
    fees += fee;
    if (c.outcome === "Held") {
      if (stake > fee) credits.push([c.target, stake - fee]);
      return 0n;
    }
    const share = fooled(c) && weight > 0n ? (pot * ((stake * 10_000n) / weight)) / 10_000n : 0n;
    shares += share;
    return stake - fee + share;
  });
  return { payouts, taken, fees, shares, credits };
}

/** duels.rs finish(): bonds after resolution, the slash, the winner side and the owner-fee gain. `nr` = side held
 *  an unrevealed commitment at the close. With `chaos` (deploy 17) the injections settle out of the pool first
 *  (chaos.rs settle_chaos): the loser pays the flips' shares from its bond on top of its slash, at most `share_bps`
 *  of the slash and what the bond still holds; the winner keeps the whole slash and what is left of the pool. A tie
 *  (or a void) splits what is left. */
export function finishMath(
  bonds: [bigint, bigint],
  pool: bigint,
  pnl: [number, number],
  nr: [boolean, boolean],
  slashBps: number,
  noRevealBps: number,
  chaos?: ChaosSettle,
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
  let settled: ReturnType<typeof settleRecords> | null = null;
  if (aWins === null) {
    if (chaos) settled = settleRecords(chaos.records, null, 0n, chaos.terms.fee_bps, chaos.voided);
    const left = pool - (settled?.taken ?? 0n);
    after[0] += left / 2n + (left % 2n);
    after[1] += left / 2n;
  } else {
    const [w, l] = aWins ? [0, 1] : [1, 0];
    slashed = (after[l]! * BigInt(slashBps)) / 10_000n;
    after[l]! -= slashed;
    if (chaos) {
      const most = (slashed * BigInt(chaos.terms.share_bps)) / 10_000n;
      // biome-ignore lint/complexity/useMathMinMax: bigint, Math.min would throw
      const pot = most < after[l]! ? most : after[l]!; // what the bond still holds bounds the shares
      settled = settleRecords(chaos.records, chaos.pks[l]!, pot, chaos.terms.fee_bps);
      after[l]! -= settled.shares;
    }
    after[w]! += pool + slashed - (settled?.taken ?? 0n);
  }
  for (const [pk, amt] of settled?.credits ?? []) after[pk === chaos!.pks[0] ? 0 : 1] += amt;
  fees += settled?.fees ?? 0n;
  return { after, slashed, aWins, fees, taken, settled };
}

/** get_model_signer for each enclave key, read now. A read that errors (an RPC 429, a timeout) leaves its key out, so
 *  the TEE signer line is SKIP: only an answer may FAIL (null: not pinned; another model id: pinned elsewhere). */
export async function readModelSigners(
  signers: string[],
  read: (signer: string) => Promise<string | null>,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const s of new Set(signers))
    try {
      out[s] = await read(s);
    } catch {} // unread: SKIP
  return out;
}

/** chaos.rs judge, read back: whether a settled record's outcome is the one its own kind, prev and next give.
 *  Expired had no counting decision before the end; every other outcome had one (`next`), except a keyless reply
 *  with no readable decision (unread_decision): it decides the headlines its request carried as NoTrial, with
 *  `decided_by` set and `next` null. A target that replaced,
 *  unrevealed, the commitment it held at the injection hid that call (hide_prev_since): `prev` stays null and the
 *  call counts against the target, so the next decision gives Flipped on the lie's side and NoTrial off it, never
 *  Held. get_chaos does not show that flag, so a null `prev` with `next` on the lie's side is Flipped (charged) or
 *  NoTrial (no call before the lie). */
export function judged(c: Pick<Chaos, "kind" | "prev" | "next" | "outcome" | "decided_by">): boolean {
  if (c.outcome === "Expired") return c.next === null;
  if (c.next === null) return c.outcome === "NoTrial" && c.decided_by != null;
  const lie = c.kind === "Placebo" ? null : c.kind;
  if (lie !== null && c.prev === null && c.next === lie && c.outcome === "Flipped") return true; // a charged flip
  if (lie === null || c.prev === null || c.prev === lie) return c.outcome === "NoTrial";
  return c.outcome === (c.next === lie ? "Flipped" : "Held");
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
  // deploy-15 rules (self-chaos to owner fees, no shield on a forfeit) when the contract that finished it had them
  const v15 = !!(e.before ?? e.now).config.intents_account;
  // deploy-17 settlement (each injection settles by its get_chaos record) when the contract that finished it or
  // opened it had the chaos terms, or the duel has records; migrate_v17 refuses while a duel is open, so no duel
  // straddles deploy 17 and an open one runs under today's contract. A resolved duel whose close and open state could
  // not be read is never judged by today's config: a deploy-16 duel read after deploy 17 would pass for one
  const v17 = !!(
    e.before?.config.chaos ||
    e.open_block?.config.chaos ||
    e.chaos?.length ||
    (!d.resolved && e.now.config.chaos)
  );
  // a duel opened under one deploy and finished under the other: its injections landed under one rule set and
  // finish() credited shield under the other, so no single rule describes it
  const straddled =
    e.open_block?.config && e.before?.config && !!e.open_block.config.intents_account !== v15
      ? `the duel straddled deploy 15 (opened under ${v15 ? "v14" : "v15"}, finished under ${v15 ? "v15" : "v14"}): its injections and its finish ran under different rules`
      : null;
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
  if (calls.open && e.open_block !== undefined) openerRefund(e, calls.open, add);
  // The lock this duel ran under. Deploy 15 records it at open (duel_lock); for an earlier duel that view answers
  // today's global lock, so the open block's intent_lock_s stands in: deploys 12-14's set_oracle only let the lock
  // grow while a duel was open, so an intent the contract accepted also clears the lock in force at open (testnet's
  // lock has been 60 s since deploy 11).
  const ob = e.open_block?.config;
  const lockNs = !ob
    ? null
    : ob.intents_account
      ? e.lock_ns != null
        ? BigInt(e.lock_ns)
        : null
      : ob.intent_lock_s != null
        ? BigInt(ob.intent_lock_s) * 1_000_000_000n
        : null;
  if (lockNs === null && (e.lock_ns != null || e.open_block !== undefined))
    add(
      "INFO",
      "intent timing",
      ob
        ? "not checked: the lock this duel ran under is in neither duel_lock nor the open block's config"
        : "not checked: the open block's config is not available, so the lock this duel ran under is unknown",
    );

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
    const kl = e.keyless?.[pk];
    if (kl && ag) {
      keyless(e, s, d, ag, kl, stored, calls, lockNs, add);
      continue;
    }
    const c = calls.intents.find((x) => sameIntent((x.args.signed as { intent: Intent }).intent, stored));
    if (!c) {
      add("SKIP", `intent ${s} signature`, "the receipt that posted it is not in the scanned txs");
      continue;
    }
    const sig = (c.args.signed as { signature: string }).signature;
    let signed = false;
    try {
      signed = verify(stored.agent_pk, intentMessage(stored), sig);
    } catch {} // an intent the contract's JSON ingress would refuse: FAIL, not a crash
    add(
      signed ? "PASS" : "FAIL",
      `intent ${s} signature`,
      `${stored.side} ${stored.size_bps} bps nonce ${stored.nonce}: ed25519 over intent_message by ${short(stored.agent_pk, 12)} (${c.method}, tx ${c.tx})`,
    );
    if (lockNs !== null) timing(s, pk, c, BigInt(d.close_at), lockNs, calls.commits, add);
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
  if (!o) return chaos(e, d, calls.chaos, v15, v17, straddled, out, add);
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
  // deploy 17: the injections settle out of the pool by their records, under the terms finish() read
  const terms = b?.config.chaos;
  const settle = v17 && terms && e.chaos ? { records: e.chaos, pks: [d.a, d.b] as [string, string], terms } : null;
  if (!b?.a || !b.b || !b.duel || !a?.a || !a.b) {
    add(
      "SKIP",
      "payout",
      calls.closing
        ? "state at the close callback's block is not available from the RPC (try VERIFY_ARCHIVAL_RPC)"
        : "the close callback's receipt is not in the scanned txs yet (FastNEAR may still be indexing it); re-run later",
    );
  } else if (v17 && !settle) {
    add("SKIP", "payout", "deploy 17 settles each injection by its record: get_chaos or the chaos terms were not read");
  } else {
    const bonds: [bigint, bigint] = [BigInt(b.a.bond), BigInt(b.b.bond)];
    const pool = BigInt(b.duel.pool);
    const got: [bigint, bigint] = [BigInt(a.a.bond), BigInt(a.b.bond)];
    // owner_fees is global: another arena receipt in the closing block (a second duel's finish, a fee claim, a
    // placebo) moves it too, so a mismatch there is not this duel's to judge
    const fin = calls.closing;
    const others = fin
      ? arenaCalls(e.txs, e.arena).filter((c) => c.ok && c.block_hash === fin.block_hash).length - 1
      : 0;
    const forfeits = keeperForfeits(calls);
    const feesOk = (fees: bigint) => {
      const gain = BigInt(a.config.owner_fees) - BigInt(b.config.owner_fees) - forfeits;
      if (!fees || gain === fees) return true;
      if (others <= 0) return false;
      add(
        "INFO",
        "owner fees",
        `+${near(gain)} NEAR in the closing block, this duel's share ${near(fees)} not derivable (${others} other arena receipts in the closing block)`,
      );
      return true;
    };
    const bondsLine = (m: { after: [bigint, bigint]; fees: bigint }) =>
      `A ${near(bonds[0])} -> ${near(got[0])} (expected ${near(m.after[0])}), B ${near(bonds[1])} -> ${near(got[1])} (expected ${near(m.after[1])}), owner fees +${near(m.fees)} NEAR`;
    if (voided) {
      const m = finishMath(bonds, pool, [0, 0], [false, false], 0, 0, settle ? { ...settle, voided: true } : undefined);
      add(
        got[0] === m.after[0] && got[1] === m.after[1] && feesOk(m.fees) ? "PASS" : "FAIL",
        "payout",
        settle
          ? `void: the injections settle as on a tie, then the pool ${near(pool)} NEAR less their stakes is split; ${bondsLine(m)}`
          : `void: pool ${near(pool)} NEAR split, A ${near(bonds[0])} -> ${near(got[0])}, B ${near(bonds[1])} -> ${near(got[1])}`,
      );
      if (settle) settlement(m.settled!, { ...settle, voided: true }, add);
    } else {
      const m = finishMath(
        bonds,
        pool,
        [o.pnl_a, o.pnl_b],
        flags,
        b.config.slash_bps,
        b.config.no_reveal_bps ?? 0,
        settle ?? undefined,
      );
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
          `A paid ${near(m.taken[0])}, B paid ${near(m.taken[1])} NEAR (${b.config.no_reveal_bps} bps)${flags[0] && flags[1] ? ", both to owner fees" : ""}`,
        );
      add(
        got[0] === m.after[0] && got[1] === m.after[1] && feesOk(m.fees) ? "PASS" : "FAIL",
        "payout",
        settle
          ? `pool ${near(pool)} NEAR of stakes, each settled by its record; the winner keeps the whole slash, the loser pays the flips' shares on top; ${bondsLine(m)}`
          : `pool ${near(pool)} NEAR; A ${near(bonds[0])} -> ${near(got[0])} (expected ${near(m.after[0])}), B ${near(bonds[1])} -> ${near(got[1])} (expected ${near(m.after[1])})`,
      );
      if (settle) settlement(m.settled!, settle, add);
      // shield: the winner's count of injections it outlasted, as finish() credits it
      const sh = [b.a.shield, b.b.shield, a.a.shield, a.b.shield];
      if (straddled) add("SKIP", "shield", `not judged: ${straddled}`);
      else if (sh.some((x) => x === undefined)) add("SKIP", "shield", "shield not in the saved agent views");
      else if ((settle?.records.length ?? calls.chaos.length) !== o.injections)
        add(
          "SKIP",
          "shield",
          settle ? "get_chaos does not list every injection" : "some injections are outside the scanned txs",
        );
      else {
        const owners = new Set([e.now.a?.owner, e.now.b?.owner]);
        // deploy 17 counts only the third-party headlines the winner held against; a placebo is the contract owner's
        const targets = settle
          ? settle.records.map((c) => ({
              target: c.target,
              self: owners.has(c.injector) || c.kind === "Placebo",
              outcome: c.outcome,
            }))
          : calls.chaos.map((c) => ({ target: String(c.args.target), self: owners.has(c.predecessor) }));
        const forfeit = flags[0] || flags[1];
        const gain = shieldGain(targets, o.winner ?? null, forfeit, v15);
        const got = [sh[2]! - sh[0]!, sh[3]! - sh[1]!];
        const want = [o.winner === d.a ? gain : 0, o.winner === d.b ? gain : 0];
        const rule = settle
          ? "v17 rule: the winner gains one per headline it held against (outcome Held), none paid by an agent's owner, no placebo, none on a forfeit win"
          : `${v15 ? "v15" : "v14"} rule: the winner gains one per injection aimed at it${v15 ? ", none paid by an agent's owner, none on a forfeit win" : ""}`;
        add(
          got[0] === want[0] && got[1] === want[1] ? "PASS" : "FAIL",
          "shield",
          `${rule}: expected A +${want[0]} B +${want[1]}, got A +${got[0]} B +${got[1]}`,
        );
      }
    }
  }
  return chaos(e, d, calls.chaos, v15, v17, straddled, out, add);
}

/** finish()'s shield credit: injections aimed at the winner; from deploy 15 none paid by either agent's owner and
 *  none at all when the win is a forfeit (red team F2); from deploy 17, whose records carry an `outcome`, only the
 *  `Held` ones (chaos.rs held_against). 0 on a tie. */
export function shieldGain(
  targets: { target: string; self: boolean; outcome?: Chaos["outcome"] }[],
  winner: string | null,
  forfeit: boolean,
  v15: boolean,
): number {
  if (!winner || (v15 && forfeit)) return 0;
  return targets.filter(
    (t) => t.target === winner && !(v15 && t.self) && (t.outcome === undefined || t.outcome === "Held"),
  ).length;
}

/** Deploy 17: each settled record's payout against settle_records on the same records, and its outcome against its
 *  own kind, prev and next. */
function settlement(
  s: ReturnType<typeof settleRecords>,
  settle: { records: Chaos[]; terms: ChaosConfig; voided?: boolean },
  add: (r: Line["result"], c: string, x: string) => void,
) {
  const list = settle.records;
  const each = settle.voided ? "of each but the expired ones (void: no fee)" : "of each";
  const bad = list.flatMap((c, i) => {
    const why =
      c.outcome === "Pending"
        ? "still pending after the finish"
        : !judged(c)
          ? `${c.outcome} does not follow from prev ${c.prev} and next ${c.next} for a ${c.kind} headline`
          : BigInt(c.payout) !== s.payouts[i]
            ? `payout ${near(BigInt(c.payout))}, expected ${near(s.payouts[i]!)}`
            : "";
    return why ? [`#${i} ${why}`] : [];
  });
  const n = (x: Chaos["outcome"]) => list.filter((c) => c.outcome === x).length;
  const sum = (xs: bigint[]) => xs.reduce((t, x) => t + x, 0n);
  add(
    bad.length ? "FAIL" : "PASS",
    "chaos settlement",
    `${list.length} headlines: ${n("Flipped")} flipped, ${n("Held")} held, ${n("NoTrial")} no trial, ${n("Expired")} expired; ` +
      `stakes ${near(s.taken)} NEAR, fee ${settle.terms.fee_bps} bps ${each} = ${near(s.fees)} to owner fees, ` +
      `held stakes less the fee ${near(sum(s.credits.map(([, x]) => x)))} to the targets' bonds, ` +
      `flip shares ${near(s.shares)} from the loser's bond, payouts ${near(sum(s.payouts))} NEAR` +
      (bad.length ? `: ${bad.join("; ")}` : ", as get_chaos records them"),
  );
}

const secs = (ns: bigint) => (Number(ns) / 1e9).toFixed(1);

/** When the scored intent landed against the duel's own lock: a post before the lock; a reveal before close_at
 *  (inside the lock is the intended window; earlier is legal but made the call public sooner) and its commitment
 *  before the lock. */
function timing(
  s: string,
  pk: string,
  c: Call,
  close: bigint,
  lock: bigint,
  commits: Call[],
  add: (r: Line["result"], c: string, x: string) => void,
) {
  const opens = close - lock;
  const left = `${secs(close - c.at_ns)} s before close (lock ${secs(lock)} s)`;
  if (c.method === "post_intent") {
    add(c.at_ns < opens ? "PASS" : "FAIL", `intent ${s} timing`, `posted ${left}: before the lock`);
    return;
  }
  if (c.at_ns >= close) add("FAIL", `intent ${s} timing`, `revealed ${secs(c.at_ns - close)} s after close_at`);
  else if (c.at_ns >= opens) add("PASS", `intent ${s} timing`, `revealed ${left}: inside [close_at - lock, close_at)`);
  else add("INFO", `intent ${s} timing`, `revealed ${left}: before the lock opened (legal; public sooner)`);
  const commit = commits.filter((x) => x.args.agent_pk === pk && x.at_ns <= c.at_ns).at(-1);
  if (!commit) add("SKIP", `intent ${s} commit`, "the commitment's receipt is not in the scanned txs");
  else
    add(
      commit.at_ns < opens ? "PASS" : "FAIL",
      `intent ${s} commit`,
      `committed ${secs(close - commit.at_ns)} s before close: before the lock, tx ${commit.tx}`,
    );
}

/** Deploy 18: keeper bonds of keyless slots committed and never revealed, which the finish pays to owner fees. Only an
 *  agent's last commit can be open at the finish: a slot is replaced only once revealed or never committed. */
export function keeperForfeits(calls: ReturnType<typeof duelCalls>): bigint {
  let sum = 0n;
  for (const agent of new Set(calls.completions.map((c) => String(c.args.agent)))) {
    const last = calls.completions.filter((c) => c.args.agent === agent).at(-1)!;
    if (!calls.reveals.some((r) => r.args.agent === agent && r.at_ns >= last.at_ns)) sum += last.deposit;
  }
  return sum;
}

/** A keyless agent's scored decision (deploy 18), from its slot receipt and the one that filled it alone
 *  (`submit_completion`, or the first draft's commit then reveal): the request bytes rebuilt from chain state hash to
 *  the slot's request_hash, the slot's price is the oracle's, the enclave key pinned to the agent's model signed
 *  `model:request_hash:sha256(response)`, and the response's content parses to the side and size the contract
 *  recorded. */
function keyless(
  e: Evidence,
  s: string,
  d: Duel,
  ag: AgentView,
  kl: { strategy: string; template: number },
  stored: Intent,
  calls: ReturnType<typeof duelCalls>,
  lockNs: bigint | null,
  add: (r: Line["result"], c: string, x: string) => void,
) {
  const pk = ag.pk;
  type SlotValue = {
    seq: string;
    nonce: string;
    opened_at: string;
    price: string;
    seen: number;
    heads: number;
    request_hash: string;
  };
  const open = calls.slots.find(
    (c) => c.args.agent === pk && String((c.value as SlotValue | null)?.seq) === stored.nonce,
  );
  const sub = calls.submissions.find((c) => c.args.agent === pk && String(c.args.seq) === stored.nonce);
  const commit = calls.completions.find((c) => c.args.agent === pk && String(c.args.seq) === stored.nonce);
  const reveal = commit && calls.reveals.find((c) => c.args.agent === pk && c.at_ns >= commit.at_ns);
  const filled = sub ?? commit; // carries the enclave signer and signature
  add(
    "INFO",
    `keyless ${s}`,
    `no agent key: template ${kl.template}, strategy "${short(kl.strategy, 60)}"; decision = slot ${stored.nonce}`,
  );
  const body = sub ?? reveal; // carries the response bytes
  if (!open || !filled || !body) {
    add(
      "SKIP",
      `keyless ${s} slot`,
      `open_slot, or the submit_completion (or commit and reveal) of slot ${stored.nonce}, is not in the scanned txs`,
    );
    return;
  }
  const slot = open.value as SlotValue;
  // the price the request showed: the newest oracle tick stamped before close that landed before the slot, else open
  const tick = calls.ticks
    .filter((c) => c.at_ns <= BigInt(slot.opened_at))
    .map((c) => c.args.data as { timestamp: string; prices: OraclePrice[] })
    .filter((x) => BigInt(x.timestamp) < BigInt(d.close_at))
    .sort((x, y) => (BigInt(x.timestamp) < BigInt(y.timestamp) ? -1 : 1))
    .at(-1);
  const tp = tick?.prices.find((x) => x.asset_id === d.symbol)?.price;
  const want = tp ? String(price8(tp)) : d.open_price;
  add(
    slot.price === want ? "PASS" : "FAIL",
    `keyless ${s} price`,
    `slot ${slot.seq} shows ${usd(BigInt(slot.price))}: ${tp ? "the newest oracle tick before it" : "the oracle open price"} is ${want ? usd(BigInt(want)) : "none"}`,
  );
  const heads = Array.from({ length: slot.seen }, (_, i) => i).filter((i) => slot.heads & (1 << i));
  const recs = heads.map((i) => e.chaos?.[i]);
  if (heads.length && !recs.every((c) => c && c.target === pk)) {
    add(
      e.chaos ? "FAIL" : "SKIP",
      `keyless ${s} request`,
      e.chaos ? `the slot carries a headline not aimed at side ${s}` : "get_chaos was not read",
    );
    return;
  }
  let req: Uint8Array;
  try {
    const inputs: KeylessInputs = {
      template_version: kl.template,
      model_id: ag.model_id,
      strategy: kl.strategy,
      symbol: d.symbol,
      open_price: d.open_price ?? "0",
      price: slot.price,
      seconds_left: String((BigInt(d.close_at) - BigInt(slot.opened_at)) / 1_000_000_000n),
      duel_id: d.id,
      seq: slot.seq,
      nonce: slot.nonce,
      headlines: recs.map((c) => ({ text: c!.headline, arm: c!.arm })),
    };
    req = keylessRequest(inputs);
  } catch (x) {
    add("FAIL", `keyless ${s} request`, `the slot's inputs do not build a request: ${(x as Error).message}`);
    return;
  }
  const reqHash = new Uint8Array(createHash("sha256").update(req).digest());
  add(
    b64.enc(reqHash) === slot.request_hash ? "PASS" : "FAIL",
    `keyless ${s} request`,
    `rebuilt from chain state (price, ${heads.length} headline(s), nonce ${short(hex(b64.dec(slot.nonce)), 10)}): ${req.length} bytes, sha256 ${short(hex(reqHash), 10)} = slot request_hash (open_slot tx ${open.tx})`,
  );
  const response = b64.dec(String(body.args.response));
  const resHash = new Uint8Array(createHash("sha256").update(response).digest());
  if (sub)
    add(
      "INFO",
      `keyless ${s} response`,
      `submitted ${response.length} bytes in one step (tx ${sub.tx}, by ${sub.signer}), sha256 ${short(hex(resHash), 10)}`,
    );
  else
    add(
      b64.enc(resHash) === filled.args.response_hash ? "PASS" : "FAIL",
      `keyless ${s} response`,
      `revealed ${response.length} bytes (tx ${body.tx}), sha256 ${short(hex(resHash), 10)} = committed response_hash (tx ${filled.tx}, by ${filled.signer})`,
    );
  const signer = String(filled.args.signer);
  // undefined: the read errored (see readModelSigners), which says nothing about the pin: SKIP, never FAIL
  const model = e.model_signers?.[signer];
  add(
    sub ? (model === undefined ? "SKIP" : model === ag.model_id ? "PASS" : "FAIL") : e.pinned[signer] ? "PASS" : "FAIL",
    `keyless ${s} TEE signer`,
    sub
      ? `${short(signer, 12)} get_model_signer = ${model === undefined ? "unread (the RPC read failed; re-run)" : model} (read now), agent model ${ag.model_id}`
      : `${short(signer, 12)} is_tee_signer = ${e.pinned[signer] ?? "unknown"} (read now)`,
  );
  add(
    verify(signer, teeText(2, ag.model_id, reqHash, resHash), String(filled.args.signature)) ? "PASS" : "FAIL",
    `keyless ${s} TEE signature`,
    `enclave ed25519 over "${ag.model_id}:${short(hex(reqHash), 10)}:${short(hex(resHash), 10)}"`,
  );
  add(
    proofHash(reqHash, resHash) === stored.proof_hash ? "PASS" : "FAIL",
    `keyless ${s} proof_hash`,
    `sha256(request_hash || response_hash) = intent proof_hash ${short(stored.proof_hash, 12)}`,
  );
  const got = parseDecision(response, slot.heads !== 0);
  add(
    got && got.side === stored.side && got.size_bps === stored.size_bps ? "PASS" : "FAIL",
    `keyless ${s} decision`,
    `choices[0].message.content reads ${got ? `${got.side} ${got.size_bps} bps` : "no decision"}; the contract recorded ${stored.side} ${stored.size_bps} bps`,
  );
  const close = BigInt(d.close_at);
  const ttlOk = filled.at_ns < BigInt(slot.opened_at) + SLOT_TTL_NS;
  const lockOk = lockNs === null || filled.at_ns + lockNs < close;
  add(
    ttlOk && lockOk && body.at_ns < close ? "PASS" : "FAIL",
    `keyless ${s} timing`,
    `${sub ? "submitted" : "committed"} ${secs(filled.at_ns - BigInt(slot.opened_at))} s after the slot opened (TTL ${secs(SLOT_TTL_NS)} s), ${secs(close - filled.at_ns)} s before close${lockNs === null ? "" : ` (lock ${secs(lockNs)} s)`}${sub ? "" : `; revealed ${secs(close - body.at_ns)} s before close`}`,
  );
}

/** Deploy 15 refunds the opener everything above the duel's storage and the oracle deposit. The storage is the
 *  arena's storage_usage delta across the open block, exact only when no other arena receipt ran in that block. */
function openerRefund(e: Evidence, open: Call, add: (r: Line["result"], c: string, x: string) => void) {
  const refund = transfersFromArena(e.txs, e.arena, open.tx, open.predecessor);
  const ob = e.open_block;
  if (!ob?.config.oracle_deposit)
    return add("INFO", "opener refund", `refund ${near(refund)} NEAR; state at the open block not available`);
  const v15 = !!ob.config.intents_account;
  const bytes = BigInt(ob.storage_after - ob.storage_before);
  const cost = bytes * STORAGE_BYTE_COST;
  const oracle = BigInt(ob.config.oracle_deposit);
  if (!v15)
    return add(
      "INFO",
      "opener refund",
      `deploy 14 refunds nothing: attached ${near(open.deposit)}, refund ${near(refund)} NEAR`,
    );
  if ((ob.others ?? 0) > 0)
    return add(
      "INFO",
      "opener refund",
      `refund ${near(refund)} of ${near(open.deposit)} NEAR attached; storage not derivable (${ob.others} other arena receipts in the open block)`,
    );
  const want = open.deposit - cost - oracle;
  add(
    refund === want ? "PASS" : "FAIL",
    "opener refund",
    `attached ${near(open.deposit)} - storage ${bytes} B (${near(cost)}) - oracle deposit ${near(oracle)} = ${near(want)} NEAR, refunded ${near(refund)}`,
  );
}
/** yoctoNEAR per byte of storage (NEAR protocol constant). */
const STORAGE_BYTE_COST = 10n ** 19n;

/** Evidence a later read can complete: the duel is scored (or voided) but its closing receipt (close callback, void,
 *  or the operator era's resolve) is not in the scanned txs yet (FastNEAR's index trails the RPC right after
 *  resolution), or a past-block read failed: the state at the closing block, an injection block's pools, the open
 *  block, or duel_lock on a deploy-15 contract. A result from it is not final. Fields absent from evidence saved
 *  before they existed do not count. Open duels and duels resolved without an outcome (#0-21) are never incomplete. */
export function incomplete(e: Evidence): boolean {
  const d = e.now.duel;
  if (!d?.resolved || !d.outcome) return false;
  const c = duelCalls(arenaCalls(e.txs, e.arena), e.duel_id);
  if (!c.closing || !e.before || !e.after) return true;
  if (e.chaos_pools && c.chaos.some((x) => !e.chaos_pools?.[x.block_hash])) return true;
  if (c.open && e.open_block === null) return true;
  if (e.now.config.chaos && e.chaos === null) return true; // deploy 17 has get_chaos: null = a failed read
  return !!e.now.config.intents_account && e.lock_ns === null;
}

/** Injections: payer, kind and target of every successful inject_chaos, the count the contract kept, and where each
 *  deposit went. Deploy 15 sends chaos paid by either agent's owner to owner_fees; the rest (minus its storage) and
 *  all chaos before deploy 15 joins the pool, which the duel's pool delta across each injection's block shows.
 *  Deploy 17 also sends the contract owner's placebos to owner_fees, and each receipt returns its record's index in
 *  get_chaos: the record must be that call (payer, target, kind, headline), and the pool must grow by its stake. */
function chaos(
  e: Evidence,
  d: Duel,
  list: Call[],
  v15: boolean,
  v17: boolean,
  straddled: string | null,
  out: Line[],
  add: (r: Line["result"], c: string, x: string) => void,
) {
  const owners = new Set([e.now.a?.owner, e.now.b?.owner]);
  const self = (c: Call) => owners.has(c.predecessor);
  const placebo = (c: Call) => v17 && c.args.kind === "Placebo";
  const rec = (c: Call) => (v17 && typeof c.value === "number" ? e.chaos?.[c.value] : undefined);
  for (const c of list) {
    const target = String(c.args.target);
    const r = rec(c);
    const where = placebo(c)
      ? " -> owner fees (placebo: the contract owner's control arm)"
      : !self(c)
        ? " -> pool"
        : straddled
          ? " (payer owns an agent; pool or owner fees depending on the deploy it landed under)"
          : v15
            ? " -> owner fees (self-chaos: the payer owns an agent in this duel)"
            : " -> pool (payer owns an agent; deploy 14 had no self-chaos rule)";
    add(
      "INFO",
      "injection",
      `${c.predecessor} paid ${near(c.deposit)} NEAR: kind "${c.args.kind}" at ${target === d.a ? "A" : "B"}${where}, tx ${c.tx}` +
        (r
          ? `; record #${c.value}: arm ${r.arm}, stake ${near(BigInt(r.stake))}, ${r.outcome}, payout ${near(BigInt(r.payout))}`
          : ""),
    );
  }
  const kept = d.outcome ? d.outcome.injections : d.injections.length;
  add(
    list.length === kept ? "PASS" : "SKIP",
    "injections",
    `${list.length} successful inject_chaos receipts found, contract counts ${kept}${list.length === kept ? "" : " (some outside the scanned txs)"}`,
  );
  if (v17 && !e.chaos) add("SKIP", "chaos records", "get_chaos was not read");
  else if (v17 && e.chaos) {
    const unpaid = (c: Call) => self(c) || placebo(c);
    const off = list.filter((c) => {
      const r = rec(c);
      return (
        !r ||
        r.injector !== c.predecessor ||
        r.target !== c.args.target ||
        r.kind !== c.args.kind ||
        r.headline !== c.args.headline ||
        (r.stake === "0") !== unpaid(c) ||
        BigInt(r.stake) > c.deposit
      );
    });
    add(
      off.length || e.chaos.length !== kept ? "FAIL" : "PASS",
      "chaos records",
      `get_chaos lists ${e.chaos.length}, contract counts ${kept}; each receipt's returned index names a record with its payer, target, kind and headline, stake 0 only when an agent's owner or the contract owner paid` +
        (off.length ? `: ${off.length} do not (tx ${off.map((c) => c.tx).join(", ")})` : ""),
    );
  }
  if (!e.chaos_pools || !list.length) return out;
  if (straddled || (v17 && !e.chaos)) {
    add("SKIP", "injection deposits", straddled ? `not judged: ${straddled}` : "get_chaos was not read");
    return out;
  }
  const blocks = new Map<string, Call[]>();
  for (const c of list) blocks.set(c.block_hash, [...(blocks.get(c.block_hash) ?? []), c]);
  let bad = 0;
  let missing = 0;
  let added = 0n;
  let toPool = 0n;
  for (const [blk, cs] of blocks) {
    const pp = e.chaos_pools[blk];
    if (!pp) {
      missing++;
      continue;
    }
    const delta = BigInt(pp[1]) - BigInt(pp[0]);
    const paid = cs.filter((c) => !(v15 && self(c)) && !placebo(c)).reduce((s, c) => s + c.deposit, 0n);
    added += delta;
    toPool += paid;
    if (v17) {
      // exact: the pool grows by the stakes the records hold (deposit less storage; 0 when unpaid)
      const stakes = cs.map((c) => rec(c)?.stake);
      if (stakes.some((x) => x === undefined) || delta !== stakes.reduce((s, x) => s + BigInt(x!), 0n)) bad++;
    } else if (paid === 0n ? delta !== 0n : delta <= 0n || delta > paid) bad++;
  }
  const nSelf = v15 ? list.filter((c) => self(c) || placebo(c)).length : 0;
  add(
    bad ? "FAIL" : missing ? "SKIP" : "PASS",
    "injection deposits",
    `${list.length - nSelf} into the pool: +${near(added)} NEAR of ${near(toPool)} paid (the rest is their storage)` +
      `${v17 ? ", each block's growth the sum of its records' stakes" : ""}` +
      `${v15 ? `; ${nSelf} ${v17 ? "paid by an agent's owner or placebo" : "self-paid"}, pool unchanged by them` : ""}${bad ? `; ${bad} blocks off` : ""}${missing ? `; ${missing} blocks without state` : ""}`,
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

/** The hash of the block before `block` (state there is what a receipt in `block` started from). */
async function prevHash(block: string): Promise<string> {
  for (const url of [RPC, ARCHIVAL]) {
    const r = await post<RpcRes>(url, { jsonrpc: "2.0", id: 1, method: "block", params: { block_id: block } });
    if (r.result?.header?.prev_hash) return r.result.header.prev_hash;
  }
  throw new Error(`block ${block}: not served`);
}

/** The arena account's storage_usage (bytes) after `block`. */
async function storageAt(arena: string, block: string): Promise<number> {
  const params = { request_type: "view_account", account_id: arena, block_id: block };
  for (const url of [RPC, ARCHIVAL]) {
    const r = await post<{ result?: { storage_usage?: number } }>(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params,
    });
    if (r.result?.storage_usage !== undefined) return r.result.storage_usage;
  }
  throw new Error(`view_account at ${block}: not served`);
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
  const fin = calls.closing;
  let before: State | null = null;
  let after: State | null = null;
  if (fin) {
    try {
      const prev = await prevHash(fin.block_hash);
      [before, after] = await Promise.all([state(arena, id, prev), state(arena, id, fin.block_hash)]);
    } catch {} // pruned and no archival answer: the payout line says SKIP
  }
  const proofs = calls.intents.map((c) => c.args.tee as TeeProof | null).filter((p): p is TeeProof => !!p);
  const pinned: Record<string, boolean> = {};
  for (const p of proofs) pinned[p.signer] ??= await viewAt<boolean>(arena, "is_tee_signer", { signer: p.signer });
  for (const c of calls.completions)
    pinned[String(c.args.signer)] ??= await viewAt<boolean>(arena, "is_tee_signer", { signer: c.args.signer });
  const model_signers: Evidence["model_signers"] = await readModelSigners(
    calls.submissions.map((c) => String(c.args.signer)),
    (signer) => viewAt<string | null>(arena, "get_model_signer", { signer }),
  );
  // deploy 18: which side is keyless (a contract without the view has none)
  const keyless: Evidence["keyless"] = {};
  for (const pk of [d.a, d.b])
    keyless[pk] = await viewAt<{ strategy: string; template: number } | null>(arena, "get_keyless", {
      agent: pk,
    }).catch(() => null);
  const stored = [d.last_intent_a, d.last_intent_b].flatMap((i) => (i ? [i.proof_hash] : []));
  // deploy 15: the duel's own lock, where each injection's deposit went, and the opener's refund
  const lock = await viewAt<string | null>(arena, "duel_lock", { duel_id: id }).catch(() => null);
  const chaos_pools: Record<string, [string, string]> = {};
  for (const blk of new Set(calls.chaos.map((c) => c.block_hash)))
    try {
      const prev = await prevHash(blk);
      const [x, y] = await Promise.all([
        viewAt<Duel | null>(arena, "get_duel", { duel_id: id }, prev),
        viewAt<Duel | null>(arena, "get_duel", { duel_id: id }, blk),
      ]);
      if (x && y) chaos_pools[blk] = [x.pool, y.pool];
    } catch {} // pruned: that block's line says SKIP
  let open_block: Evidence["open_block"] = null;
  if (calls.open)
    try {
      const blk = calls.open.block_hash;
      const prev = await prevHash(blk);
      const [storage_before, storage_after, config] = await Promise.all([
        storageAt(arena, prev),
        storageAt(arena, blk),
        viewAt<Config>(arena, "get_config", {}, blk),
      ]);
      const others = arenaCalls(txs, arena).filter((c) => c.ok && c.block_hash === blk).length - 1;
      open_block = { storage_before, storage_after, config, others };
    } catch {} // pruned: the refund line says INFO
  // deploy 17: every planted headline's record (stake, outcome, payout), kept after the finish
  const chaos = now.config.chaos ? await viewAt<Chaos[]>(arena, "get_chaos", { duel_id: id }).catch(() => null) : null;
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
    lock_ns: lock,
    chaos_pools,
    open_block,
    chaos,
    keyless,
    model_signers,
  };
}

/** The evidence with only the txs that carry one of this duel's receipts (what --save keeps). */
export function ownTxs(e: Evidence): Evidence {
  const c = duelCalls(arenaCalls(e.txs, e.arena), e.duel_id);
  const mine = [
    c.open,
    c.oracle("open"),
    c.closing,
    ...c.intents,
    ...c.commits,
    ...c.chaos,
    ...c.slots,
    ...c.submissions,
    ...c.completions,
    ...c.reveals,
    ...c.ticks,
  ];
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
  if (incomplete(e)) console.log("evidence incomplete (close receipt or its block state not read yet): re-run later");
  process.exit(fails ? 1 : 0);
}
