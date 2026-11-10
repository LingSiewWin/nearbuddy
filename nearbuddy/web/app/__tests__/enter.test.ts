// /enter's pure parts: the register_keyless call refuses exactly what the contract refuses (fixtures/keyless-vectors.json),
// a slot read back from views rebuilds the vector's request bytes, the status line, and the keyless arena config.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AgentView, Duel, KeylessAgent, Slot } from "../lib/abi/arena";
import {
  type AgentState,
  canonicalDuelId,
  canonicalPk,
  enterCall,
  enteredAgent,
  KEYLESS_ARENAS,
  keylessArena,
  shownUnits,
  slotInputs,
  statusLine,
  wrapUnits,
  yocto,
} from "../lib/enter";
import { type KeylessInputs, keylessRequest, SLOT_TTL_NS, toHex } from "../lib/keyless";

const V = JSON.parse(readFileSync(`${import.meta.dir}/../../../fixtures/keyless-vectors.json`, "utf8"));
const C = "v2.nb-keyless-arena-1111.testnet";
const base = V.cases[0].inputs as KeylessInputs;

test("enterCall: register_keyless with template 1, deposit = the bond, 30 TGas", () => {
  expect(enterCall(C, { model_id: base.model_id, strategy: base.strategy, bond_near: "1.5" })).toEqual({
    receiverId: C,
    methodName: "register_keyless",
    args: { model_id: base.model_id, strategy: base.strategy, template_version: 1 },
    gas: "30000000000000",
    deposit: "1500000000000000000000000",
  });
  expect(enterCall(C, { model_id: "m", strategy: "s" }).deposit).toBe(String(10n ** 23n)); // default 0.1
  expect(enterCall(C, { model_id: "m", strategy: "s", bond_near: " " }).deposit).toBe(String(10n ** 23n));
});

test("enterCall refuses every strategy and model_id reject vector with the contract's panic text", () => {
  const rejects = V.reject.filter((r: { patch: object }) => "strategy" in r.patch || "model_id" in r.patch);
  expect(rejects.length).toBe(8);
  for (const r of rejects)
    expect(() => enterCall(C, { model_id: base.model_id, strategy: base.strategy, ...r.patch }), r.name).toThrow(
      new RangeError(r.error),
    );
});

test("bond: a NEAR amount of at least 0.02", () => {
  expect(yocto("0.02")).toBe(2n * 10n ** 22n);
  expect(yocto("3")).toBe(3n * 10n ** 24n);
  for (const bad of ["0.019", "0", "abc", "-1", "1e3", ".5", "1.0000000000000000000000001"])
    expect(() => enterCall(C, { model_id: "m", strategy: "s", bond_near: bad }), bad).toThrow(/^bond: /);
});

test("slotInputs: a slot read back from the views rebuilds the contract's request bytes", () => {
  for (const c of V.cases) {
    const i = c.inputs as KeylessInputs;
    const agent = { model_id: i.model_id } as AgentView;
    const k: KeylessAgent = { strategy: i.strategy, template: i.template_version, next_seq: "9" };
    const opened = 1_700_000_000_000_000_000n;
    const d = {
      id: i.duel_id,
      symbol: i.symbol,
      open_price: i.open_price,
      close_at: String(opened + BigInt(i.seconds_left) * 1_000_000_000n),
    } as Duel;
    const chaos = i.headlines.map((h) => ({ headline: h.text, arm: h.arm }));
    const s = {
      seq: i.seq,
      nonce: i.nonce,
      opened_at: String(opened),
      price: i.price,
      seen: chaos.length,
      heads: chaos.length ? 2 ** chaos.length - 1 : 0,
    } as Slot;
    const bytes = keylessRequest(slotInputs(agent, k, d, s, chaos as never));
    expect(toHex(bytes), c.name).toBe(c.request_hex);
  }
});

test("statusLine: waiting for a duel, slot open, decided", () => {
  const agent = { in_duel: "4" } as AgentView;
  const keyless = { strategy: "s", template: 1, next_seq: "2" };
  const duel = { id: "4", resolved: false, close_at: "2000" } as Duel;
  const slot = { seq: "3", opened_at: "1000", response_hash: null, side: null, size_bps: 0 } as Slot;
  const st = (p: Partial<AgentState>): AgentState => ({ agent, keyless, duel, slot, chaos: null, duels: [], ...p });
  expect(statusLine(st({ agent: { ...agent, in_duel: null } }), 0n).t).toBe("waiting for a duel");
  expect(statusLine(st({ slot: null }), 0n).t).toBe("duel #4 · waiting for a keeper to open a slot");
  expect(statusLine(st({}), 1500n).t).toBe("duel #4 · slot 3 open · waiting for a keeper's answer");
  // 120 s after the open (SLOT_TTL_NS) an unanswered slot takes no submission
  expect(statusLine(st({}), 1000n + SLOT_TTL_NS - 1n).c).toBe("open");
  expect(statusLine(st({ duel: { ...duel, close_at: String(10n ** 12n) } }), 1000n + SLOT_TTL_NS).t).toBe(
    "duel #4 · slot 3 expired with no answer; a keeper may open the next",
  );
  expect(statusLine(st({ slot: { ...slot, response_hash: "x", side: "Long", size_bps: 500 } }), 1500n).t).toBe(
    "duel #4 · slot 3 decided Long 500 bps",
  );
  expect(statusLine(st({ slot: { ...slot, response_hash: "x" } }), 2500n).t).toBe(
    "duel #4 · slot 3 answered with no readable decision · duel closed, waiting for the oracle to settle it",
  );
  expect(statusLine(st({ keyless: null }), 0n).c).toBe("bad");
});

