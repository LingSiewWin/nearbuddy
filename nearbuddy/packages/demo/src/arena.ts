// Arena demo: a follower deposits NEAR and follows the live enclave agent A (the runner's
// TEE-proved key derived from AGENT_SEED_A; only enclave-verified agents can be followed) under a mandate
// (cap 0.2 NEAR). Two plain demo agents open a duel and a spectator pays on chain to inject chaos at the
// plain A. The enclave agent's latest intents are read from chain and its newest nonce is quoted through
// 1Click (dry, mainnet prices); the solver settles one fill inside the cap, then a batch over the cap /
// wrong token / replayed nonce is rejected on chain, the mandate is revoked and the next fill refused, then
// anyone asks the Outlayer oracle to resolve the plain duel. The mandate is left revoked; the next run's `follow` replaces it.
//   pnpm arena-demo            (solver must be running: pnpm solver)
import "../../protocol/src/env.ts";
import { sign as edSign } from "node:crypto";
import { teraToGas } from "near-api-js";
import type { Outcome } from "../../protocol/src/abi/arena.ts";
import {
  ARENA,
  arenaView,
  explorerTx,
  fmtNear,
  isDeploy15,
  loadAccount,
  NEAR,
  priceFloor,
} from "../../protocol/src/chain.ts";
import { b64 } from "../../protocol/src/index.ts";
import {
  type Intent,
  intentMessage,
  keyFromSeed,
  pkOf,
  type SignedIntent,
  teeSeed,
  ZERO_PROOF,
} from "../../protocol/src/intent.ts";
import { NET } from "../../protocol/src/network.ts";
import { quote, sellNearForUsdc, USDC_NEAR } from "../../solver/src/oneclick.ts";

const SOLVER_URL = process.env.SOLVER_URL ?? "http://127.0.0.1:4020";
const FOLLOWER_ID = process.env.FOLLOWER_ID ?? NET.owner;
const SOLVER_ID = process.env.SOLVER_ID ?? NET.solver;
const CAP = NEAR / 5n; // 0.2 NEAR per fill
const DUEL_SECONDS = Number(process.env.DUEL_SECONDS ?? 330); // the Outlayer oracle caches a price for 300 s; a shorter duel would close on its own open price (the contract enforces min_duel_s)

const seedA = process.env.AGENT_SEED_A,
  seedB = process.env.AGENT_SEED_B;
if (!seedA || !seedB || !process.env.ARENA_SECRET)
  throw new Error("AGENT_SEED_A, AGENT_SEED_B and ARENA_SECRET must be set in the env file");
const skA = keyFromSeed(seedA),
  skB = keyFromSeed(seedB);
const pkA = pkOf(skA),
  pkB = pkOf(skB);
// the live enclave agent (agents/runner.py, tee=True) is a distinct registration under a key derived from the same seed
const teeA = pkOf(keyFromSeed(teeSeed(seedA)));

