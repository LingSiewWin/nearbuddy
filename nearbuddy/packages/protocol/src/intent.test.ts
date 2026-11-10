import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { KeyPair } from "near-api-js";
import nacl from "tweetnacl";
import { b64, hex } from "./index.ts";
import {
  COMMIT_DOMAIN,
  CONSENT_DOMAIN,
  commitMessage,
  commitment,
  consentMessage,
  INTENT_DOMAIN,
  type Intent,
  intentMessage,
  keyFromSeed,
  pkOf,
  proofHash,
  signIntent,
  type TeeProof,
  teeSeed,
  teeText,
  verifyIntent,
  verifyTeeProof,
  ZERO_PROOF,
} from "./intent.ts";

// Inputs and expected bytes come from fixtures/wire-vectors.json, shared with the Rust and Python tests.
const W = JSON.parse(readFileSync(new URL("../../../fixtures/wire-vectors.json", import.meta.url), "utf8"));
const fixture: Intent = W.intent;

test("intent bytes: domain prefix and borsh length", () => {
  const m = intentMessage(fixture);
  assert.equal(hex(m.slice(0, INTENT_DOMAIN.length)), hex(INTENT_DOMAIN));
  // domain + (4+32) pk + 8 duel + 1 side + 2 size + 8 nonce + 8 expires + (4+32) proof
  assert.equal(m.length, 19 + 36 + 8 + 1 + 2 + 8 + 8 + 36);
  assert.equal(m[19 + 36 + 8], 1); // Short = 1
});

// Byte-for-byte parity with Rust and Python: wire-vectors.test.ts (fixtures/wire-vectors.json).

test("intent sign/verify and tamper", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const i = { ...fixture, agent_pk: b64.enc(kp.getPublicKey().data) };
  const s = signIntent(kp, i);
  assert.ok(verifyIntent(s));
  const sig = b64.dec(s.signature);
  sig[0] = (sig[0] ?? 0) ^ 1;
  assert.ok(!verifyIntent({ ...s, signature: b64.enc(sig) }));
  assert.ok(!verifyIntent({ ...s, intent: { ...s.intent, size_bps: 5001 } }));
});

// Real record from NEAR AI Cloud, 2026-11-06 (deepseek-ai/DeepSeek-V4.1-Flash-1017, provider_tee, ed25519).
const REAL = {
  model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  request_hash: "eddd4548b2b35d65de9b8617c6632b09d487606c74c02fbab9bac1ee349901e3",
  response_hash: "c4f9c6e53487a744f1687c06d00d09735e7f2a8c4215a019f97150ff6c2dc09f",
  signature:
    "3b24456ee898ba8e684c10e7ad373d42e88d9c26ce4cf1a47187f2112dd66eac6aea43f8df942829c3836b3cedc1119ad7efc48c3d12b29056129a366fbe620b",
  signing_address: "236f5a6b91dd47dc3b7b36e43d4eb531a042ffb8f8fbf3a1555b78cef4fdda4c",
};
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const realProof: TeeProof = {
  kind: 2,
  request_hash: b64.enc(fromHex(REAL.request_hash)),
  response_hash: b64.enc(fromHex(REAL.response_hash)),
  signer: b64.enc(fromHex(REAL.signing_address)),
  signature: b64.enc(fromHex(REAL.signature)),
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
  const res = fromHex(REAL.response_hash);
  res[0] = (res[0] ?? 0) ^ 1;
  assert.ok(
    !verifyTeeProof(
      { ...realProof, response_hash: b64.enc(res) },
      REAL.model,
      proofHash(fromHex(REAL.request_hash), res),
    ),
  );
});

test("tee proof kind rules match the contract: 1 or 2 only, and a TEE-bound agent needs kind 2", () => {
  const ph = proofHash(fromHex(REAL.request_hash), fromHex(REAL.response_hash));
  assert.ok(verifyTeeProof(realProof, REAL.model, ph, true), "kind 2 for a TEE agent");
  assert.ok(!verifyTeeProof({ ...realProof, kind: 3 as 2 }, REAL.model, ph), "bad tee kind");
  // a correctly signed kind-1 (gateway) proof from a test key: valid for a plain agent, refused for a TEE-bound one
  const k = keyFromSeed("07".repeat(32));
  const text1 = teeText(1, REAL.model, fromHex(REAL.request_hash), fromHex(REAL.response_hash));
  const gateway: TeeProof = {
    ...realProof,
    kind: 1,
    signer: pkOf(k),
    signature: b64.enc(new Uint8Array(sign(null, text1, k))),
  };
  assert.ok(verifyTeeProof(gateway, REAL.model, ph), "gateway proof, plain agent");
  assert.ok(!verifyTeeProof(gateway, REAL.model, ph, true), "provider proof required");
  assert.ok(!verifyTeeProof({ ...realProof, signer: realProof.signer.slice(0, -1) }, REAL.model, ph), "unpadded");
});

