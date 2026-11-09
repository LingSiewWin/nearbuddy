// Route handlers against a fake solver account (`callFunctionRaw`) and a fake NEAR RPC (global fetch),
// so the chain-writing paths run without network: what each route sends on chain and how it maps errors.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KeyPair } from "near-api-js";
import type { Mandate } from "../../protocol/src/abi/arena.ts";
import { b64 } from "../../protocol/src/index.ts";
import {
  commitMessage,
  commitment,
  consentMessage,
  type Intent,
  proofHash,
  signIntent,
  type TeeProof,
  teeText,
  ZERO_PROOF,
} from "../../protocol/src/intent.ts";
import { agent, config, configV14, configV16 } from "./arena.fixture.ts";

const scratch = mkdtempSync(join(tmpdir(), "arena-routes-"));
process.env.ARENA_PAYLOADS = join(scratch, "payloads.json");
process.env.ARENA_HISTORY = join(scratch, "history.json");
// bun test shares the module cache across files: arena.ts reads ARENA_SECRET once, on whichever test file imports
// it first, so every importer sets the same default and the header is read back from the module.
process.env.ARENA_SECRET ??= "route-test-secret";
const { Arena, ARENA_SECRET } = await import("./arena.ts");
const KEY = { "x-arena-key": ARENA_SECRET };

type Call = { contractId?: string; methodName: string; args: Record<string, unknown>; deposit: bigint; gas: bigint };
/** Fake `Account`: records every call; `reply(call)` returns the JSON value or throws. */
function fakeSolver(reply: (c: Call) => unknown = () => null) {
  const calls: Call[] = [];
  const account = {
    callFunctionRaw: async (p: Call) => {
      calls.push(p);
      const v = reply(p);
      return {
        status: { SuccessValue: Buffer.from(JSON.stringify(v)).toString("base64") },
        transaction: { hash: `TX${calls.length}` },
      };
    },
  };
  return { calls, account: account as never };
}

/** Fake NEAR RPC behind `arenaView`: answers `call_function` queries by method name. */
async function withRpc<T>(
  views: Record<string, (args: Record<string, unknown>) => unknown>,
  f: (seen: string[]) => Promise<T>,
): Promise<T> {
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
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { result: bytes, logs: [], block_height: 1, block_hash: "h" },
      }),
    );
  }) as typeof fetch;
  try {
    return await f(seen);
  } finally {
    globalThis.fetch = real;
  }
}

const signed = (kp: KeyPair, over: Partial<Intent> = {}) =>
  signIntent(kp, {
    agent_pk: b64.enc(kp.getPublicKey().data),
    duel_id: "3",
    side: "Long",
    size_bps: 5000,
    nonce: "1",
    expires_at: "1900000000000000000",
    proof_hash: ZERO_PROOF,
    ...over,
  });

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
  const req = new Uint8Array(32).fill(4),
    res = new Uint8Array(32).fill(5);
  const tee: TeeProof = {
    kind: 2,
    request_hash: b64.enc(req),
    response_hash: b64.enc(res),
    signer: b64.enc(enclave.getPublicKey().data),
    signature: b64.enc(enclave.sign(teeText(2, "m/x", req, res)).signature),
  };
  const s = signed(kp, { proof_hash: proofHash(req, res) });
  const { calls, account } = fakeSolver();
  const arena = new Arena(account, "s.testnet", { listFollowers: async () => [] });
  await withRpc(
    { get_agent: (a) => ({ pk: a.agent_pk, model_id: "m/x", bond: "1", tee: true, in_duel: null }) },
    async (seen) => {
      const r = (await arena.route("POST", "/intent", JSON.stringify({ signed: s, tee }), KEY))!;
      assert.equal(r.code, 200);
      assert.deepEqual(seen, ["get_agent"]);
      assert.deepEqual(calls[0]!.args, { signed: s, tee });
    },
  );
  // the same proof for another model is refused before any gas is spent
  await withRpc(
    { get_agent: () => ({ pk: "x", model_id: "other/model", bond: "1", tee: true, in_duel: null }) },
    async () => {
      await assert.rejects(arena.route("POST", "/intent", JSON.stringify({ signed: s, tee }), KEY), /bad tee proof/);
      assert.equal(calls.length, 1);
    },
  );
});

