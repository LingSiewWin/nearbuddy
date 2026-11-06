// The facilitator handler over a real local http server with fake deps: no NEAR account, no RPC, no key file.
// Covers the x402 routes (/verify, /settle, /supported, /ledger), the guarantor/arena delegation, the arena
// auth gate and the error mapping (bad JSON = 400, anything else = 500).

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Mandate, Vault } from "../../protocol/src/chain.ts";
import { Agent, type SignedIou } from "../../protocol/src/index.ts";
import { NETWORK, SCHEME, type VerifyRequest, type VerifyResponse, X402_VERSION } from "../../protocol/src/x402.ts";
import { createServer, type ServerDeps } from "./server.ts";

const scratch = mkdtempSync(join(tmpdir(), "server-test-"));
process.env.ARENA_PAYLOADS = join(scratch, "payloads.json");
process.env.ARENA_HISTORY = join(scratch, "history.json");
process.env.ARENA_SECRET ??= "route-test-secret"; // shared module cache: see arena.routes.test.ts
const { Arena, ARENA_SECRET } = await import("./arena.ts");

const OWNER = "owner.testnet";
const PAYEE = "api.testnet";
const FAR = (BigInt(Date.now()) * 1_000_000n + 3_600_000_000_000n).toString(); // +1 h in ns

type Call = { methodName: string; args: Record<string, unknown> };
/** Fake solver account: `settle_batch` returns a report accepting every IOU. */
function fakeAccount(calls: Call[] = []) {
  return {
    calls,
    account: {
      callFunctionRaw: async (p: Call) => {
        calls.push(p);
        const ious = p.args.ious as SignedIou[];
        const report = {
          settled: ious.length,
          total_paid: ious.reduce((a, s) => a + BigInt(s.iou.amount), 0n).toString(),
          solver_fee: "0",
          covered_by_solver: "0",
          rejected: [],
        };
        return {
          status: { SuccessValue: Buffer.from(JSON.stringify(report)).toString("base64") },
          transaction: { hash: `SETTLE${calls.length}` },
          transaction_outcome: { outcome: { gas_burnt: 1e12 } },
          receipts_outcome: [{ outcome: { gas_burnt: 2e12 } }],
        };
      },
    } as never,
  };
}

const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  owner: OWNER,
  allowance: "1000",
  spent: "0",
  per_tx_cap: "300",
  allowed_payees: [],
  expires_at: FAR,
  revoked: false,
  ...over,
});
const vault = (over: Partial<Vault> = {}): Vault => ({ balance: "5000", pending_withdraw: null, ...over });

/** Serve `createServer(deps)` on a random port for one test. */
async function serve<T>(over: Partial<ServerDeps>, f: (base: string) => Promise<T>): Promise<T> {
  const ledgerFile = join(mkdtempSync(join(scratch, "s-")), "ledger.json");
  const deps: ServerDeps = {
    solverId: "s.testnet",
    account: fakeAccount().account,
    guarantor: { route: async () => null },
    arena: { route: async () => null },
    ledgerFile,
    autoBatch: 200,
    autoAgeMs: 60_000,
    getMandate: async () => mandate(),
    getVault: async () => vault(),
    ...over,
  };
  const srv = httpServer(createServer(deps).handler).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const { port } = srv.address() as { port: number };
  try {
    return await f(`http://127.0.0.1:${port}`);
  } finally {
    srv.close();
  }
}
const get = async (base: string, path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, type: r.headers.get("content-type"), body: (await r.json()) as never };
};
const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as never };
};

const verifyReq = (s: SignedIou, over: Partial<VerifyRequest> = {}): VerifyRequest => {
  const accepted = {
    scheme: SCHEME,
    network: NETWORK,
    amount: "100",
    asset: "NEAR",
    payTo: PAYEE,
    maxTimeoutSeconds: 60,
  };
  return {
    x402Version: X402_VERSION,
    paymentPayload: { x402Version: X402_VERSION, accepted, payload: s },
    paymentRequirements: accepted,
    ...over,
  };
};
const iou = (agent: Agent, amount = "100") => agent.sign({ owner: OWNER, payee: PAYEE, amount, expires_at: FAR });