// Commit-reveal and consent vectors from the shared file.
const CONTRACT: string = W.contract;
const SALT = fromHex(W.commit.salt_hex);
const { a: PK_A, b: PK_B, symbol: SYMBOL, close_at: CLOSE_AT } = W.consent;
const COMMITMENT_HEX: string = W.commit.commitment_hex;
const COMMIT_MSG_HEX: string = W.commit.message_hex;
const CONSENT_MSG_HEX: string = W.consent.message_hex;

test("commitment = sha256(intent bytes || salt), bound to every intent field and the salt", () => {
  const c = commitment(fixture, SALT);
  assert.equal(hex(c), COMMITMENT_HEX);
  assert.equal(hex(c), createHash("sha256").update(intentMessage(fixture)).update(SALT).digest("hex"));
  assert.notEqual(hex(commitment({ ...fixture, side: "Long" }, SALT)), COMMITMENT_HEX);
  assert.notEqual(hex(commitment(fixture, new Uint8Array(32).fill(9))), COMMITMENT_HEX);
});

test("commit message: domain || contract || duel_id u64 LE || commitment", () => {
  const c = commitment(fixture, SALT);
  const m = commitMessage(CONTRACT, "7", c);
  assert.equal(hex(m), COMMIT_MSG_HEX);
  assert.equal(m.length, COMMIT_DOMAIN.length + CONTRACT.length + 8 + 32);
  assert.notEqual(hex(commitMessage("other.testnet", "7", c)), COMMIT_MSG_HEX);
  assert.notEqual(hex(commitMessage(CONTRACT, "8", c)), COMMIT_MSG_HEX);
});

test("consent message: domain || contract || a || b || symbol || close_at u64 LE", () => {
  const m = consentMessage(CONTRACT, PK_A, PK_B, SYMBOL, CLOSE_AT);
  assert.equal(hex(m), CONSENT_MSG_HEX);
  assert.equal(m.length, CONSENT_DOMAIN.length + CONTRACT.length + 32 + 32 + SYMBOL.length + 8);
  assert.notEqual(hex(consentMessage(CONTRACT, PK_B, PK_A, SYMBOL, CLOSE_AT)), CONSENT_MSG_HEX);
});

/** A contract view returning bytes: JSON array of u8, hex string or base64 string. */
const asHex = (v: unknown): string =>
  Array.isArray(v)
    ? hex(Uint8Array.from(v as number[]))
    : /^[0-9a-f]*$/.test(String(v))
      ? String(v)
      : hex(b64.dec(String(v)));

// On-chain parity: the deployed arena contract must produce the same bytes. Set ARENA_DEPLOYED=1.
// bun's node:test ignores `{ skip }` in the options object, so the gate picks test or test.skip.
const onChain = process.env.ARENA_DEPLOYED ? test : test.skip;
onChain("intent bytes and tee text match the deployed arena contract", async () => {
  const { arenaView } = await import("./chain.ts");
  const onChain = await arenaView("intent_message_hex", { intent: fixture });
  assert.equal(onChain, hex(intentMessage(fixture)));
  const onChainText = await arenaView("tee_text_utf8", {
    kind: 2,
    model_id: REAL.model,
    request_hash: realProof.request_hash,
    response_hash: realProof.response_hash,
  });
  assert.equal(
    onChainText,
    new TextDecoder().decode(teeText(2, REAL.model, fromHex(REAL.request_hash), fromHex(REAL.response_hash))),
  );
});

onChain("commit and consent bytes match the deployed arena contract", async () => {
  const { ARENA, arenaView } = await import("./chain.ts");
  const c = commitment(fixture, SALT);
  // seen: null is the v1 message on 17.1 and an ignored field on 17
  const onCommit = await arenaView("commit_message", { duel_id: "7", commitment: b64.enc(c), seen: null });
  assert.equal(asHex(onCommit), hex(commitMessage(ARENA, "7", c)));
  const onConsent = await arenaView("consent_message", {
    a: PK_A,
    b: PK_B,
    symbol: "wrap.near",
    close_at: "1700000000000000000",
  });
  assert.equal(asHex(onConsent), hex(consentMessage(ARENA, PK_A, PK_B, "wrap.near", "1700000000000000000")));
});

// Reference values from agents/.venv python: hashlib.sha256(bytes.fromhex(seed)+b"tee").hexdigest() and
// base64(nacl.signing.SigningKey(that digest).verify_key) for seed 01*32.
test("enclave agent key derivation matches agents/runner.py agent_key(tee=True)", () => {
  const s = teeSeed("01".repeat(32));
  assert.equal(s, "db11b0255edc79eeb163a3884a834c1dfc9d1102fb649958b1b65f9ea767c642");
  assert.equal(pkOf(keyFromSeed(s)), "l/QvOd9Z/vnZQaWWwf1rGQ2WBxADm8xSbImPfNfmtp0=");
  assert.equal(pkOf(keyFromSeed(s)), b64.enc(nacl.sign.keyPair.fromSeed(Buffer.from(s, "hex")).publicKey));
});
