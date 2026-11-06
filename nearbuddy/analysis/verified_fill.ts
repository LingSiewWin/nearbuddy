// Live proof of deploy-15 verified settlement on the arena (ARENA_CONTRACT, testnet by default), with tx hashes:
//   1. a fill whose output never reached the arena is refused ("no receipt")
//   2. a vault withdrawal inside withdraw_delay_s is refused ("withdrawal delay not elapsed")
//   3. a verified fill end to end: deposit, follow a live enclave agent with a price floor from a 1Click quote,
//      the output credited to the arena on the intents stub (stub_credit, signed by the solver), settle_follow,
//      holding == amount_out, then withdraw_token to the follower's own stub balance
//   4. request_withdraw, then withdraw once the delay has passed
// Sends real testnet transactions from FOLLOWER_ID (create it first, e.g. with the faucet) and SOLVER_ID (the arena's
// registered solver; it signs stub_credit and the two settle_follow calls, two or three txs in all). The live solver
// shares that key; near-api-js retries a nonce clash.
//   FOLLOWER_ID=nearbuddy-follower2.testnet bun analysis/verified_fill.ts
// Env: SOLVER_RPC (endpoint the solver signs on), AGENT_PK (a followable enclave agent; default the first one on
// the leaderboard with a revealed intent), CAP_YOCTO (per-fill cap, 0.1 NEAR), SKIP_DELAY=1 (stop before the 900 s wait).
import "../packages/protocol/src/env.ts";
import { Account, JsonRpcProvider, teraToGas } from "near-api-js";
import {
  ARENA,
  arenaView,
  explorerTx,
  fmtNear,
  loadAccount,
  loadKey,
  NEAR,
  priceFloor,
  provider,
} from "../packages/protocol/src/chain.ts";
import { NET, NETWORK_ID } from "../packages/protocol/src/network.ts";
import { quote, sellNearForUsdc, USDC_NEAR } from "../packages/solver/src/oneclick.ts";

// stub_credit mints output out of thin air and both accounts spend NEAR: refuse before any RPC call off testnet.
if (NETWORK_ID !== "testnet") throw new Error(`verified_fill.ts runs on testnet only, not NEAR_NETWORK=${NETWORK_ID}`);

const FOLLOWER = process.env.FOLLOWER_ID ?? "nearbuddy-follower2.testnet";
const SOLVER = process.env.SOLVER_ID ?? NET.solver;
const CAP = BigInt(process.env.CAP_YOCTO ?? (NEAR / 10n).toString());
const DEPOSIT = NEAR;
const WITHDRAW = (NEAR * 3n) / 10n;

type Out = { hash: string; ok: boolean; value: unknown; failure: string };
type Outcome = { status: { SuccessValue?: string; Failure?: unknown }; transaction: { hash: string } };
// near-api-js throws on a failed tx; the outcome (and its hash) rides on the error as `transactionResult`
async function send(acct: Account, contractId: string, methodName: string, args: object, deposit = 0n): Promise<Out> {
  const r = (await acct
    .callFunctionRaw({ contractId, methodName, args, deposit, gas: teraToGas("150") })
    .catch((e: { transactionResult?: Outcome }) => {
      if (e.transactionResult) return e.transactionResult;
      throw e;
    })) as Outcome;
  const ok = r.status.SuccessValue !== undefined;
  const raw = ok ? Buffer.from(r.status.SuccessValue ?? "", "base64").toString() : "";
  return {
    hash: r.transaction.hash,
    ok,
    value: raw ? JSON.parse(raw) : null,
    failure: ok ? "" : JSON.stringify(r.status.Failure ?? r.status),
  };
}
const viewAt = async <T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T> =>
  (await provider.callFunction({ contractId, method, args })) as T;

const rows: [string, string, string][] = [];
function row(step: string, out: Out | null, detail: string, want: boolean | null = null) {
  const verdict = want === null ? "" : want ? "PASS " : "FAIL ";
  rows.push([step, out ? explorerTx(out.hash) : "", `${verdict}${detail}`]);
  console.log(`${step}: ${out ? out.hash : ""} ${verdict}${detail}`);
}