test("POST /intent refuses a tampered signature before touching the chain", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  const s = signed(kp);
  const { calls, account } = fakeSolver();
  const arena = new Arena(account, "s.testnet", { listFollowers: async () => [] });
  await assert.rejects(
    arena.route("POST", "/intent", JSON.stringify({ ...s, intent: { ...s.intent, side: "Short" } }), KEY),
    /bad intent signature/,
  );
  assert.equal(calls.length, 0);
});

test("POST /resolve: an RPC wait error returns sent:false and still clears the duel's consumed injections", async () => {
  const { calls, account } = fakeSolver((c) => {
    if (c.methodName === "resolve_duel") throw new Error("Internal server error");
    return null;
  });
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
  const { account } = fakeSolver((c) => {
    if (c.methodName === "resolve_duel") throw new Error("resolve_duel failed: duel open");
    return null;
  });
  const arena = new Arena(account, "s.testnet");
  await withRpc({ get_config: () => ({ oracle_deposit: "100" }) }, async () => {
    await assert.rejects(arena.route("POST", "/resolve", JSON.stringify({ duel_id: "7" }), KEY), /duel open/);
  });
});

test("oracle deposit memo is refreshed from get_config and the call retried once on 'attach oracle_deposit'", async () => {
  let deposit = "100",
    min = 0n;
  const { calls, account } = fakeSolver((c) => {
    if (c.deposit < min) throw new Error("Smart contract panicked: attach oracle_deposit");
    return null;
  });
  const arena = new Arena(account, "s.testnet");
  await withRpc({ get_config: () => ({ oracle_deposit: deposit }) }, async (seen) => {
    await arena.route("POST", "/open_price", JSON.stringify({ duel_id: "9" }), KEY); // warms the memo (100, or an earlier test's value)
    deposit = "777";
    min = 777n; // the owner raised it with set_oracle; the memo is now stale
    const before = seen.length;
    const r = (await arena.route("POST", "/open_price", JSON.stringify({ duel_id: "9" }), KEY))!;
    assert.deepEqual(r.body, { tx: `TX${calls.length}` });
    assert.equal(seen.length - before, 1, "one get_config after the stale-deposit error");
  });
  const last = calls.slice(-2);
  assert.ok(last[0]!.deposit < 777n && last[1]!.deposit === 777n, `deposits ${last.map((c) => c.deposit)}`);
  assert.ok(last.every((c) => c.methodName === "request_open_price" && c.args.duel_id === "9"));
});

test("POST /duel: an RPC wait error after open_duel is recovered from chain by findDuel, polling with deps.sleep", async () => {
  const { calls, account } = fakeSolver((c) => {
    if (c.methodName === "open_duel") throw new Error("Internal server error");
    return null;
  });
  const slept: number[] = [];
  const arena = new Arena(account, "s.testnet", { sleep: async (ms) => void slept.push(ms) });
  const duel = { a: "A", b: "B", symbol: "wrap.near", close_at: "1700000000000000000" };
  let landed = 0; // the tx lands after two polls: get_config shows duel 4 only from the third poll on
  const duels: Record<string, unknown> = {
    "4": { a: "A", b: "B", close_at: duel.close_at, resolved: false },
    "3": { a: "A", b: "B", close_at: duel.close_at, resolved: true }, // an older, finished A-vs-B duel is not it
    "2": { a: "X", b: "Y", close_at: "1", resolved: false },
  };
  await withRpc(
    {
      get_config: () => ({ oracle_deposit: "100", next_duel: ++landed >= 3 ? "5" : "4" }),
      get_duel: (a) => duels[String(a.duel_id)] ?? null,
    },
    async () => {
      const r = (await arena.route("POST", "/duel", JSON.stringify(duel), KEY))!;
      assert.deepEqual(r.body, { duel_id: "4", tx: "" });
    },
  );
  assert.equal(calls.filter((c) => c.methodName === "open_duel").length, 1, "never resent");
  assert.deepEqual(slept, [3000, 3000]);
  assert.ok(arena.openDuels.has("4"));
});

