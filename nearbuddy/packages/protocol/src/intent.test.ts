import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "near-api-js";
import {
  INTENT_DOMAIN, ZERO_PROOF, intentMessage, proofHash, signIntent, teeText, verifyIntent, verifyTeeProof,
  type Intent, type TeeProof,
} from "./intent.ts";
import { b64, hex } from "./index.ts";

// Same fixture as the contract test `intent_message_len` (arena/src/tests.rs).
export const fixture: Intent = {
  agent_pk: b64.enc(new Uint8Array(32).fill(1)), duel_id: "7", side: "Short", size_bps: 5000,
  nonce: "3", expires_at: "1700000000000000000", proof_hash: ZERO_PROOF,
};

test("intent bytes: domain prefix and borsh length", () => {
  const m = intentMessage(fixture);
  assert.equal(hex(m.slice(0, INTENT_DOMAIN.length)), hex(INTENT_DOMAIN));
  // domain + (4+32) pk + 8 duel + 1 side + 2 size + 8 nonce + 8 expires + (4+32) proof
  assert.equal(m.length, 19 + 36 + 8 + 1 + 2 + 8 + 8 + 36);
  assert.equal(m[19 + 36 + 8], 1); // Short = 1
});

// Printed by `cargo test intent_message_len_matches_ts -- --nocapture` (INTENT_HEX); the Python test pins the same string.
const RUST_HEX = "6e65617262756464792d696e74656e742d76312000000001010101010101010101010101010101010101010101010101010101010101010700000000000000018813030000000000000000002a36fe9c9717200000000000000000000000000000000000000000000000000000000000000000000000";
test("intent bytes match the Rust contract byte for byte", () => {
  assert.equal(hex(intentMessage({ ...fixture, expires_at: "1700000000000000000" })), RUST_HEX);
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

// Real record from NEAR AI Cloud, 2026-11-06 (deepseek-ai/DeepSeek-V4.1-Flash-1017, provider_tee, ed25519).
const REAL = {
  model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  request_hash: "eddd4548b2b35d65de9b8617c6632b09d487606c74c02fbab9bac1ee349901e3",
  response_hash: "c4f9c6e53487a744f1687c06d00d09735e7f2a8c4215a019f97150ff6c2dc09f",
  signature: "3b24456ee898ba8e684c10e7ad373d42e88d9c26ce4cf1a47187f2112dd66eac6aea43f8df942829c3836b3cedc1119ad7efc48c3d12b29056129a366fbe620b",
  signing_address: "236f5a6b91dd47dc3b7b36e43d4eb531a042ffb8f8fbf3a1555b78cef4fdda4c",
};
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const realProof: TeeProof = {
  kind: 2, request_hash: b64.enc(fromHex(REAL.request_hash)), response_hash: b64.enc(fromHex(REAL.response_hash)),
  signer: b64.enc(fromHex(REAL.signing_address)), signature: b64.enc(fromHex(REAL.signature)),
};

test("tee text matches the cloud's signed text", () => {
  const t = new TextDecoder().decode(teeText(2, REAL.model, fromHex(REAL.request_hash), fromHex(REAL.response_hash)));
  assert.equal(t, `${REAL.model}:${REAL.request_hash}:${REAL.response_hash}`);
  const g = new TextDecoder().decode(teeText(1, REAL.model, fromHex(REAL.request_hash), fromHex(REAL.response_hash)));
  assert.equal(g, `${REAL.request_hash}:${REAL.response_hash}`);
});

test("a real NEAR AI Cloud enclave signature verifies, a flipped byte does not", () => {
  const ph = proofHash(fromHex(REAL.request_hash), fromHex(REAL.response_hash));
  assert.ok(verifyTeeProof(realProof, REAL.model, ph));
  assert.ok(!verifyTeeProof(realProof, "Qwen/Qwen3.8-27B", ph), "other model id");
  assert.ok(!verifyTeeProof(realProof, REAL.model, ZERO_PROOF), "intent commits to another completion");
  const res = fromHex(REAL.response_hash); res[0] ^= 1;
  assert.ok(!verifyTeeProof({ ...realProof, response_hash: b64.enc(res) }, REAL.model, proofHash(fromHex(REAL.request_hash), res)));
});

// On-chain parity: the deployed arena contract must produce the same bytes. Set ARENA_DEPLOYED=1.
test("intent bytes and tee text match the deployed arena contract", { skip: !process.env.ARENA_DEPLOYED }, async () => {
  const { arenaView } = await import("./chain.ts");
  const onChain = await arenaView<string>("intent_message_hex", { intent: fixture });
  assert.equal(onChain, hex(intentMessage(fixture)));
  const onChainText = await arenaView<string>("tee_text_utf8", { kind: 2, model_id: REAL.model, request_hash: realProof.request_hash, response_hash: realProof.response_hash });
  assert.equal(onChainText, new TextDecoder().decode(teeText(2, REAL.model, fromHex(REAL.request_hash), fromHex(REAL.response_hash))));
});
