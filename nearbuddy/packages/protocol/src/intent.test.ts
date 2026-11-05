import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "near-api-js";
import {
  INTENT_DOMAIN, RESOLVE_DOMAIN, ZERO_PROOF, intentMessage, resolutionMessage, signIntent, verifyIntent,
  signResolution, verifyResolution, type Intent, type Resolution,
} from "./intent.ts";
import { b64, hex } from "./index.ts";

// Same fixture as the contract test `intent_message_len` (arena/src/tests.rs).
export const fixture: Intent = {
  agent_pk: b64.enc(new Uint8Array(32).fill(1)), duel_id: "7", side: "Short", size_bps: 5000,
  nonce: "3", expires_at: "1700000000000000000", proof_hash: ZERO_PROOF,
};
const resolution: Resolution = { duel_id: "7", open_price: "10000000000000", close_price: "10050000000000" };

test("intent bytes: domain prefix and borsh length", () => {
  const m = intentMessage(fixture);
  assert.equal(hex(m.slice(0, INTENT_DOMAIN.length)), hex(INTENT_DOMAIN));
  // domain + (4+32) pk + 8 duel + 1 side + 2 size + 8 nonce + 8 expires + (4+32) proof
  assert.equal(m.length, 19 + 36 + 8 + 1 + 2 + 8 + 8 + 36);
  assert.equal(m[19 + 36 + 8], 1); // Short = 1
});

test("resolution bytes length", () => {
  const m = resolutionMessage(resolution);
  assert.equal(m.length, RESOLVE_DOMAIN.length + 8 + 8 + 8);
});

test("intent sign/verify and tamper", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const i = { ...fixture, agent_pk: b64.enc(kp.getPublicKey().data) };
  const s = signIntent(kp, i);
  assert.ok(verifyIntent(s));
  const sig = b64.dec(s.signature); sig[0] ^= 1;
  assert.ok(!verifyIntent({ ...s, signature: b64.enc(sig) }));
  assert.ok(!verifyIntent({ ...s, intent: { ...s.intent, size_bps: 5001 } }));
});

test("resolution sign/verify", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const pk = b64.enc(kp.getPublicKey().data);
  const sig = signResolution(kp, resolution);
  assert.ok(verifyResolution(resolution, sig, pk));
  assert.ok(!verifyResolution({ ...resolution, close_price: "1" }, sig, pk));
});

// On-chain parity: the deployed arena contract must produce the same bytes. Set ARENA_DEPLOYED=1.
test("intent and resolution bytes match the deployed arena contract", { skip: !process.env.ARENA_DEPLOYED }, async () => {
  const { arenaView } = await import("./chain.ts");
  const onChain = await arenaView<string>("intent_message_hex", { intent: fixture });
  assert.equal(onChain, hex(intentMessage(fixture)));
  const onChainR = await arenaView<string>("resolution_message_hex", { resolution });
  assert.equal(onChainR, hex(resolutionMessage(resolution)));
});
