// The web copy of the intent encoder against fixtures/wire-vectors.json, the file the contract (Rust), packages/protocol
// (TS) and the agents (Python) are tested on: same bytes, same refusals, same EVENT_JSON reading.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hex, type Intent, intentMessage, parseEventJson } from "../lib/protocol";

const W = JSON.parse(readFileSync(`${import.meta.dir}/../../../fixtures/wire-vectors.json`, "utf8"));
const patched = (e: { patch: Record<string, unknown> }) => ({ ...W.intent, ...e.patch }) as Intent;

test("web intentMessage matches the shared bytes", () => {
  expect(hex(intentMessage(W.intent))).toBe(W.intent_hex);
});

test("web intentMessage refuses every edge the contract refuses", () => {
  for (const e of W.edges.reject) expect(() => intentMessage(patched(e)), e.name).toThrow(RangeError);
  for (const e of W.edges.same) expect(hex(intentMessage(patched(e))), e.name).toBe(W.intent_hex);
});

test("web EVENT_JSON reader keeps every digit of a u64", () => {
  const e = parseEventJson(W.event_json.log) as { data: { duel_id: unknown; nonce: unknown } };
  expect(String(e.data.duel_id)).toBe(W.event_json.duel_id);
  expect(String(e.data.nonce)).toBe(W.event_json.nonce);
  const t = parseEventJson(W.event_json.string_log) as { data: { memo: string }[] };
  expect(t.data[0]?.memo).toBe(W.event_json.memo); // digits inside a string are left alone
});
