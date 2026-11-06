// Arena demo: a follower deposits testnet NEAR and follows agent A under a mandate (cap 0.2 NEAR),
// a spectator pays on chain to inject chaos at A, A posts a signed intent, the solver quotes the follower's mandate
// through 1Click (dry, mainnet prices), settles one fill inside the cap and shows a second fill over
// the cap being rejected on chain, revokes the mandate and shows the next fill refused, then anyone
// asks the Outlayer oracle to resolve the duel. The mandate is left revoked; the next run's `follow` replaces it.
//   pnpm arena-demo            (solver must be running: pnpm solver)
import "../../protocol/src/env.ts";
import { createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { teraToGas } from "near-api-js";
import { b64 } from "../../protocol/src/index.ts";
import { ZERO_PROOF, intentMessage, type Intent, type SignedIntent } from "../../protocol/src/intent.ts";
import { ARENA, NEAR, arenaView, explorerTx, fmtNear, loadAccount } from "../../protocol/src/chain.ts";

const SOLVER_URL = process.env.SOLVER_URL ?? "http://127.0.0.1:4020";
const FOLLOWER_ID = process.env.FOLLOWER_ID ?? "nearbuddy-owner.testnet";
const CAP = NEAR / 5n; // 0.2 NEAR per fill
const DUEL_SECONDS = Number(process.env.DUEL_SECONDS ?? 120); // public RPCs take seconds per call; keep the duel open long enough for both intents

const seedA = process.env.AGENT_SEED_A, seedB = process.env.AGENT_SEED_B;
if (!seedA || !seedB || !process.env.ARENA_SECRET) throw new Error("AGENT_SEED_A, AGENT_SEED_B and ARENA_SECRET must be set in the env file");
// ed25519 from a 32-byte seed with node:crypto only (PKCS8 prefix + seed); pk = last 32 bytes of SPKI.
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const keyFromSeed = (hex: string) => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(hex, "hex")]), format: "der", type: "pkcs8" });
const pkOf = (k: ReturnType<typeof keyFromSeed>) => b64.enc(new Uint8Array(createPublicKey(k).export({ format: "der", type: "spki" }).subarray(-32)));
const skA = keyFromSeed(seedA), skB = keyFromSeed(seedB);
const pkA = pkOf(skA), pkB = pkOf(skB);

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${SOLVER_URL}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-arena-key": process.env.ARENA_SECRET ?? "" } });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
  return j as Record<string, any>;
};
const line = (label: string, tx: string, extra = "") => console.log(`${label.padEnd(18)} ${explorerTx(tx)} ${extra}`);

const follower = loadAccount(FOLLOWER_ID);
const call = async (methodName: string, args: Record<string, unknown>, deposit = 0n) => {
  const r = await follower.callFunctionRaw({ contractId: ARENA, methodName, args, gas: teraToGas("60"), deposit });
  const st = r.status as { SuccessValue?: string };
  if (st.SuccessValue === undefined) throw new Error(`${methodName}: ${JSON.stringify(r.status).slice(0, 200)}`);
  return r.transaction.hash;
};

console.log(`arena ${ARENA}  follower ${FOLLOWER_ID}  agent A ${pkA.slice(0, 12)}…`);

// 1. follower deposits and follows A with a mandate
line("deposit 1 NEAR", await call("deposit", {}, NEAR));
line("follow A", await call("follow", {
  agent_pk: pkA,
  mandate: { allowance: NEAR.toString(), spent: "0", per_tx_cap: CAP.toString(), allowed_tokens: ["nep141:wrap.near"], expires_at: ((Date.now() + 86_400_000) * 1_000_000).toString(), revoked: false },
}), `cap ${fmtNear(CAP)} NEAR, allowance 1 NEAR, wNEAR only`);

// 2. open a duel; a spectator pays the deposit on chain to inject chaos at A
const closeAt = (Math.floor(Date.now() / 1000) + DUEL_SECONDS) * 1_000_000_000;
const duel = await post("/duel", { a: pkA, b: pkB, symbol: "wrap.near", close_at: String(closeAt) });
line("open duel", duel.tx, `duel ${duel.duel_id}`);
// spectator path: hand the solver the payload (open route), then pay for the injection on chain yourself
const payload = "BREAKING: NEAR Foundation halts all validator rewards effective immediately.";
const { payload_hash } = (await post("/chaos", { payload })) as { payload_hash: string };
const minChaos = BigInt((await arenaView<{ min_chaos_deposit: string }>("get_config", {})).min_chaos_deposit);
line("inject chaos @A", await call("inject_chaos", { duel_id: duel.duel_id, target: pkA, kind: "fake_news", payload_hash }, minChaos), `spectator ${FOLLOWER_ID} paid ${fmtNear(minChaos)} NEAR, sha256 ${payload_hash.slice(0, 12)}…`);

