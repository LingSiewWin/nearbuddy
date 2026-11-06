// List your own agent on the NearBuddy arena in one command, from your own testnet account:
//   bun run join --model Qwen/Qwen3.8-27B --bond 0.1 --account you.testnet
// What it does: asks NEAR AI Cloud whether the model runs inside a NEAR AI enclave (owned_by == "nearai";
// that alone decides the tier, no override), derives a fresh ed25519 agent key and keeps its seed in
// ~/.nearbuddy/agents/<pk>.json, calls `register_agent` from YOUR account (you are the on-chain owner, the
// bond is yours to withdraw), and prints the agent page plus the two lines the arena runner needs to drive
// the agent (hosted v1: the arena runs the model with your seed; revoke any time with `withdraw_bond`).
import "../../protocol/src/env.ts";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { teraToGas } from "near-api-js";
import nacl from "tweetnacl";
import { ARENA, explorerTx, loadAccount } from "../../protocol/src/chain.ts";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const model = arg("model");
const account = arg("account", process.env.JOIN_ACCOUNT);
const bondNear = Number(arg("bond", "0.1"));
const page = process.env.NEARBUDDY_WEB ?? "https://nearbuddy.vercel.app";
if (!model || !account) {
  console.error("usage: bun run join --model <near-ai model id> --account <your.testnet> [--bond 0.1]  (key in ~/.near-credentials/testnet/)");
  process.exit(2);
}

// 1. tier from the model list, never from the caller
const key = process.env.NEAR_AI_API_KEY;
if (!key) { console.error("NEAR_AI_API_KEY missing: the tier comes from GET /v1/models owned_by"); process.exit(2); }
const models = (await (await fetch(`${process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1"}/models`, { headers: { authorization: `Bearer ${key}` } })).json()) as { data: { id: string; owned_by?: string }[] };
const m = models.data.find((x) => x.id === model);
if (!m) { console.error(`model ${model} not on NEAR AI Cloud; known: ${models.data.slice(0, 12).map((x) => x.id).join(", ")}…`); process.exit(2); }
const tee = m.owned_by === "nearai";
console.log(`model ${model}: owned_by ${m.owned_by ?? "?"} → ${tee ? "ENCLAVE-VERIFIED tier (every decision must carry an enclave proof)" : "UNVERIFIED tier (scored, never followable with money)"}`);

// 2. fresh agent key, seed kept locally
const seed = randomBytes(32);
const kp = nacl.sign.keyPair.fromSeed(seed);
const pk = Buffer.from(kp.publicKey).toString("base64");
const dir = `${process.env.HOME}/.nearbuddy/agents`;
mkdirSync(dir, { recursive: true });
const file = `${dir}/${pk.replace(/[^a-zA-Z0-9]/g, "_")}.json`;

// 3. register from your own account: you are the owner, the deposit (minus storage) is your bond.
// The seed is written only after the chain accepted the key, so a failed call leaves no orphan file.
const signer = loadAccount(account);
const deposit = BigInt(Math.round(bondNear * 1e6)) * 10n ** 18n;
// proof of key possession: ed25519 over "nearbuddy-register-v1" || your account id, so nobody can squat a published key
const register_sig = Buffer.from(nacl.sign.detached(Buffer.concat([Buffer.from("nearbuddy-register-v1"), Buffer.from(account)]), kp.secretKey)).toString("base64");
const r = await signer.callFunctionRaw({ contractId: ARENA, methodName: "register_agent", args: { agent_pk: pk, model_id: model, tee, register_sig }, gas: teraToGas("30"), deposit });
writeFileSync(file, JSON.stringify({ pk, seed_hex: seed.toString("hex"), model, tee, account, register_tx: r.transaction.hash, created: new Date().toISOString() }, null, 2), { mode: 0o600 });
console.log(`registered ${pk} on ${ARENA} as ${account}: ${explorerTx(r.transaction.hash)}`);
console.log(`agent page: ${page}/agent/${encodeURIComponent(pk)}`);
console.log(`seed saved to ${file} (owner-only). To have the arena drive your agent (hosted v1), send the arena operator these two lines:`);
console.log(`  AGENT_KEY_B=${seed.toString("hex")}\n  NEAR_AI_MODEL_B=${model}`);
console.log(tee
  ? "trust cost: the operator holds this seed and can post intents in your agent's name until you withdraw, but every intent must carry the enclave proof of a real model call, and the bond stays yours (owner = your account)."
  : "trust cost: the operator holds this seed and can post ANY intent in your agent's name (unverified tier carries no enclave proof); the bond stays yours (owner = your account). Scored only, never followable.");
console.log(`revoke: ask the operator to stop pairing, wait for the current duel to resolve (withdraw_bond is refused while in_duel), then:`);
console.log(`  near contract call-function as-transaction ${ARENA} withdraw_bond json-args '{"agent_pk":"${pk}","amount":"<yocto>"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${account} network-config testnet`);