test("GET /supported and GET /ledger answer offline with the solver id", async () => {
  await serve({}, async (base) => {
    const s = await get(base, "/supported");
    assert.equal(s.status, 200);
    assert.equal(s.type, "application/json");
    assert.deepEqual(s.body, { kinds: [{ x402Version: X402_VERSION, scheme: SCHEME, network: NETWORK }] });
    const l = await get(base, "/ledger");
    assert.deepEqual(l.body, { solver: "s.testnet", carrying: 0, oldest_ms: 0, exposure: [] });
  });
});

test("POST /verify refuses a foreign scheme or an IOU under the requirements without touching the chain", async () => {
  let reads = 0;
  const agent = new Agent();
  const getMandate = async () => {
    reads++;
    return mandate();
  };
  await serve({ getMandate }, async (base) => {
    const bad = verifyReq(iou(agent), { x402Version: 1 });
    assert.deepEqual((await post(base, "/verify", bad)).body, { isValid: false, invalidReason: "unsupported_scheme" });
    const under = verifyReq(iou(agent, "50"));
    assert.deepEqual((await post(base, "/verify", under)).body, {
      isValid: false,
      invalidReason: "iou does not satisfy requirements",
    });
    const wrongPayee = verifyReq(agent.sign({ owner: OWNER, payee: "other.testnet", amount: "100", expires_at: FAR }));
    assert.equal(((await post(base, "/verify", wrongPayee)).body as VerifyResponse).isValid, false);
  });
  assert.equal(reads, 0);
});

test("POST /verify underwrites a good IOU, carries it, then refuses the same nonce and a tampered signature", async () => {
  const agent = new Agent();
  await serve({}, async (base) => {
    const s = iou(agent);
    const ok = await post(base, "/verify", verifyReq(s));
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { isValid: true, payer: OWNER, extra: { solver: "s.testnet" } });
    const l = (await get(base, "/ledger")).body as {
      carrying: number;
      exposure: { agent_pk: string; yocto: string }[];
    };
    assert.equal(l.carrying, 1);
    assert.deepEqual(l.exposure, [{ agent_pk: agent.pkB64, yocto: "100" }]);

    const dup = (await post(base, "/verify", verifyReq(s))).body as VerifyResponse;
    assert.equal(dup.invalidReason, "duplicate nonce");
    const forged = { ...s, iou: { ...s.iou, amount: "200", nonce: "999" } };
    const bad = (await post(base, "/verify", verifyReq(forged))).body as VerifyResponse;
    assert.equal(bad.invalidReason, "bad signature");
  });
});

test("POST /verify maps mandate and vault policy to invalidReason", async () => {
  const agent = new Agent();
  const cases: [Partial<Mandate> | null, Partial<Vault> | null, string][] = [
    [null, {}, "no mandate on chain"],
    [{ revoked: true }, {}, "mandate revoked"],
    [{ owner: "x.testnet" }, {}, "owner mismatch"],
    [{ per_tx_cap: "99" }, {}, "amount exceeds per_tx_cap"],
    [{ allowed_payees: ["other.testnet"] }, {}, "payee not allowed"],
    [{ allowance: "150", spent: "60" }, {}, "allowance exhausted (incl. unsettled)"],
    [{}, null, "no vault"],
    [{}, { pending_withdraw: ["1", "2"] }, "owner has a withdrawal pending"],
    [{}, { balance: "99" }, "vault balance below carried exposure"],
  ];
  for (const [m, v, reason] of cases) {
    await serve(
      { getMandate: async () => (m ? mandate(m) : null), getVault: async () => (v ? vault(v) : null) },
      async (base) => {
        const r = (await post(base, "/verify", verifyReq(iou(agent)))).body as VerifyResponse;
        assert.equal(r.isValid, false, reason);
        assert.equal(r.invalidReason, reason);
      },
    );
  }
});