// 3. A posts a signed intent; the solver quotes the follower's mandate (dry, 1Click mainnet)
const nonce = String(Date.now());
const intent: Intent = { agent_pk: pkA, duel_id: duel.duel_id, side: "Long", size_bps: 5000, nonce, expires_at: String(closeAt + 60_000_000_000), proof_hash: ZERO_PROOF };
const msg = intentMessage(intent);
const signed: SignedIntent = { intent, signature: b64.enc(new Uint8Array(edSign(null, msg, skA))) };
const posted = await post("/intent", signed);
const q = posted.quotes[0];
line("post intent A", posted.tx, `quotes ${posted.quotes.length}`);
if (!q?.quote) throw new Error(`no quote for follower: ${JSON.stringify(posted.quotes)}`);
console.log(`1Click dry quote: sell ${fmtNear(q.amount)} wNEAR -> ${q.quote.quote.amountOutFormatted} USDC (min ${Number(q.quote.quote.minAmountOut) / 1e6}), ${q.quote.quote.timeEstimate}s`);

// 4. settle one fill inside the cap, then one over the cap
const ok = await post("/settle_follow", { agent_pk: pkA, follower: FOLLOWER_ID, fills: [
  { intent_nonce: nonce, token: "nep141:wrap.near", amount_in: q.amount, amount_out: q.quote.quote.amountOut, swap_tx: `dry-quote:${q.quote.timestamp}` },
] });
line("settle fill", ok.tx, JSON.stringify(ok.report));
// a second intent (new nonce): one fill over the cap, one with a token outside the allowlist, one replay
const nonce2 = String(Date.now());
const intent2: Intent = { ...intent, side: "Short", nonce: nonce2 };
const posted2 = await post("/intent", { intent: intent2, signature: b64.enc(new Uint8Array(edSign(null, intentMessage(intent2), skA))) });
line("post intent A #2", posted2.tx, `quotes ${posted2.quotes.length}`);
const over = await post("/settle_follow", { agent_pk: pkA, follower: FOLLOWER_ID, fills: [
  { intent_nonce: nonce2, token: "nep141:wrap.near", amount_in: (CAP + 1n).toString(), amount_out: "0", swap_tx: "over-cap" },
  { intent_nonce: nonce2, token: "nep141:usdc.near", amount_in: "1", amount_out: "0", swap_tx: "wrong-token" },
  { intent_nonce: nonce, token: "nep141:wrap.near", amount_in: q.amount, amount_out: q.quote.quote.amountOut, swap_tx: "replay" },
] });
line("settle rejected", over.tx, JSON.stringify(over.report));
// revoke: the follower unfollows, and the very next fill is refused on chain
line("unfollow A", await call("unfollow", { agent_pk: pkA }));
const revoked = await post("/settle_follow", { agent_pk: pkA, follower: FOLLOWER_ID, fills: [
  { intent_nonce: nonce2, token: "nep141:wrap.near", amount_in: "1", amount_out: "0", swap_tx: "after-revoke" },
] });
line("settle after revoke", revoked.tx, JSON.stringify(revoked.report));
if (revoked.report.rejected?.[0]?.[1] !== "mandate revoked") throw new Error("fill after unfollow was not refused with 'mandate revoked'");
const vault = await arenaView<string>("get_vault", { account: FOLLOWER_ID });
const mandate = await arenaView<{ spent: string }>("get_follow", { agent_pk: pkA, follower: FOLLOWER_ID });
console.log(`follower vault ${fmtNear(vault)} NEAR, mandate spent ${fmtNear(mandate.spent)} NEAR`);

// 5. past close: ask the Outlayer TEE oracle for the close price (anyone may); its callback finishes the duel
await new Promise((r) => setTimeout(r, Math.max(0, closeAt / 1_000_000 - Date.now() + 2_000)));
const before = await arenaView<{ open_price: string | null }>("get_duel", { duel_id: duel.duel_id });
const resolved = await post("/resolve", { duel_id: duel.duel_id });
line("resolve duel", resolved.tx, `open price ${before.open_price ? (Number(before.open_price) / 1e8).toFixed(4) : "pending"} USD, oracle price-oracle.testnet`);
type Outcome = { open_price: string; close_price: string; pnl_a: number; pnl_b: number; winner: string | null; slashed: string };
let outcome: Outcome | null = null;
for (let i = 0; i < 20 && !outcome; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  outcome = (await arenaView<{ outcome: Outcome | null }>("get_duel", { duel_id: duel.duel_id })).outcome;
}
if (!outcome) throw new Error("oracle callback did not land within 60 s; retry: POST /resolve");
console.log(`outcome: ${(Number(outcome.open_price) / 1e8).toFixed(4)} -> ${(Number(outcome.close_price) / 1e8).toFixed(4)} USD  A ${outcome.pnl_a} bps  B ${outcome.pnl_b} bps  ${outcome.winner ? `winner ${outcome.winner === pkA ? "A" : "B"}, slashed ${fmtNear(outcome.slashed)} NEAR` : "tie"}`);
const a = await arenaView<{ alpha_bps: number; shield: number; bond: string; tee: boolean }>("get_agent", { agent_pk: pkA });
console.log(`agent A: alpha ${a.alpha_bps} bps, shield ${a.shield}, bond ${fmtNear(a.bond)} NEAR, tee ${a.tee}`);