test("POST /duel: findDuel gives up after 6 polls and rethrows the RPC error", async () => {
  const { account } = fakeSolver((c) => {
    if (c.methodName === "open_duel") throw new Error("Internal server error");
    return null;
  });
  const slept: number[] = [];
  const arena = new Arena(account, "s.testnet", { sleep: async (ms) => void slept.push(ms) });
  await withRpc({ get_config: () => ({ oracle_deposit: "100", next_duel: "0" }) }, async () => {
    await assert.rejects(
      arena.route("POST", "/duel", JSON.stringify({ a: "A", b: "B", symbol: "s", close_at: "1" }), KEY),
      /Internal server error/,
    );
  });
  assert.equal(slept.length, 6);
});

test("a 429 from the RPC is retried with exponential backoff through deps.sleep", async () => {
  let n = 0;
  const { calls, account } = fakeSolver(() => {
    if (++n < 3) throw new Error("HTTP 429 Rate limit");
    return { ok: true };
  });
  const slept: number[] = [];
  const arena = new Arena(account, "s.testnet", { sleep: async (ms) => void slept.push(ms) });
  const r = (await arena.route(
    "POST",
    "/register",
    JSON.stringify({ agent_pk: "PK", model_id: "m", bond: "1" }),
    KEY,
  ))!;
  assert.deepEqual(r.body, { tx: "TX3", agent: { ok: true } });
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, [1500, 3000]);
});

const ARENA_ID = process.env.ARENA_CONTRACT ?? "arena.nearbuddy-solver.testnet";

test("POST /commit verifies the agent's commit signature and relays commit_intent without quoting", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  const s = signed(kp);
  const c = commitment(s.intent, new Uint8Array(32).fill(7));
  const body = {
    duel_id: "3",
    agent_pk: s.intent.agent_pk,
    commitment: b64.enc(c),
    sig: b64.enc(kp.sign(commitMessage(ARENA_ID, "3", c)).signature),
  };
  const { calls, account } = fakeSolver();
  let quoted = 0;
  const arena = new Arena(account, "s.testnet", {
    listFollowers: async () => {
      quoted++;
      return [];
    },
  });
  const r = (await arena.route("POST", "/commit", JSON.stringify(body), KEY))!;
  assert.deepEqual(r.body, { tx: "TX1", at: null }, "no receipt to time: at is null");
  assert.equal(calls[0]!.methodName, "commit_intent");
  assert.deepEqual(calls[0]!.args, body);
  assert.equal(quoted, 0, "a commitment hides the call: nothing to quote");
  assert.equal(arena.intents.length, 0);
  // signed for another duel: refused before any gas is spent
  await assert.rejects(
    arena.route("POST", "/commit", JSON.stringify({ ...body, duel_id: "4" }), KEY),
    /bad commit signature/,
  );
  assert.equal(calls.length, 1);
});

/** A solver account whose commit_intent receipt ran in ARENA_BLOCK, and an RPC that times blocks; `blocks` logs reads. */
function timedCommit() {
  const blocks: unknown[] = [];
  const account = {
    callFunctionRaw: async () => ({
      status: { SuccessValue: "" },
      transaction: { hash: "TXC" },
      receipts_outcome: [
        { block_hash: "OTHER", outcome: { executor_id: "s.testnet" } },
        { block_hash: "ARENA_BLOCK", outcome: { executor_id: ARENA_ID } },
      ],
    }),
    provider: {
      viewBlock: async (q: { blockId: string }) => {
        blocks.push(q.blockId);
        return { header: { timestamp_nanosec: "1700000000123456789" } };
      },
    },
  };
  return { blocks, account: account as never };
}

test("POST /commit answers the block time of the arena receipt, the time the contract holds the commitment under", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  const s = signed(kp);
  const c = commitment(s.intent, new Uint8Array(32).fill(8));
  const body = {
    duel_id: "3",
    agent_pk: s.intent.agent_pk,
    commitment: b64.enc(c),
    sig: b64.enc(kp.sign(commitMessage(ARENA_ID, "3", c)).signature),
  };
  const { blocks, account } = timedCommit();
  const arena = new Arena(account, "s.testnet", { config: async () => config() });
  const r = (await arena.route("POST", "/commit", JSON.stringify(body), KEY))!;
  assert.deepEqual(r.body, { tx: "TXC", at: "1700000000123456789" });
  assert.deepEqual(blocks, ["ARENA_BLOCK"]);
  // deploy 16.1 plants no headlines a commit could void: no block read, at is null
  const old = timedCommit();
  const v16 = new Arena(old.account, "s.testnet", { config: async () => configV16() });
  const r16 = (await v16.route("POST", "/commit", JSON.stringify(body), KEY))!;
  assert.deepEqual(r16.body, { tx: "TXC", at: null });
  assert.deepEqual(old.blocks, []);
});