const post = async <T = { tx: string }>(path: string, body: unknown): Promise<T> => {
  const r = await fetch(`${SOLVER_URL}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-arena-key": process.env.ARENA_SECRET ?? "" },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
  return j as T;
};
type Settled = { tx: string; report: { rejected?: [number, string][] } };
/** Deploy 15 pays only for output delivered to the arena: the solver stub-credits it on testnet (empty swap_tx), and a
 *  batch with nothing settled is a refused transaction, reported here as its reason. Deploy 14 returns every
 *  rejection in the report. */
const DEPLOY15 = await isDeploy15();
const settle = async (fills: unknown[]): Promise<Settled & { refused?: string }> => {
  try {
    return await post<Settled>("/settle_follow", { agent_pk: teeA, follower: FOLLOWER_ID, fills });
  } catch (e) {
    if (!DEPLOY15) throw e;
    return { tx: "", report: {}, refused: String(e).slice(0, 300) };
  }
};
const shown = (s: Settled & { refused?: string }) => (s.refused ? `refused: ${s.refused}` : JSON.stringify(s.report));
const line = (label: string, tx: string, extra = "") => console.log(`${label.padEnd(18)} ${explorerTx(tx)} ${extra}`);

/** The agent's latest posted intent nonces, newest first, read from its duels on chain: `agent_duels` (indexed
 *  from deploy 10 on) first, then the tail of all duels when the index is missing or still short. */
const agentNonces = async (pk: string, want: number): Promise<string[]> => {
  const ids = await arenaView("agent_duels", { agent_pk: pk, from: 0, limit: 8 }).catch(() => [] as string[]);
  if (ids.length < want + 1) {
    const n = Number((await arenaView("get_config", {})).next_duel);
    for (let id = n - 1; id >= Math.max(0, n - 12); id--) if (!ids.includes(String(id))) ids.push(String(id));
  }
  const out: string[] = [];
  for (const id of ids) {
    const d = await arenaView("get_duel", { duel_id: id });
    const last = d?.a === pk ? d.last_intent_a : d?.b === pk ? d.last_intent_b : null;
    if (last && !out.includes(last.nonce)) out.push(last.nonce);
    if (out.length >= want) return out;
  }
  throw new Error(
    `enclave agent ${pk.slice(0, 12)}… has ${out.length} posted intents in its last ${ids.length} duels, need ${want}: is the agent loop running?`,
  );
};

const follower = loadAccount(FOLLOWER_ID);
const call = async (methodName: string, args: Record<string, unknown>, deposit = 0n) => {
  const r = await follower.callFunctionRaw({ contractId: ARENA, methodName, args, gas: teraToGas("60"), deposit });
  const st = r.status as { SuccessValue?: string };
  if (st.SuccessValue === undefined) throw new Error(`${methodName}: ${JSON.stringify(r.status).slice(0, 200)}`);
  return r.transaction.hash;
};

console.log(`arena ${ARENA}  follower ${FOLLOWER_ID}  plain agent A ${pkA.slice(0, 12)}…  enclave agent A ${teeA}`);

// quote the mandate's cap through 1Click (dry, mainnet prices), as the solver does for each open follower; its rate
// less 5 % is the mandate's price floor (deploy 15 refuses a follow without one)
const q = await quote(sellNearForUsdc(CAP, SOLVER_ID.replace(/\.testnet$/, ".near")));
const floor = priceFloor(CAP, BigInt(q.quote.amountOut));
// deploy 15 credits the output token itself (USDC from a NEAR sale); deploy 14 kept the mandate in wNEAR
const TOKEN = DEPLOY15 ? USDC_NEAR : "nep141:wrap.near";

// 1. follower deposits and follows the enclave agent A with a mandate (a plain agent is refused: "agent unverified")
line("deposit 1 NEAR", await call("deposit", {}, NEAR));
line(
  "follow enclave A",
  await call("follow", {
    agent_pk: teeA,
    mandate: {
      allowance: NEAR.toString(),
      spent: "0",
      per_tx_cap: CAP.toString(),
      allowed_tokens: [TOKEN],
      expires_at: ((Date.now() + 86_400_000) * 1_000_000).toString(),
      revoked: false,
      min_out_per_near: floor.toString(),
    },
  }),
  `cap ${fmtNear(CAP)} NEAR, allowance 1 NEAR, ${DEPLOY15 ? "USDC" : "wNEAR"} only, floor ${floor} per NEAR`,
);

// 2. open a duel; a spectator pays the deposit on chain to inject chaos at A
const closeAt = (Math.floor(Date.now() / 1000) + DUEL_SECONDS) * 1_000_000_000;
const duel = await post<{ tx: string; duel_id: string }>("/duel", {
  a: pkA,
  b: pkB,
  symbol: "wrap.near",
  close_at: String(closeAt),
});
line("open duel", duel.tx, `duel ${duel.duel_id}`);
// spectator path: hand the solver the payload (open route), then pay for the injection on chain yourself
const payload = "BREAKING: NEAR Foundation halts all validator rewards effective immediately.";
const { payload_hash } = await post<{ payload_hash: string }>("/chaos", { payload });
const minChaos = BigInt((await arenaView("get_config", {})).min_chaos_deposit);
line(
  "inject chaos @A",
  await call("inject_chaos", { duel_id: duel.duel_id, target: pkA, kind: "fake_news", payload_hash }, minChaos),
  `spectator ${FOLLOWER_ID} paid ${fmtNear(minChaos)} NEAR, sha256 ${payload_hash.slice(0, 12)}…`,
);

// 3. the plain A posts a signed intent into its duel (scored at resolve; a plain agent has no followers to quote)
const intent: Intent = {
  agent_pk: pkA,
  duel_id: duel.duel_id,
  side: "Long",
  size_bps: 5000,
  nonce: String(Date.now()),
  expires_at: String(closeAt + 60_000_000_000),
  proof_hash: ZERO_PROOF,
};
const signed: SignedIntent = { intent, signature: b64.enc(new Uint8Array(edSign(null, intentMessage(intent), skA))) };
line("post intent A", (await post("/intent", signed)).tx);
// the enclave agent's two latest intents, posted by the runner with TEE proofs: one to settle, one for the rejections
const [nonce, nonce2] = await agentNonces(teeA, 2);
console.log(`enclave A latest nonces ${nonce}, ${nonce2}`);
console.log(
  `1Click dry quote: sell ${fmtNear(CAP)} wNEAR -> ${q.quote.amountOutFormatted} USDC (min ${Number(q.quote.minAmountOut) / 1e6}), ${q.quote.timeEstimate}s`,
);

// 4. settle one fill inside the cap, then one over the cap. Deploy 14 takes the dry quote as the swap; deploy 15
// refuses `dry-quote:` and the solver credits the output to the arena on the testnet stub (empty swap_tx).
const ok = await settle([
  {
    intent_nonce: nonce,
    token: TOKEN,
    amount_in: CAP.toString(),
    amount_out: q.quote.amountOut,
    swap_tx: DEPLOY15 ? "" : `dry-quote:${q.timestamp}`,
  },
]);
if (ok.refused) throw new Error(`fill inside the cap was refused: ${ok.refused}`);
line("settle fill", ok.tx, shown(ok));
// the older nonce: one fill over the cap, one with a token outside the allowlist; and the settled nonce replayed
const over = await settle([
  {
    intent_nonce: nonce2,
    token: TOKEN,
    amount_in: (CAP + 1n).toString(),
    amount_out: "0",
    swap_tx: "over-cap",
  },
  { intent_nonce: nonce2, token: "nep141:usdc.near", amount_in: "1", amount_out: "0", swap_tx: "wrong-token" },
  {
    intent_nonce: nonce,
    token: TOKEN,
    amount_in: CAP.toString(),
    amount_out: q.quote.amountOut,
    swap_tx: "replay",
  },
]);
line("settle rejected", over.tx, shown(over));
// revoke: the follower unfollows. Deploy 14 refuses the very next fill; deploy 15 still settles a fill landing within
// withdraw_delay (the swap may have been fronted before the unfollow) and refuses it after
line("unfollow enclave A", await call("unfollow", { agent_pk: teeA }));
const revoked = await settle([
  { intent_nonce: nonce2, token: TOKEN, amount_in: "1", amount_out: "1", swap_tx: "after-revoke" },
]);
line("settle after revoke", revoked.tx, shown(revoked));
if (DEPLOY15 ? revoked.refused !== undefined : !shown(revoked).includes("mandate revoked"))
  throw new Error(`fill after unfollow: unexpected ${shown(revoked)}`);
const vault = await arenaView("get_vault", { account: FOLLOWER_ID });
const mandate = await arenaView("get_follow", { agent_pk: teeA, follower: FOLLOWER_ID });
console.log(
  `follower vault ${fmtNear(vault)} NEAR, mandate spent ${mandate ? fmtNear(mandate.spent) : "(no follow)"} NEAR`,
);

// 5. past close: ask the Outlayer TEE oracle for the close price (anyone may); its callback finishes the duel
await new Promise((r) => setTimeout(r, Math.max(0, closeAt / 1_000_000 - Date.now() + 2_000)));
const before = await arenaView("get_duel", { duel_id: duel.duel_id });
const resolved = await post("/resolve", { duel_id: duel.duel_id });
line(
  "resolve duel",
  resolved.tx,
  `open price ${before?.open_price ? (Number(before.open_price) / 1e8).toFixed(4) : "pending"} USD, oracle ${NET.oracle}`,
);
let outcome: Outcome | null = null;
for (let i = 0; i < 20 && !outcome; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  outcome = (await arenaView("get_duel", { duel_id: duel.duel_id }))?.outcome ?? null;
}
if (!outcome) throw new Error("oracle callback did not land within 60 s; retry: POST /resolve");
console.log(
  `outcome: ${(Number(outcome.open_price) / 1e8).toFixed(4)} -> ${(Number(outcome.close_price) / 1e8).toFixed(4)} USD  A ${outcome.pnl_a} bps  B ${outcome.pnl_b} bps  ${outcome.winner ? `winner ${outcome.winner === pkA ? "A" : "B"}, slashed ${fmtNear(outcome.slashed)} NEAR` : "tie"}`,
);
const a = await arenaView("get_agent", { agent_pk: pkA });
if (!a) throw new Error(`agent A ${pkA.slice(0, 12)}… is not registered`);
console.log(`agent A: alpha ${a.alpha_bps} bps, shield ${a.shield}, bond ${fmtNear(a.bond)} NEAR, tee ${a.tee}`);
