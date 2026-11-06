// Route handlers against a fake solver account (`callFunctionRaw`) and a fake NEAR RPC (global fetch),
// so the chain-writing paths run without network: what each route sends on chain and how it maps errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { b64 } from "../../protocol/src/index.ts";
import { ZERO_PROOF, proofHash, signIntent, teeText, type Intent, type TeeProof } from "../../protocol/src/intent.ts";

const scratch = mkdtempSync(join(tmpdir(), "arena-routes-"));
process.env.ARENA_PAYLOADS = join(scratch, "payloads.json");
process.env.ARENA_HISTORY = join(scratch, "history.json");
// bun test shares the module cache across files: arena.ts reads ARENA_SECRET once, on whichever test file imports
// it first, so every importer sets the same default and the header is read back from the module.
process.env.ARENA_SECRET ??= "route-test-secret";
const { Arena, ARENA_SECRET } = await import("./arena.ts");
const KEY = { "x-arena-key": ARENA_SECRET };

type Call = { methodName: string; args: Record<string, unknown>; deposit: bigint; gas: bigint };
/** Fake `Account`: records every call; `reply(call)` returns the JSON value or throws. */
function fakeSolver(reply: (c: Call) => unknown = () => null) {
  const calls: Call[] = [];
  const account = {
    callFunctionRaw: async (p: Call) => {
      calls.push(p);
      const v = reply(p);
      return { status: { SuccessValue: Buffer.from(JSON.stringify(v)).toString("base64") }, transaction: { hash: `TX${calls.length}` } };
    },
  };
  return { calls, account: account as never };
}

/** Fake NEAR RPC behind `arenaView`: answers `call_function` queries by method name. */
async function withRpc<T>(views: Record<string, (args: Record<string, unknown>) => unknown>, f: (seen: string[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; params: { method_name: string; args_base64: string } };
    const method = req.params.method_name;
    seen.push(method);
    const view = views[method];
    if (!view) throw new Error(`unexpected view ${method}`);
    const value = view(JSON.parse(Buffer.from(req.params.args_base64, "base64").toString()));
    const bytes = [...Buffer.from(JSON.stringify(value))];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { result: bytes, logs: [], block_height: 1, block_hash: "h" } }));
  }) as typeof fetch;
  try {
    return await f(seen);
  } finally {
    globalThis.fetch = real;
  }
}

const signed = (kp: KeyPair, over: Partial<Intent> = {}) =>
  signIntent(kp, { agent_pk: b64.enc(kp.getPublicKey().data), duel_id: "3", side: "Long", size_bps: 5000, nonce: "1", expires_at: "1900000000000000000", proof_hash: ZERO_PROOF, ...over });

test("POST /register passes agent_pk, model_id, tee and register_sig through with the bond as deposit", async () => {
  const { calls, account } = fakeSolver(() => ({ pk: "PK", bond: "1" }));
  const arena = new Arena(account, "s.testnet");
  const body = JSON.stringify({ agent_pk: "PK", model_id: "m/x", bond: "5000", tee: true, register_sig: "SIG" });
  const r = (await arena.route("POST", "/register", body, KEY))!;
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { tx: "TX1", agent: { pk: "PK", bond: "1" } });
  assert.equal(calls[0]!.methodName, "register_agent");
  assert.deepEqual(calls[0]!.args, { agent_pk: "PK", model_id: "m/x", tee: true, register_sig: "SIG" });
  assert.equal(calls[0]!.deposit, 5000n);
});

test("POST /register without tee or register_sig sends tee:false and leaves register_sig undefined", async () => {
  const { calls, account } = fakeSolver();
  const arena = new Arena(account, "s.testnet");
  await arena.route("POST", "/register", JSON.stringify({ agent_pk: "PK", model_id: "m", bond: "1" }), KEY);
  assert.equal(calls[0]!.args.tee, false);
  assert.equal(calls[0]!.args.register_sig, undefined);
});

test("POST /intent accepts a bare SignedIntent and posts it with tee:null", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  const s = signed(kp);
  const { calls, account } = fakeSolver();
  const arena = new Arena(account, "s.testnet", { listFollowers: async () => [] });
  const r = (await arena.route("POST", "/intent", JSON.stringify(s), KEY))!;
  assert.deepEqual(r.body, { tx: "TX1", quotes: [] });
  assert.equal(calls[0]!.methodName, "post_intent");
  assert.deepEqual(calls[0]!.args, { signed: s, tee: null });
  assert.equal(arena.intents.length, 1);
});