test("POST /reveal relays reveal_intent with the salt and quotes followers then, not at commit", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  const s = signed(kp);
  const salt = b64.enc(new Uint8Array(32).fill(7));
  const { calls, account } = fakeSolver();
  const asked: string[] = [];
  const arena = new Arena(account, "s.testnet", {
    listFollowers: async (pk) => {
      asked.push(pk);
      return [];
    },
  });
  const r = (await arena.route("POST", "/reveal", JSON.stringify({ signed: s, salt, tee: null }), KEY))!;
  assert.deepEqual(r.body, { tx: "TX1", quotes: [] });
  assert.equal(calls[0]!.methodName, "reveal_intent");
  assert.deepEqual(calls[0]!.args, { signed: s, salt, tee: null });
  assert.deepEqual(asked, [s.intent.agent_pk]);
  assert.equal(arena.intents.length, 1, "the revealed intent shows on the SOLVER panel like a posted one");
  const tampered = { signed: { ...s, intent: { ...s.intent, nonce: "2" } }, salt };
  await assert.rejects(arena.route("POST", "/reveal", JSON.stringify(tampered), KEY), /bad intent signature/);
  assert.equal(calls.length, 1);
});

test("POST /commit and /reveal need the arena key", async () => {
  const { calls, account } = fakeSolver();
  const arena = new Arena(account, "s.testnet");
  for (const url of ["/commit", "/reveal"]) assert.equal((await arena.route("POST", url, "{}", {}))!.code, 401);
  assert.equal(calls.length, 0);
});

