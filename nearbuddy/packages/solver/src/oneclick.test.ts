import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type Quote, quote, sellNearForUsdc, sellNearForUsdcOnChain, USDC_NEAR, WNEAR } from "./oneclick.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/oneclick-quote.json", import.meta.url), "utf8")) as Quote;

test("fixture replay parses the fields the arena uses", async () => {
  let sent: unknown;
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(fixture), { status: 200 });
  }) as unknown as typeof fetch;
  const q = await quote(sellNearForUsdc(10n ** 24n, "nearbuddy-solver.near"), fetchFn);
  assert.equal((sent as { dry: boolean }).dry, true);
  assert.equal((sent as { originAsset: string }).originAsset, WNEAR);
  assert.equal((sent as { destinationAsset: string }).destinationAsset, USDC_NEAR);
  assert.equal(q.quote.amountIn, "1000000000000000000000000");
  assert.equal(q.quote.amountOut, "3744739");
  assert.ok(BigInt(q.quote.minAmountOut) < BigInt(q.quote.amountOut));
  assert.equal(q.quote.depositAddress, undefined); // dry
});

test("non-2xx surfaces the status", async () => {
  const fetchFn = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(quote(sellNearForUsdc(1n, "x.near"), fetchFn), /1click quote 400/);
});

test("on-chain request is non-dry with origin-chain deposit and destination-chain recipient", () => {
  const r = sellNearForUsdcOnChain(5n * 10n ** 23n, "someone.near");
  assert.equal(r.dry, false);
  assert.equal(r.depositType, "ORIGIN_CHAIN");
  assert.equal(r.recipientType, "DESTINATION_CHAIN");
  assert.equal(r.amount, "500000000000000000000000");
});

test("executeSwap sends one wrap.near transaction with storage, wrap and transfer batched", async () => {
  const { executeSwap } = await import("./oneclick.ts");
  const dep = "8c66deadbeef".padEnd(64, "0");
  const real = globalThis.fetch;
  let statusCalls = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/v0/quote")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.dry, false);
      return new Response(
        JSON.stringify({
          ...fixture,
          quote: { ...fixture.quote, depositAddress: dep, deadline: "2099-01-01T00:00:00Z" },
        }),
      );
    }
    if (u.endsWith("/v0/deposit/submit")) return new Response(JSON.stringify({ status: "KNOWN_DEPOSIT_TX" }));
    if (u.includes("/v0/status"))
      return new Response(
        JSON.stringify(
          ++statusCalls < 2 ? { status: "PROCESSING" } : { status: "SUCCESS", swapDetails: { amountOut: "1864135" } },
        ),
      );
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  const sent: { receiverId: string; actions: unknown[] }[] = [];
  const account = {
    accountId: "someone.near",
    provider: { callFunction: async () => null }, // not yet registered on wrap.near
    signAndSendTransaction: async (p: { receiverId: string; actions: unknown[] }) => {
      sent.push(p);
      return { transaction: { hash: "TX1" } };
    },
  } as unknown as Parameters<typeof executeSwap>[0];
  try {
    const r = await executeSwap(account, 5n * 10n ** 23n);
    assert.equal(sent.length, 1, "one transaction, not four");
    assert.equal(sent[0]!.receiverId, "wrap.near");
    const methods = sent[0]!.actions.map(
      (a) => (a as { functionCall: { methodName: string } }).functionCall.methodName,
    );
    assert.deepEqual(methods, ["storage_deposit", "storage_deposit", "near_deposit", "ft_transfer"]);
    const xfer = (sent[0]!.actions[3] as { functionCall: { args: Uint8Array } }).functionCall.args;
    assert.deepEqual(JSON.parse(new TextDecoder().decode(xfer)), {
      receiver_id: dep,
      amount: "500000000000000000000000",
    });
    assert.equal(r.status, "SUCCESS");
    assert.equal(r.amountOut, "1864135");
    assert.equal(r.depositTx, "TX1");
    assert.ok(r.legs.deposit_ms >= 0 && r.legs.fill_ms >= 2000);
  } finally {
    globalThis.fetch = real;
  }
});

/** 1Click fake for `executeSwap`: a non-dry quote with a deposit address, then the given status sequence. */
function fakeOneClick(dep: string, statuses: string[]) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/v0/quote"))
      return new Response(
        JSON.stringify({
          ...fixture,
          quote: { ...fixture.quote, depositAddress: dep, deadline: "2099-01-01T00:00:00Z" },
        }),
      );
    if (u.endsWith("/v0/deposit/submit")) return new Response(JSON.stringify({ status: "KNOWN_DEPOSIT_TX" }));
    if (u.includes("/v0/status"))
      return new Response(JSON.stringify({ status: statuses.length > 1 ? statuses.shift() : statuses[0] }));
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

test("executeSwap skips the sender's storage_deposit when wrap.near already knows the account", async () => {
  const { executeSwap } = await import("./oneclick.ts");
  const dep = "8c66cafe".padEnd(64, "0");
  const restore = fakeOneClick(dep, ["SUCCESS"]);
  const sent: { actions: unknown[] }[] = [];
  const account = {
    accountId: "someone.near",
    provider: { callFunction: async () => ({ total: "1250000000000000000000", available: "0" }) }, // registered
    signAndSendTransaction: async (p: { actions: unknown[] }) => {
      sent.push(p);
      return { transaction: { hash: "TX2" } };
    },
  } as unknown as Parameters<typeof executeSwap>[0];
  try {
    const r = await executeSwap(account, 10n ** 23n);
    const methods = sent[0]!.actions.map(
      (a) => (a as { functionCall: { methodName: string } }).functionCall.methodName,
    );
    assert.deepEqual(methods, ["storage_deposit", "near_deposit", "ft_transfer"]);
    const storage = (sent[0]!.actions[0] as { functionCall: { args: Uint8Array } }).functionCall.args;
    assert.deepEqual(
      JSON.parse(new TextDecoder().decode(storage)),
      { account_id: dep },
      "the one storage_deposit is for the deposit address",
    );
    assert.equal(r.status, "SUCCESS");
    assert.equal(r.amountOut, undefined, "no swapDetails in the status reply");
  } finally {
    restore();
  }
});

test("executeSwap throws on a final non-SUCCESS status and names the deposit tx", async () => {
  const { executeSwap } = await import("./oneclick.ts");
  const restore = fakeOneClick("8c66dead".padEnd(64, "0"), ["REFUNDED"]);
  const account = {
    accountId: "someone.near",
    provider: { callFunction: async () => null },
    signAndSendTransaction: async () => ({ transaction: { hash: "TX3" } }),
  } as unknown as Parameters<typeof executeSwap>[0];
  try {
    await assert.rejects(executeSwap(account, 10n ** 23n), /swap ended REFUNDED \(deposit tx TX3\)/);
  } finally {
    restore();
  }
});

test("executeSwap refuses a quote without a deposit address before sending anything", async () => {
  const { executeSwap } = await import("./oneclick.ts");
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(fixture))) as typeof fetch; // dry fixture: no depositAddress
  let sent = 0;
  const account = {
    accountId: "someone.near",
    provider: { callFunction: async () => null },
    signAndSendTransaction: async () => {
      sent++;
      return { transaction: { hash: "TX4" } };
    },
  } as unknown as Parameters<typeof executeSwap>[0];
  try {
    await assert.rejects(executeSwap(account, 1n), /no depositAddress/);
    assert.equal(sent, 0);
  } finally {
    globalThis.fetch = real;
  }
});