test("keyless arena: its own config, testnet default, none on mainnet, override, other network refused", () => {
  expect(keylessArena("testnet", {})).toBe(KEYLESS_ARENAS.testnet);
  expect(KEYLESS_ARENAS.testnet).toBe(C);
  expect(keylessArena("mainnet", {})).toBeNull();
  expect(keylessArena("testnet", { KEYLESS_ARENA_CONTRACT: "v3.x.testnet" })).toBe("v3.x.testnet");
  expect(keylessArena("mainnet", { KEYLESS_ARENA_CONTRACT: "arena.nearbuddy.near" })).toBe("arena.nearbuddy.near");
  for (const v of ["v3.x.testnet", "keyless.testnet"])
    expect(() => keylessArena("mainnet", { KEYLESS_ARENA_CONTRACT: v }), v).toThrow(/not a mainnet account/);
  // a positive suffix: an implicit or a .tg account is not a testnet account either
  for (const v of ["arena.nearbuddy.near", "keyless.tg", "a".repeat(64), "x.testnet.near"])
    expect(() => keylessArena("testnet", { KEYLESS_ARENA_CONTRACT: v }), v).toThrow(/not a testnet account/);
});

test("canonicalPk: one spelling per 32-byte key", () => {
  const pk = "YLqgTOliaG+cZcWWOmxBwbrryeCafXlq4N5P+ChomTo=";
  expect(canonicalPk(pk)).toBe(true);
  // the same bytes with nonzero padding bits, without padding, or with a URL-safe alphabet; then wrong lengths
  for (const v of [
    "YLqgTOliaG+cZcWWOmxBwbrryeCafXlq4N5P+ChomTp=",
    "YLqgTOliaG+cZcWWOmxBwbrryeCafXlq4N5P+ChomTo",
    "YLqgTOliaG-cZcWWOmxBwbrryeCafXlq4N5P-ChomTo=",
    "YLqgTOliaG+cZcWWOmxBwbrryeCafXlq4N5P+ChomQ==",
    "",
  ])
    expect(canonicalPk(v), v).toBe(false);
});

test("canonicalDuelId: a U64 as the contract writes it", () => {
  for (const ok of ["0", "2", "481", "999999999999"]) expect(canonicalDuelId(ok), ok).toBe(true);
  for (const bad of ["03", "00", "", "-1", "+2", "1.0", " 2", "2 ", "1e3", "0x10", "1000000000000"])
    expect(canonicalDuelId(bad), bad).toBe(false);
});

test("shownUnits: every invisible or look-alike code point is named, text stays text", () => {
  const show = (s: string) => shownUnits(s).join("");
  expect(show("Buy NEAR: +5% (café, 中文, €)")).toBe("Buy NEAR: +5% (café, 中文, €)");
  expect(show("a\u00adb")).toBe("a\\u{AD}b"); // soft hyphen
  expect(show("x\u2028y")).toBe("x\\u{2028}y"); // line separator
  expect(show("go\u200blong")).toBe("go\\u{200B}long");
  expect(show("\u{e0047}\u{e004f}")).toBe("\\u{E0047}\\u{E004F}"); // Unicode tags
  expect(show("a\u00a0b\ufe0f\u0301")).toBe("a\\u{A0}b\\u{FE0F}\\u{301}"); // NBSP, variation selector, mark
  expect(show("\t\r\u007f")).toBe("\\u{9}\\u{D}\\u{7F}");
  expect(show("a\\u{41}")).toBe("a\\\\u{41}"); // a literal backslash cannot pose as an escape
});

test("wrapUnits: lines of at most the width, no unit split, nothing lost", () => {
  const units = shownUnits(`${"x".repeat(30)}\u200b${"y".repeat(5)}`);
  const lines = wrapUnits(units, 32);
  expect(lines.map((l) => l.join(""))).toEqual(["x".repeat(30), `\\u{200B}${"y".repeat(5)}`]);
  expect(lines.flat()).toEqual(units);
  for (const l of wrapUnits(shownUnits("ab\u{e0041}cd"), 3))
    expect(l.join("").length <= 3 || l.length === 1).toBe(true);
  expect(wrapUnits([], 10)).toEqual([[]]);
});

test("enteredAgent: the new agent's id comes from the register_keyless result, nothing else", () => {
  // the shape of RPC `tx` for C6KyV6Hv… on testnet (register_keyless from nb-kk-spec-1111.testnet)
  const view = {
    owner: "nb-kk-spec-1111.testnet",
    pk: "s7wwBC1d/grtRwfGbcZ0gmFmkV7l4NN1FLRwcDHVI58=",
    model_id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    bond: "494490000000000000000000",
    alpha_bps: 0,
    shield: 0,
    in_duel: null,
    tee: true,
  };
  const ok = { status: { SuccessValue: btoa(JSON.stringify(view)) }, transaction: { hash: "C6KyV6Hv" } };
  expect(enteredAgent(ok)?.pk).toBe(view.pk);
  const failed = {
    status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "bond required" } } } } },
  };
  for (const bad of [
    failed,
    { status: { SuccessValue: "" } },
    { status: { SuccessValue: btoa(JSON.stringify({ ...view, pk: "YLqgTOliaG+cZcWWOmxBwbrryeCafXlq4N5P+ChomTp=" })) } },
    { status: { SuccessValue: btoa("null") } },
    { status: { SuccessValue: "not base64!" } },
    null,
    "x",
  ])
    expect(enteredAgent(bad)).toBeNull();
});
