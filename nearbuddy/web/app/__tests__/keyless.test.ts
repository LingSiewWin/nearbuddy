// The web copy of the keyless request builder (lib/keyless.ts, used by the duel verifier) is
// packages/protocol/src/keyless.ts byte for byte, and both read fixtures/keyless-vectors.json the same way.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type KeylessInputs, keylessRequest, parseDecision, toHex } from "../lib/keyless";

const V = JSON.parse(readFileSync(`${import.meta.dir}/../../../fixtures/keyless-vectors.json`, "utf8"));

test("lib/keyless.ts is packages/protocol/src/keyless.ts byte for byte", () => {
  const src = (p: string) => readFileSync(`${import.meta.dir}/${p}`, "utf8");
  expect(src("../lib/keyless.ts")).toBe(src("../../../packages/protocol/src/keyless.ts")); // edit the package, then copy
});

test("web keyless builder: the contract's bytes, refusals and decisions", () => {
  for (const c of V.cases) expect(toHex(keylessRequest(c.inputs as KeylessInputs)), c.name).toBe(c.request_hex);
  for (const r of V.reject) expect(() => keylessRequest({ ...V.cases[0].inputs, ...r.patch }), r.name).toThrow(r.error);
  for (const p of V.parse)
    expect(parseDecision(new TextEncoder().encode(p.response), p.headlines), p.name).toEqual(p.decision);
});