test("POST /intent accepts {signed, tee}, checks the proof against get_agent's model and posts both", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  const enclave = KeyPair.fromRandom("ed25519");
  const req = new Uint8Array(32).fill(4), res = new Uint8Array(32).fill(5);
  const tee: TeeProof = {
    kind: 2, request_hash: b64.enc(req), response_hash: b64.enc(res), signer: b64.enc(enclave.getPublicKey().data),
    signature: b64.enc(enclave.sign(teeText(2, "m/x", req, res)).signature),
  };
  const s = signed(kp, { proof_hash: proofHash(req, res) });
  const { calls, account } = fakeSolver();
  const arena = new Arena(account, "s.testnet", { listFollowers: async () => [] });
  await withRpc({ get_agent: (a) => ({ pk: a.agent_pk, model_id: "m/x", bond: "1", tee: true, in_duel: null }) }, async (seen) => {
    const r = (await arena.route("POST", "/intent", JSON.stringify({ signed: s, tee }), KEY))!;
    assert.equal(r.code, 200);
    assert.deepEqual(seen, ["get_agent"]);
    assert.deepEqual(calls[0]!.args, { signed: s, tee });
  });
  // the same proof for another model is refused before any gas is spent
  await withRpc({ get_agent: () => ({ pk: "x", model_id: "other/model", bond: "1", tee: true, in_duel: null }) }, async () => {
    await assert.rejects(arena.route("POST", "/intent", JSON.stringify({ signed: s, tee }), KEY), /bad tee proof/);
    assert.equal(calls.length, 1);
  });
});

test("POST /intent refuses a tampered signature before touching the chain", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  const s = signed(kp);
  const { calls, account } = fakeSolver();
  const arena = new Arena(account, "s.testnet", { listFollowers: async () => [] });
  await assert.rejects(arena.route("POST", "/intent", JSON.stringify({ ...s, intent: { ...s.intent, side: "Short" } }), KEY), /bad intent signature/);
  assert.equal(calls.length, 0);
});

test("POST /resolve: an RPC wait error returns sent:false and still clears the duel's consumed injections", async () => {
  const { calls, account } = fakeSolver((c) => { if (c.methodName === "resolve_duel") throw new Error("Internal server error"); return null; });
  const arena = new Arena(account, "s.testnet");
  arena.consumed.add("7:A:1").add("8:A:1");
  await withRpc({ get_config: () => ({ oracle_deposit: "100" }) }, async () => {
    const r = (await arena.route("POST", "/resolve", JSON.stringify({ duel_id: 7 }), KEY))!;
    assert.deepEqual(r.body, { tx: "", sent: false });
  });
  assert.equal(calls[0]!.methodName, "resolve_duel");
  assert.deepEqual(calls[0]!.args, { duel_id: "7" });
  assert.deepEqual([...arena.consumed], ["8:A:1"]);
});

test("POST /resolve: a contract error is not swallowed", async () => {
  const { account } = fakeSolver((c) => { if (c.methodName === "resolve_duel") throw new Error("resolve_duel failed: duel open"); return null; });
  const arena = new Arena(account, "s.testnet");
  await withRpc({ get_config: () => ({ oracle_deposit: "100" }) }, async () => {
    await assert.rejects(arena.route("POST", "/resolve", JSON.stringify({ duel_id: "7" }), KEY), /duel open/);
  });
});

test("oracle deposit memo is refreshed from get_config and the call retried once on 'attach oracle_deposit'", async () => {
  let deposit = "100", min = 0n;
  const { calls, account } = fakeSolver((c) => {
    if (c.deposit < min) throw new Error("Smart contract panicked: attach oracle_deposit");
    return null;
  });
  const arena = new Arena(account, "s.testnet");
  await withRpc({ get_config: () => ({ oracle_deposit: deposit }) }, async (seen) => {
    await arena.route("POST", "/open_price", JSON.stringify({ duel_id: "9" }), KEY); // warms the memo (100, or an earlier test's value)
    deposit = "777"; min = 777n; // the owner raised it with set_oracle; the memo is now stale
    const before = seen.length;
    const r = (await arena.route("POST", "/open_price", JSON.stringify({ duel_id: "9" }), KEY))!;
    assert.deepEqual(r.body, { tx: `TX${calls.length}` });
    assert.equal(seen.length - before, 1, "one get_config after the stale-deposit error");
  });
  const last = calls.slice(-2);
  assert.ok(last[0]!.deposit < 777n && last[1]!.deposit === 777n, `deposits ${last.map((c) => c.deposit)}`);
  assert.ok(last.every((c) => c.methodName === "request_open_price" && c.args.duel_id === "9"));
});