test("POST /duel with sig_a and sig_b checks both consents and calls open_duel_consented", async () => {
  const ka = KeyPair.fromRandom("ed25519"),
    kb = KeyPair.fromRandom("ed25519");
  const a = b64.enc(ka.getPublicKey().data),
    b = b64.enc(kb.getPublicKey().data);
  const close_at = "1700000000000000000";
  const msg = consentMessage(ARENA_ID, a, b, "wrap.near", close_at);
  const duel = {
    a,
    b,
    symbol: "wrap.near",
    close_at,
    sig_a: b64.enc(ka.sign(msg).signature),
    sig_b: b64.enc(kb.sign(msg).signature),
  };
  const { calls, account } = fakeSolver(() => 11);
  const arena = new Arena(account, "s.testnet");
  await withRpc({ get_config: () => ({ oracle_deposit: "100" }) }, async () => {
    const r = (await arena.route("POST", "/duel", JSON.stringify(duel), KEY))!;
    assert.deepEqual(r.body, { duel_id: "11", tx: "TX1" });
    // swapped signatures: each one was made over the same bytes but by the other agent
    await assert.rejects(
      arena.route("POST", "/duel", JSON.stringify({ ...duel, sig_a: duel.sig_b, sig_b: duel.sig_a }), KEY),
      /bad consent signature/,
    );
    // a's consent to a duel closing at another time
    await assert.rejects(
      arena.route("POST", "/duel", JSON.stringify({ ...duel, close_at: "1700000000000000001" }), KEY),
      /bad consent signature/,
    );
    const half = (await arena.route("POST", "/duel", JSON.stringify({ ...duel, sig_b: undefined }), KEY))!;
    assert.equal(half.code, 400);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.methodName, "open_duel_consented");
  assert.deepEqual(calls[0]!.args, duel);
});

test("pairOnce skips the tick when require_consent is on, and pairs idle agents with plain open_duel when off", async () => {
  const idle = (pk: string) => agent(pk, { bond: "1" });
  for (const require_consent of [true, false]) {
    const { calls, account } = fakeSolver(() => 21);
    let boards = 0;
    const arena = new Arena(account, "s.testnet", {
      config: async () => configV14({ oracle_deposit: "100", require_consent }),
      leaderboard: async () => {
        boards++;
        return [idle("P1"), idle("P2")];
      },
    });
    const opened = await withRpc({ get_config: () => ({ oracle_deposit: "100" }) }, () => arena.pairOnce());
    if (require_consent) {
      assert.deepEqual(opened, []);
      assert.equal(calls.length, 0, "no open_duel that would panic");
      assert.equal(boards, 0);
    } else {
      assert.deepEqual(opened, ["21"]);
      assert.deepEqual(
        calls.map((c) => [c.methodName, c.args.a, c.args.b]),
        [["open_duel", "P1", "P2"]],
      );
    }
  }
});

test("POST /duel without sigs still calls plain open_duel", async () => {
  const { calls, account } = fakeSolver(() => 12);
  const arena = new Arena(account, "s.testnet");
  const duel = { a: "A", b: "B", symbol: "wrap.near", close_at: "1" };
  await withRpc({ get_config: () => ({ oracle_deposit: "100" }) }, async () => {
    const r = (await arena.route("POST", "/duel", JSON.stringify(duel), KEY))!;
    assert.deepEqual(r.body, { duel_id: "12", tx: "TX1" });
  });
  assert.equal(calls[0]!.methodName, "open_duel");
  assert.deepEqual(calls[0]!.args, duel);
});

test("GET /execution: a batched intent records every follower's fill against the duel's Outlayer open price", async () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/oneclick-quote.json", import.meta.url), "utf8"),
  ) as import("./oneclick.ts").Quote;
  const mandate = (cap: string) => ({
    allowance: "10000000000000000000000000",
    spent: "0",
    per_tx_cap: cap,
    allowed_tokens: [],
    expires_at: "1900000000000000000",
    revoked: false,
  });
  const asked: string[] = [];
  const { account } = fakeSolver();
  const arena = new Arena(account, "s.testnet", {
    config: async () => configV14(),
    listFollowers: async () => [
      ["f1.testnet", mandate("750000000000000000000000")], // 0.75 NEAR
      ["f2.testnet", mandate("250000000000000000000000")], // 0.25 NEAR
    ],
    quote: async (req) => {
      asked.push(`${req.swapType} ${req.amount}`);
      return fixture; // 1.0 wNEAR -> 3.744739 USDC
    },
  });
  const s = signed(KeyPair.fromRandom("ed25519"), { nonce: "7", side: "Short" });
  await withRpc({ get_duel: () => ({ symbol: "wrap.near", open_price: "380000000", outcome: null }) }, async (seen) => {
    await arena.route("POST", "/intent", JSON.stringify({ signed: s }), KEY);
    assert.deepEqual(seen, ["get_duel"]);
  });
  assert.deepEqual(asked, ["EXACT_INPUT 1000000000000000000000000"]); // one RFQ for the sum, a Short sells NEAR
  const r = (await arena.route("GET", "/execution", ""))!;
  assert.equal(r.code, 200);
  // 3.744739 USDC per NEAR vs a 3.80 mid: -145.42 bps at the batch price; f2's floor costs it 0.01 bps
  const row = (follower: string, amount_in: string, quote_out: string, bps_vs_oracle: number) => ({
    follower,
    intent_nonce: "7",
    amount_in,
    quote_out,
    oracle_mid: "380000000",
    quoted_at: Date.parse(fixture.timestamp),
    bps_vs_oracle,
    agent_pk: s.intent.agent_pk,
    duel_id: "3",
    oracle_source: "outlayer_open",
    side: "Short",
  });
  assert.deepEqual((r.body as { quality: unknown[] }).quality, [
    row("f1.testnet", "750000000000000000000000", "2808555", -145.42),
    row("f2.testnet", "250000000000000000000000", "936184", -145.43),
  ]);
  const snap = (await arena.route("GET", "/arena", ""))!.body as { quality: unknown[] };
  assert.equal(snap.quality.length, 2);
});

test("GET /execution: no oracle mid (no Outlayer price, spot down) records nothing; the intent still lands", async () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/oneclick-quote.json", import.meta.url), "utf8"),
  ) as import("./oneclick.ts").Quote;
  const { account } = fakeSolver();
  const arena = new Arena(account, "s.testnet", {
    config: async () => configV14(),
    listFollowers: async () => [
      [
        "f1.testnet",
        {
          allowance: "1000",
          spent: "0",
          per_tx_cap: "1000",
          allowed_tokens: [],
          expires_at: "1900000000000000000",
          revoked: false,
        },
      ],
    ],
    quote: async () => fixture,
    oracleMid: async () => null,
  });
  const r = (await arena.route(
    "POST",
    "/intent",
    JSON.stringify({ signed: signed(KeyPair.fromRandom("ed25519")) }),
    KEY,
  ))!;
  assert.equal((r.body as { quotes: { quote_out?: string }[] }).quotes[0]?.quote_out, fixture.quote.amountOut);
  assert.deepEqual((await arena.route("GET", "/execution", ""))!.body, { quality: [] });
});

