import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, iouMessage, verifyIou, hex, b64 } from "./index.ts";

// Pinned from contract unit test `message_encoding_is_stable` (cargo test -- --nocapture).
const RUST_HEX =
  "7a65726f7461622d696f752d76310d000000616c6963652e746573746e65742000000001010101010101010101010101010101010101010101010101010101010101010b0000006170692e746573746e6574000088b116afe3b50200000000000000070000000000000000002a36fe9c9717";

test("borsh encoding matches the Rust contract byte for byte", () => {
  const msg = iouMessage({
    owner: "alice.testnet",
    agent_pk: b64.enc(new Uint8Array(32).fill(1)),
    payee: "api.testnet",
    amount: "50000000000000000000",
    nonce: "7",
    expires_at: "1700000000000000000",
  });
  assert.equal(hex(msg), RUST_HEX);
});

test("agent signs and signature verifies; tamper fails", () => {
  const a = new Agent();
  const s = a.sign({ owner: "o.testnet", payee: "p.testnet", amount: "5", expires_at: "1" });
  assert.equal(verifyIou(s), true);
  s.iou.amount = "6";
  assert.equal(verifyIou(s), false);
});
