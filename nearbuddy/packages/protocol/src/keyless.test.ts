// The keyless request builder and response parse against fixtures/keyless-vectors.json, the file arena/src/keyless.rs
// writes and agents/tests/test_keyless.py reads: same bytes, same refusals with the contract's panic text, same
// decisions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type KeylessInputs, keylessIdMessage, keylessRequest, parseDecision, toHex } from "./keyless.ts";

const V = JSON.parse(readFileSync(new URL("../../../fixtures/keyless-vectors.json", import.meta.url), "utf8"));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

test("every case builds the contract's request bytes", () => {
  for (const c of V.cases) {
    const body = keylessRequest(c.inputs as KeylessInputs);
    assert.equal(toHex(body), c.request_hex, c.name);
    assert.equal(sha(body), c.request_sha256, c.name);
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { seed: number; temperature: number };
    assert.deepEqual([parsed.seed, parsed.temperature], [c.seed, 0], c.name);
  }
});

test("every reject edge is refused with the contract's panic text", () => {
  for (const r of V.reject)
    assert.throws(
      () => keylessRequest({ ...V.cases[0].inputs, ...r.patch }),
      { name: "RangeError", message: r.error },
      r.name,
    );
});

test("every response parses to the decision the contract records", () => {
  for (const p of V.parse)
    assert.deepEqual(parseDecision(new TextEncoder().encode(p.response), p.headlines), p.decision, p.name);
});

test("the agent id is the contract's", () => {
  const { contract, owner, n, id_hex } = V.id;
  assert.equal(sha(keylessIdMessage(contract, owner, String(n))), id_hex);
});

test("u64 fields refuse what the contract's JSON ingress refuses", () => {
  const base = V.cases[0].inputs as KeylessInputs;
  for (const bad of ["-1", "18446744073709551616", "1.5", "0x10", ""])
    assert.throws(() => keylessRequest({ ...base, duel_id: bad }), RangeError, bad);
  assert.throws(() => keylessRequest({ ...base, nonce: base.nonce.replace(/=$/, "") }), RangeError, "unpadded base64");
});