test("B17: the day cap's ledger survives a solver restart (history file)", async () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/oneclick-quote.json", import.meta.url), "utf8"),
  ) as import("./oneclick.ts").Quote;
  const deps = {
    config: async () => configV14(),
    listFollowers: async (): Promise<[string, Mandate][]> => [
      [
        "f1.testnet",
        {
          allowance: "1000",
          spent: "0",
          per_tx_cap: "600",
          allowed_tokens: [],
          expires_at: "1900000000000000000",
          revoked: false,
        },
      ],
    ],
    quote: async () => fixture,
    oracleMid: async () => null,
  };
  const old = process.env.CAP_PER_DAY_YOCTO;
  process.env.CAP_PER_DAY_YOCTO = "1000";
  try {
    const first = new Arena(fakeSolver().account, "s.testnet", deps);
    await first.route("POST", "/intent", JSON.stringify({ signed: signed(KeyPair.fromRandom("ed25519")) }), KEY);
    const restarted = new Arena(fakeSolver().account, "s.testnet", deps);
    await withRpc({ get_config: () => ({ next_duel: "0" }) }, () => restarted.bootstrap());
    const [q] = await restarted.quotesFor("pk");
    assert.equal(q?.error, "over CAP_PER_DAY_YOCTO: 600 quoted in 24 h + 600 > 1000");
  } finally {
    if (old === undefined) delete process.env.CAP_PER_DAY_YOCTO;
    else process.env.CAP_PER_DAY_YOCTO = old;
  }
});

// ---------------------------------------------------------------- deploy 15 (verified settlement)

const MANDATE = {
  allowance: "1000",
  spent: "0",
  per_tx_cap: "600",
  allowed_tokens: [],
  expires_at: "1900000000000000000",
  revoked: false,
};
const V15 = async () => config({ intents_account: "intents-stub.testnet" });

test("POST /intent: a landed intent answers 200 with its tx even when the follower view throws", async () => {
  const { calls, account } = fakeSolver();
  const arena = new Arena(account, "s.testnet");
  const r = await withRpc(
    {
      get_config: () => ({ oracle_deposit: "0" }),
      list_followers: () => {
        throw new Error("429 Too Many Requests");
      },
    },
    () => arena.route("POST", "/intent", JSON.stringify(signed(KeyPair.fromRandom("ed25519"))), KEY),
  );
  assert.equal(r!.code, 200);
  const body = r!.body as { tx: string; quotes: unknown[]; quote_error?: string };
  assert.equal(body.tx, "TX1");
  assert.deepEqual(body.quotes, []);
  assert.ok(body.quote_error, "the quote failure is reported in the body");
  assert.equal(calls[0]!.methodName, "post_intent");
  assert.equal(arena.intents.length, 1, "the landed intent is recorded");
});

test("deploy 15: followers come from get_follow for followers this solver settled for, not list_followers", async () => {
  const { account } = fakeSolver();
  const asked: string[] = [];
  const arena = new Arena(account, "s.testnet", {
    config: V15,
    getFollow: async (_pk, f) => {
      asked.push(f);
      return f === "f1.testnet" ? MANDATE : null;
    },
  });
  arena.fills.push(
    { agent_pk: "pk", follower: "f1.testnet", report: null, tx: "T" },
    { agent_pk: "pk", follower: "gone.testnet", report: null, tx: "T" },
  );
  assert.deepEqual(await arena.followersOf("pk"), [["f1.testnet", MANDATE]]);
  assert.deepEqual(asked.sort(), ["f1.testnet", "gone.testnet"]);
  const r = await arena.route("GET", "/followers?pk=pk", "");
  assert.deepEqual(r!.body, [["f1.testnet", MANDATE]]);
});

