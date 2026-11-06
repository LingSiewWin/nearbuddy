// The follow mandate both the drawer and the MCP tool hand out: units, the price floor deploy 15 requires, and the
// contract's own floor check (amount_out * 10^24 >= amount_in * min_out_per_near) on a fill at the quoted price.
// Run: `cd web && bun test app/__tests__/follow.test.ts`.
import { expect, test } from "bun:test";
import { followArgs, priceFloor, USDC, yocto } from "../lib/follow";

test("yocto: exact to 4 decimals", () => {
  expect(yocto(0.2)).toBe("200000000000000000000000");
  expect(yocto(1)).toBe("1000000000000000000000000");
  expect(yocto(0.1234)).toBe("123400000000000000000000");
});

test("priceFloor: 95% of the price in USDC units per NEAR, never 0", () => {
  expect(priceFloor(3.7127)).toBe("3527065");
  expect(priceFloor(0)).toBe("1");
  expect(priceFloor(2, 1)).toBe("2000000");
});

test("a fill at today's price clears the floor; one 6% under it does not", () => {
  const price = 3.7127;
  const floor = BigInt(priceFloor(price));
  const amountIn = BigInt(yocto(0.2));
  const clears = (usdcOut: bigint) => usdcOut * 10n ** 24n >= amountIn * floor; // follow.rs, settle check
  expect(clears(BigInt(Math.floor(0.2 * price * 1e6)))).toBe(true);
  expect(clears(BigInt(Math.floor(0.2 * price * 0.94 * 1e6)))).toBe(false);
});

test("followArgs: USDC fills, the floor, an expiry in ns, and a placeholder only when no price", () => {
  const now = Date.UTC(2026, 10, 7);
  const a = followArgs("pk=", { capNear: 0.2, allowanceNear: 1, days: 7, floor: "3527065", now });
  expect(a.mandate).toEqual({
    per_tx_cap: "200000000000000000000000",
    allowance: "1000000000000000000000000",
    spent: "0",
    allowed_tokens: [USDC],
    expires_at: String(BigInt(now + 7 * 86_400_000) * 1_000_000n),
    revoked: false,
    min_out_per_near: "3527065",
  });
  expect(
    followArgs("pk=", { capNear: 0.2, allowanceNear: 1, days: 7, floor: null, now }).mandate.min_out_per_near,
  ).toBe("<USDC units per NEAR>");
});
