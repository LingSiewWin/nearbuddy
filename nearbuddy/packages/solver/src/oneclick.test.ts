import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { quote, sellNearForUsdc, USDC_NEAR, WNEAR, type Quote } from "./oneclick.ts";

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