const cfg = await arenaView<{ intents_account?: string; fee_bps: number; withdraw_delay_s: number }>("get_config", {});
if (!cfg.intents_account) throw new Error(`${ARENA} has no intents_account: deploy 15 is not live there`);
const STUB = cfg.intents_account;

// a live enclave agent with an accepted (revealed) intent: its nonce backs the fill
type AgentView = { pk: string; tee: boolean };
type Duel = {
  a: string;
  b: string;
  resolved: boolean;
  last_intent_a: { nonce: string } | null;
  last_intent_b: { nonce: string } | null;
};
let agent = process.env.AGENT_PK ?? "";
let nonce = "";
for (const a of await arenaView<AgentView[]>("leaderboard", { from: 0, limit: 100 })) {
  if (!a.tee || (agent && a.pk !== agent)) continue;
  for (const id of await arenaView<string[]>("agent_duels", { agent_pk: a.pk, from: 0, limit: 8 })) {
    const d = await arenaView<Duel | null>("get_duel", { duel_id: id });
    const last = d?.a === a.pk ? d.last_intent_a : d?.b === a.pk ? d.last_intent_b : null;
    if (d?.resolved && last) {
      agent = a.pk;
      nonce = last.nonce;
      break;
    }
  }
  if (nonce) break;
}
if (!nonce) throw new Error("no enclave agent with a revealed intent in its last 8 duels");
console.log(`arena ${ARENA}, stub ${STUB}, follower ${FOLLOWER}, agent ${agent.slice(0, 12)}… nonce ${nonce}`);

const follower = loadAccount(FOLLOWER);
// The solver key is shared with the live solver, so nonce clashes happen. near-api-js retries them only when the
// provider surfaces InvalidNonceError as is; the shared failover provider wraps it, so sign on a plain one here.
// drpc answers 500 while it waits on settle_follow's receipts, so the default is the network's second endpoint.
const SOLVER_RPC = process.env.SOLVER_RPC ?? NET.fallback;
const solver = new Account(SOLVER, new JsonRpcProvider({ url: SOLVER_RPC }), loadKey(SOLVER));

// the fill: amount + fee fits the cap (deploy 15 counts the fee inside), output from a dry 1Click quote
const amountIn = (CAP * 10_000n) / (10_000n + BigInt(cfg.fee_bps));
const q = await quote(sellNearForUsdc(amountIn, SOLVER.replace(/\.testnet$/, ".near")));
const quoted = BigInt(q.quote.amountOut);
const floor = priceFloor(amountIn, quoted);
// the arena's unaccounted USDC on the stub: the refused fill must claim more than that
const bal = BigInt(await viewAt<string>(STUB, "mt_balance_of", { account_id: ARENA, token_id: USDC_NEAR }));
const accounted = BigInt(await arenaView<string>("get_accounted", { token_id: USDC_NEAR }));
const surplus = bal > accounted ? bal - accounted : 0n;
const amountOut = surplus >= quoted ? surplus + 1n : quoted;
console.log(
  `fill ${fmtNear(amountIn)} NEAR in, ${amountOut} USDC units out (quote ${quoted}), floor ${floor}/NEAR, surplus ${surplus}`,
);

const dep = await send(follower, ARENA, "deposit", {}, DEPOSIT);
row("deposit 1 NEAR", dep, dep.ok ? `vault ${fmtNear(String(dep.value))} NEAR` : dep.failure, dep.ok);
const fol = await send(follower, ARENA, "follow", {
  agent_pk: agent,
  mandate: {
    allowance: (NEAR / 2n).toString(),
    spent: "0",
    per_tx_cap: CAP.toString(),
    allowed_tokens: [USDC_NEAR],
    expires_at: ((BigInt(Date.now()) + 86_400_000n) * 1_000_000n).toString(),
    revoked: false,
    min_out_per_near: floor.toString(),
  },
});
row("follow with a price floor", fol, fol.ok ? `min_out_per_near ${floor}` : fol.failure, fol.ok);

