// Property check for the reservation ledger: seeded random reserve/release/sweep storms across
// several wallets and cards; the invariant must hold after every single operation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, type Observed } from "./ledger.ts";

function rng(seed: number) { // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test("sum of open reservations never exceeds min(allowance, balance)", () => {
  for (const seed of [1, 2, 3, 42, 1337]) {
    const rand = rng(seed);
    const L = new Ledger();
    const wallets = ["0xA", "0xB", "0xC"];
    const obs = new Map<string, Observed>(wallets.map((w) => [w, { balance: BigInt(Math.floor(rand() * 1000)), allowance: BigInt(Math.floor(rand() * 1000)) }]));
    const ids: string[] = [];
    let now = 0;
    for (let i = 0; i < 5000; i++) {
      const op = rand();
      if (op < 0.6) {
        const w = wallets[Math.floor(rand() * wallets.length)]!;
        const r = L.reserve(`r${i}`, w, BigInt(1 + Math.floor(rand() * 300)), obs.get(w)!, now, 1 + Math.floor(rand() * 50));
        if (typeof r !== "string") ids.push(r.id);
      } else if (op < 0.85 && ids.length) {
        L.release(ids.splice(Math.floor(rand() * ids.length), 1)[0]!);
      } else {
        now += Math.floor(rand() * 20);
        L.sweep(now);
      }
      for (const w of wallets) {
        const o = obs.get(w)!;
        const cap = o.balance < o.allowance ? o.balance : o.allowance;
        assert.ok(L.reserved(w) <= cap, `seed ${seed} step ${i}: ${w} reserved ${L.reserved(w)} > cap ${cap}`);
        assert.ok(L.reserved(w) >= 0n);
      }
    }
  }
});

test("concurrent swipes on one wallet queue instead of overbooking", () => {
  const L = new Ledger();
  const obs: Observed = { balance: 100n, allowance: 1_000n }; // balance is the binding cap
  const a = L.reserve("card1", "0xW", 60n, obs, 0, 1000);
  const b = L.reserve("card2", "0xW", 60n, obs, 0, 1000);   // would make 120 > 100
  const c = L.reserve("card3", "0xW", 40n, obs, 0, 1000);   // exactly fills
  assert.notEqual(typeof a, "string");
  assert.equal(typeof b, "string");
  assert.notEqual(typeof c, "string");
  assert.equal(L.reserved("0xw"), 100n);
  assert.ok(L.release("card1"));
  assert.notEqual(typeof L.reserve("card2b", "0xW", 60n, obs, 0, 1000), "string");
  assert.equal(L.reserve("dup", "0xW", 1n, obs, 0, 1000), "would exceed min(allowance, balance): 100 + 1 > 100");
});