test("POST /settle: nothing carried is a success with errorReason; a carried IOU goes to settle_batch", async () => {
  const agent = new Agent();
  const { calls, account } = fakeAccount();
  await serve({ account }, async (base) => {
    assert.deepEqual((await post(base, "/settle", "")).body, {
      success: true,
      transaction: "",
      network: NETWORK,
      errorReason: "nothing to settle",
    });
    const s = iou(agent, "150");
    await post(base, "/verify", verifyReq(s));
    const r = await post(base, "/settle", "");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      success: true,
      transaction: "SETTLE1",
      network: NETWORK,
      amount: "150",
      txHash: "SETTLE1",
      report: { settled: 1, total_paid: "150", solver_fee: "0", covered_by_solver: "0", rejected: [] },
      count: 1,
      gasTgas: 3,
    });
    assert.equal(calls[0]!.methodName, "settle_batch");
    assert.deepEqual(calls[0]!.args, { ious: [s] });
    assert.deepEqual((await get(base, "/ledger")).body, {
      solver: "s.testnet",
      carrying: 0,
      oldest_ms: 0,
      exposure: [],
    });
  });
});

test("guarantor and arena routes are delegated in that order; unknown paths are 404", async () => {
  const seen: string[] = [];
  await serve(
    {
      guarantor: {
        route: async (m, u) => {
          seen.push(`g ${m} ${u}`);
          return u === "/guarantor" ? { code: 200, body: { g: 1 } } : null;
        },
      },
      arena: {
        route: async (m, u, _b, h) => {
          seen.push(`a ${m} ${u} ${h["x-arena-key"]}`);
          return u === "/arena" ? { code: 200, body: { a: 1 } } : null;
        },
      },
    },
    async (base) => {
      assert.deepEqual(await get(base, "/guarantor"), { status: 200, type: "application/json", body: { g: 1 } });
      const a = await fetch(`${base}/arena`, { headers: { "x-arena-key": "k" } });
      assert.deepEqual(await a.json(), { a: 1 });
      const nf = await get(base, "/nope");
      assert.equal(nf.status, 404);
      assert.deepEqual(nf.body, { error: "not found" });
      assert.deepEqual(seen, [
        "g GET /guarantor",
        "g GET /arena",
        "a GET /arena k",
        "g GET /nope",
        "a GET /nope undefined",
      ]);
    },
  );
});

test("arena auth gate: a missing or wrong x-arena-key is 401 and the chain is never called", async () => {
  const calls: Call[] = [];
  const arena = new Arena(fakeAccount(calls).account, "s.testnet");
  await serve({ arena }, async (base) => {
    const body = { a: "A", b: "B", symbol: "wrap.near", close_at: "1" };
    for (const headers of [{}, { "x-arena-key": `${ARENA_SECRET}x` }, { "x-arena-key": "" }]) {
      const r = await post(base, "/duel", body, headers);
      assert.equal(r.status, 401);
      assert.deepEqual(r.body, { error: "x-arena-key required" });
    }
    const g = await get(base, "/duel");
    assert.equal(g.status, 405);
    const c = await post(base, "/consume", { target: "A", duel_id: "1", blocks: [] }, { "x-arena-key": ARENA_SECRET });
    assert.deepEqual(c, { status: 200, body: { ok: true } });
  });
  assert.equal(calls.length, 0);
});

test("error mapping: a body that is not JSON is 400, a failing route is 500 with the message", async () => {
  await serve(
    {
      guarantor: {
        route: async (_m, u) => {
          if (u === "/pull") throw new Error("rpc down");
          return null;
        },
      },
    },
    async (base) => {
      const bad = await post(base, "/verify", "{not json");
      assert.equal(bad.status, 400);
      assert.match((bad.body as { error: string }).error, /JSON/);
      const boom = await post(base, "/pull", {});
      assert.deepEqual(boom, { status: 500, body: { error: "rpc down" } });
    },
  );
});