const fill = (swap_tx: string) => ({
  intent_nonce: nonce,
  token: USDC_NEAR,
  amount_in: amountIn.toString(),
  amount_out: amountOut.toString(),
  swap_tx,
});
const settleArgs = (swap_tx: string) => ({ agent_pk: agent, follower: FOLLOWER, fills: [fill(swap_tx)] });

// 1. no receipt: nothing credited for this fill yet
const refused = await send(solver, ARENA, "settle_follow", settleArgs("stub:none"));
row(
  "settle_follow before the output landed",
  refused,
  refused.ok ? "settled?!" : "refused: no receipt",
  !refused.ok && refused.failure.includes("no receipt"),
);

// 3. the verified fill
const credit = await send(solver, STUB, "stub_credit", {
  receiver_id: ARENA,
  token_id: USDC_NEAR,
  amount: amountOut.toString(),
});
row(
  "stub_credit (the swap landing)",
  credit,
  credit.ok ? `${amountOut} USDC units to ${ARENA}` : credit.failure,
  credit.ok,
);
const settled = await send(solver, ARENA, "settle_follow", settleArgs(`stub:${credit.hash}`));
const report = settled.value as { settled?: number; debited?: string } | null;
row(
  "settle_follow against the arena's balance",
  settled,
  settled.ok ? JSON.stringify(report) : settled.failure,
  settled.ok && report?.settled === 1,
);
const holding = BigInt(await arenaView<string>("get_holding", { follower: FOLLOWER, token_id: USDC_NEAR }));
row("holding == amount_out", null, `holding ${holding}, amount_out ${amountOut}`, holding === amountOut);
const out = await send(follower, ARENA, "withdraw_token", { token_id: USDC_NEAR, amount: holding.toString() }, 1n);
const onStub = BigInt(await viewAt<string>(STUB, "mt_balance_of", { account_id: FOLLOWER, token_id: USDC_NEAR }));
row(
  "withdraw_token to the follower's stub balance",
  out,
  out.ok ? `follower holds ${onStub} USDC units on ${STUB}` : out.failure,
  out.ok && onStub >= holding,
);

// 2 and 4. the delayed vault withdrawal
const req = await send(follower, ARENA, "request_withdraw", { amount: WITHDRAW.toString() }, 1n);
row("request_withdraw 0.3 NEAR", req, req.ok ? `due in ${cfg.withdraw_delay_s} s` : req.failure, req.ok);
const early = await send(follower, ARENA, "withdraw", {}, 1n);
row(
  "withdraw inside the delay",
  early,
  early.ok ? "paid?!" : "refused: withdrawal delay not elapsed",
  !early.ok && early.failure.includes("withdrawal delay not elapsed"),
);
if (!process.env.SKIP_DELAY) {
  const [, readyAt] = (await arenaView<[string, string] | null>("get_pending_withdraw", { account: FOLLOWER })) ?? [
    "0",
    "0",
  ];
  const waitMs = Math.max(0, Number((BigInt(readyAt) - BigInt(Date.now()) * 1_000_000n) / 1_000_000n)) + 20_000;
  console.log(`waiting ${Math.round(waitMs / 1000)} s for the delay`);
  await new Promise((r) => setTimeout(r, waitMs));
  const before = BigInt(await arenaView<string>("get_vault", { account: FOLLOWER }));
  const paid = await send(follower, ARENA, "withdraw", {}, 1n);
  const after = BigInt(await arenaView<string>("get_vault", { account: FOLLOWER }));
  row(
    "withdraw after the delay",
    paid,
    paid.ok ? `vault ${fmtNear(before)} -> ${fmtNear(after)} NEAR` : paid.failure,
    paid.ok && before - after === WITHDRAW,
  );
}

console.log("\n| Step | Tx | Result |\n|---|---|---|");
for (const [s, t, d] of rows) console.log(`| ${s} | ${t} | ${d} |`);
process.exit(rows.some(([, , d]) => d.startsWith("FAIL")) ? 1 : 0);
