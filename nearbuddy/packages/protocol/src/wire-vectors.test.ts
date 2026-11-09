import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { b64, hex, parseEventJson, unhex } from "./index.ts";
import {
  commitMessage,
  commitment,
  consentMessage,
  type Intent,
  intentMessage,
  keyFromSeed,
  pkOf,
  proofHash,
  teeText,
  verify,
  verifyIntent,
} from "./intent.ts";

// Shared with arena/src/tests.rs (wire_vectors_match_shared_file) and agents/tests/test_wire_vectors.py.
const W = JSON.parse(readFileSync(new URL("../../../fixtures/wire-vectors.json", import.meta.url), "utf8"));
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

test("intent bytes match the shared vector", () => {
  assert.equal(hex(intentMessage(W.intent as Intent)), W.intent_hex);
});

test("commitment and commit message match the shared vector", () => {
  const c = commitment(W.intent as Intent, fromHex(W.commit.salt_hex));
  assert.equal(hex(c), W.commit.commitment_hex);
  assert.equal(
    hex(c),
    createHash("sha256").update(fromHex(W.intent_hex)).update(fromHex(W.commit.salt_hex)).digest("hex"),
  );
  assert.equal(hex(commitMessage(W.contract, W.commit.duel_id, c)), W.commit.message_hex);
});

test("consent message matches the shared vector", () => {
  const k = W.consent;
  assert.equal(hex(consentMessage(W.contract, k.a, k.b, k.symbol, k.close_at)), k.message_hex);
});

test("tee text and proof hash match the shared vector", () => {
  const t = W.tee;
  const [req, res] = [fromHex(t.request_hash_hex), fromHex(t.response_hash_hex)];
  assert.equal(text(teeText(1, t.model, req, res)), t.text_kind1);
  assert.equal(text(teeText(2, t.model, req, res)), t.text_kind2);
  assert.equal(hex(b64.dec(proofHash(req, res))), t.proof_hash_hex);
});

test("ed25519 signature over the intent matches the shared vector", () => {
  const s = W.signed;
  const key = keyFromSeed(s.seed_hex);
  assert.equal(pkOf(key), s.intent.agent_pk);
  const m = intentMessage(s.intent as Intent);
  assert.equal(hex(m), s.message_hex);
  const sig = sign(null, m, key);
  assert.equal(sig.toString("hex"), s.signature_hex);
  assert.ok(verify(s.intent.agent_pk, m, b64.enc(new Uint8Array(sig))));
});

const patched = (e: { patch: Record<string, unknown> }) => ({ ...W.intent, ...e.patch }) as Intent;

test("every edge the contract refuses is refused by intentMessage and verifyIntent", () => {
  const key = keyFromSeed(W.signed.seed_hex);
  for (const e of W.edges.reject) {
    assert.throws(() => intentMessage(patched(e)), RangeError, e.name);
    // a signature over the canonical bytes must not make the edge verify
    const sig = b64.enc(new Uint8Array(sign(null, intentMessage(W.signed.intent), key)));
    assert.equal(verifyIntent({ intent: { ...W.signed.intent, ...e.patch }, signature: sig }), false, e.name);
  }
});

test("u64 spellings the contract accepts encode to the canonical bytes", () => {
  for (const e of W.edges.same) assert.equal(hex(intentMessage(patched(e))), W.intent_hex, e.name);
});

test("EVENT_JSON u64 numbers keep every digit", () => {
  const e = parseEventJson(W.event_json.log) as { data: { duel_id: unknown; nonce: unknown; size_bps: unknown } };
  assert.equal(String(e.data.duel_id), W.event_json.duel_id);
  assert.equal(String(e.data.nonce), W.event_json.nonce);
  assert.equal(e.data.size_bps, 5000, "small numbers stay numbers");
  const t = parseEventJson(W.event_json.string_log) as { data: { memo: string }[] };
  assert.equal(t.data[0]?.memo, W.event_json.memo, "digits inside a string are left alone");
});

test("hex with a 0x prefix decodes like Python's", () => {
  assert.equal(hex(unhex(W.hex_0x.in)), W.hex_0x.bytes_hex);
  assert.equal(hex(unhex(W.hex_0x.bytes_hex)), W.hex_0x.bytes_hex);
  assert.throws(() => unhex("0xzz"), RangeError);
});