test("deploy 15: one batched quote with the arena as recipient, on mainnet too", async () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/oneclick-quote.json", import.meta.url), "utf8"),
  ) as import("./oneclick.ts").Quote;
  const recipients: string[] = [];
  const old = process.env.FILL_RECIPIENT;
  delete process.env.FILL_RECIPIENT;
  try {
    const arena = new Arena(fakeSolver().account, "nearbuddy-solver.near", {
      config: V15,
      listFollowers: async () => [
        ["f1.near", MANDATE],
        ["f2.near", MANDATE],
      ],
      quote: async (req) => {
        recipients.push(`${req.recipient} ${req.recipientType} ${req.amount}`);
        return fixture;
      },
      oracleMid: async () => null,
    });
    const q = await arena.quotesFor("pk", "Short");
    assert.deepEqual(recipients, ["arena.nearbuddy-solver.near INTENTS 1200"]);
    assert.deepEqual(
      q.map((x) => x.recipient),
      ["arena.nearbuddy-solver.near", "arena.nearbuddy-solver.near"],
    );
  } finally {
    if (old !== undefined) process.env.FILL_RECIPIENT = old;
  }
});

test("deploy 15 on testnet: settle credits the stub with the batch's output first, then settles", async () => {
  const { calls, account } = fakeSolver((c) => (c.methodName === "settle_follow" ? { settled: 2 } : null));
  const arena = new Arena(account, "s.testnet", { config: V15 });
  const fill = (n: string, token: string, out: string) => ({
    intent_nonce: n,
    token,
    amount_in: "10",
    amount_out: out,
    swap_tx: "",
  });
  const body = JSON.stringify({
    agent_pk: "pk",
    follower: "f1.testnet",
    fills: [fill("1", "nep141:usdc", "3"), fill("2", "nep141:usdc", "4")],
  });
  const r = await arena.route("POST", "/settle_follow", body, KEY);
  assert.equal(r!.code, 200);
  assert.deepEqual(
    calls.map((c) => [c.contractId, c.methodName]),
    [
      ["intents-stub.testnet", "stub_credit"],
      ["arena.nearbuddy-solver.testnet", "settle_follow"],
    ],
  );
  assert.deepEqual(calls[0]!.args, {
    receiver_id: "arena.nearbuddy-solver.testnet",
    token_id: "nep141:usdc",
    amount: "7",
  });
  const sent = calls[1]!.args.fills as { swap_tx: string }[];
  assert.deepEqual(
    sent.map((f) => f.swap_tx),
    ["stub:TX1", "stub:TX1"],
  );
  assert.deepEqual(arena.fills.at(-1)?.report, { settled: 2 });
});

test("deploy 15: a dry-quote fill is refused with 400 before any chain call", async () => {
  const { calls, account } = fakeSolver();
  const arena = new Arena(account, "s.testnet", { config: V15 });
  const fills = [{ intent_nonce: "1", token: "t", amount_in: "1", amount_out: "1", swap_tx: "dry-quote:1" }];
  const r = await arena.route("POST", "/settle_follow", JSON.stringify({ agent_pk: "pk", follower: "f", fills }), KEY);
  assert.equal(r!.code, 400);
  assert.match((r!.body as { error: string }).error, /dry quote unsettleable/);
  assert.equal(calls.length, 0);
});

test("deploy 14: settle passes fills through untouched (no stub credit)", async () => {
  const { calls, account } = fakeSolver();
  const arena = new Arena(account, "s.testnet", { config: async () => configV14() });
  const fills = [{ intent_nonce: "1", token: "t", amount_in: "1", amount_out: "1", swap_tx: "dry-quote:1" }];
  await arena.route("POST", "/settle_follow", JSON.stringify({ agent_pk: "pk", follower: "f", fills }), KEY);
  assert.deepEqual(
    calls.map((c) => c.methodName),
    ["settle_follow"],
  );
});

test("pairOnce reads the leaderboard paged {from: 0, limit: 100}", async () => {
  let args: Record<string, unknown> | null = null;
  const arena = new Arena(fakeSolver().account, "s.testnet", {
    config: async () => configV14({ require_consent: false }),
  });
  await withRpc(
    {
      leaderboard: (a) => {
        args = a;
        return [];
      },
    },
    () => arena.pairOnce(),
  );
  assert.deepEqual(args, { from: 0, limit: 100 });
});
