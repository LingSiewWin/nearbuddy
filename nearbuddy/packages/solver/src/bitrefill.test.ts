import assert from "node:assert/strict";
import { test } from "node:test";
import { type PaymentOption, pickBaseUsdc, USDC_BASE_ADDRESS } from "./bitrefill.ts";

// Shaped like the `accepts` list of the 402 from POST /x402/invoice/pay; the Base entry is the one paid on 2026-11-13.
const options: PaymentOption[] = [
  {
    scheme: "exact",
    network: "eip155:42161",
    asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    amount: "1310000",
    payTo: "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A",
  },
  {
    scheme: "exact",
    network: "eip155:8453",
    asset: USDC_BASE_ADDRESS,
    amount: "1310000",
    payTo: "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A",
  },
];

test("pickBaseUsdc takes the Base USDC option at the invoice price", () => {
  assert.equal(pickBaseUsdc(options, 1_310_000n).network, "eip155:8453");
});

test("pickBaseUsdc refuses a challenge that is not exactly the invoice price", () => {
  assert.throws(() => pickBaseUsdc(options, 1_300_000n), /asks for 1310000/);
  assert.throws(() => pickBaseUsdc(options, 1_320_000n), /asks for 1310000/);
});

test("pickBaseUsdc refuses a challenge without USDC on Base", () => {
  assert.throws(() => pickBaseUsdc(options.slice(0, 1), 1_310_000n), /no exact USDC payment on Base/);
  const other = [{ ...options[1]!, asset: "0x0000000000000000000000000000000000000001" }];
  assert.throws(() => pickBaseUsdc(other, 1_310_000n), /no exact USDC payment on Base/);
});
