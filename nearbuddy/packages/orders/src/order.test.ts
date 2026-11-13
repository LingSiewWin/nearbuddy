import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NearAi } from "../../keeper/src/nearai.ts";
import type { Account as GateAccount, Policy } from "../../protocol/src/abi/paygate.ts";
import type { Payer } from "../../solver/src/bitrefill.ts";
import { GateRefused } from "../../solver/src/paygate.ts";
import { type OrderDeps, placeOrder } from "./order.ts";
import type { Candidate, Delivery, Rail, RailInvoice } from "./rail.ts";

const MODEL = "test-model";
const PAYER = "0x00000000000000000000000000000000000000aa" as const;
const SECRET = { status: "complete", redemption_info: { code: "VOUCHER-CODE-12345", pin: "9876" } };
const enc = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const reply = (content: object) =>
  enc(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));

const candidates: Candidate[] = [
  { productId: "kfc-my", name: "KFC MY", country: "MY", packages: [{ value: "5", currency: "MYR", priceUsd: "1.31" }] },
];
const BUY = { action: "buy", product_id: "kfc-my", package_value: "5", max_price_usdc: "1.35" };

/** Answers the search request, then the decision request; signs every exchange with a local enclave key. */
function fakeAi(decision: object) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let last: { request: Uint8Array; response: Uint8Array } | undefined;
  const calls: string[] = [];
  const ai = {
    complete: async (request: Uint8Array) => {
      const search = new TextDecoder().decode(request).includes("gift card search");
      calls.push(search ? "search" : "decide");
      const response = search ? reply({ query: "KFC", country: "MY" }) : reply(decision);
      last = { request, response };
      return { chatId: "chat", response, usage: { prompt_tokens: 0, completion_tokens: 0 } };
    },
    signature: async () => {
      const text = `${MODEL}:${sha(last!.request)}:${sha(last!.response)}`;
      return {
        text,
        signature: sign(null, enc(text), privateKey).toString("hex"),
        signing_address: Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url").toString("hex"),
        signing_algo: "ed25519",
        signature_kind: "provider_tee",
      };
    },
  } as unknown as NearAi;
  return { ai, calls };
}

const POLICY: Policy = {
  agent: "agent.testnet",
  allowance: "3000000",
  allowed_payees: [],
  expires_at: "4102444800",
  login_domains: [],
  models: [MODEL],
  per_payment_cap: "1500000",
};
const NOW = 1_800_000_000;
const account = (policy: Partial<Policy> | null = {}): GateAccount => ({
  payer: PAYER,
  policy: policy && { ...POLICY, ...policy },
  storage_balance: "1000000000000000000000",
});

/** What the fake signer offers; the real `Payer` type hides it behind the x402 scheme. */
type Signing = { signMessage(a: { message: string }): Promise<unknown>; signTypedData(a: object): Promise<unknown> };

/** @x402/fetch catches the signer's error and throws a new one with only the text (no cause). */
async function viaLibrary(f: () => Promise<unknown>): Promise<void> {
  try {
    await f();
  } catch (e) {
    throw new Error(`Failed to create payment payload: ${(e as Error).message}`);
  }
}

function fixture(
  decision: object,
  o: {
    price?: bigint;
    held?: bigint;
    payError?: Error;
    account?: GateAccount | null;
    used?: boolean;
    swapFunds?: boolean;
    /** The swap throws after it sent its deposit. */
    swapError?: Error;
    wait?: () => Promise<Delivery>;
    /** The contract refuses this signature. The fake rail then wraps the error the way the payment library does. */
    refuse?: { method: "sign_payment" | "sign_login"; reason: string; tx: string };
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "order-test-"));
  const { ai, calls } = fakeAi(decision);
  let held = o.held ?? 0n;
  const seen = { invoices: 0, swaps: [] as bigint[], paid: 0, opened: 0, signers: [] as boolean[] };
  const price = o.price ?? 1_310_000n;
  const rail: Rail = {
    name: "fake",
    open: async (payer) => {
      seen.opened++;
      await viaLibrary(() => (payer as unknown as Signing).signMessage({ message: "login" }));
    },
    search: async () => candidates,
    invoice: async (): Promise<RailInvoice> => {
      seen.invoices++;
      return { rail: "fake", id: "inv-1", priceUsdc: price };
    },
    pay: async (payer) => {
      seen.paid++;
      await viaLibrary(() => (payer as unknown as Signing).signTypedData({}));
      if (o.payError) throw o.payError;
      return "0xBASETX";
    },
    wait: o.wait ?? (async (): Promise<Delivery> => ({ status: "complete", delivered: true, secret: SECRET })),
  };
  const deps: OrderDeps = {
    ai,
    model: MODEL,
    rails: [rail],
    gate: "gate.testnet",
    agentId: "agent.testnet",
    owner: "owner.testnet",
    payer: PAYER,
    signer: (d, onTx, onRefused) => {
      seen.signers.push(d !== undefined);
      const method = d ? "sign_payment" : "sign_login";
      const refuse = o.refuse?.method === method ? o.refuse : undefined;
      if (!refuse) onTx(method, d ? "PAYTX" : "LOGINTX");
      const sign = async () => {
        if (!refuse) return "0xsig";
        onRefused(method, refuse.tx, refuse.reason);
        throw new GateRefused(refuse.reason, refuse.tx);
      };
      return { address: PAYER, signMessage: sign, signTypedData: sign } as unknown as Payer;
    },
    balance: async () => held,
    swap: async (out, onDeposit) => {
      seen.swaps.push(out);
      onDeposit("DEPOSITTX");
      if (o.swapError) throw o.swapError;
      if (o.swapFunds !== false) held += out;
      return { depositTx: "DEPOSITTX" };
    },
    gateView: {
      account: async () => (o.account === undefined ? account() : o.account),
      isDecisionUsed: async () => o.used ?? false,
    },
    nowSec: () => NOW,
    secretsDir: join(dir, ".secrets"),
    ordersDir: join(dir, ".orders"),
    pollMs: 0,
  };
  return { deps, seen, calls, dir };
}

test("a buy decision ends delivered with every hash on the receipt", async () => {
  const { deps, seen, dir } = fixture(BUY);
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "delivered");
  assert.deepEqual(r.near, { login: "LOGINTX", deposit: "DEPOSITTX", payment: "PAYTX" });
  assert.equal(r.baseTx, "0xBASETX");
  assert.equal(r.invoiceId, "inv-1");
  assert.equal(r.priceUsdc, "1310000");
  assert.deepEqual(r.decision, { action: "buy", productId: "kfc-my", packageValue: "5", maxPriceUsdc: "1350000" });
  assert.equal(r.proof.kind, 2);
  assert.ok(r.request_b64 && r.response_b64);
  for (const k of ["search", "decide", "invoice", "swap", "pay", "wait", "total"]) assert.ok(k in r.legsMs, k);
  assert.deepEqual(seen.signers, [false, true]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".orders", `${r.id}.json`), "utf8")), r);
});

test("a refuse decision spends nothing", async () => {
  const { deps, seen, dir } = fixture({ action: "refuse", reason: "no match" });
  const r = await placeOrder("a unicorn", deps);
  assert.equal(r.status, "refused");
  assert.equal(r.reason, "no match");
  assert.deepEqual([seen.invoices, seen.swaps.length, seen.paid], [0, 0, 0]);
  assert.ok(existsSync(join(dir, ".orders", `${r.id}.json`)));
});

test("an ask decision ends asked and spends nothing", async () => {
  const { deps, seen } = fixture({ action: "ask", question: "which size?" });
  const r = await placeOrder("a voucher", deps);
  assert.deepEqual([r.status, r.reason, seen.invoices, seen.swaps.length], ["asked", "which size?", 0, 0]);
});

test("an invoice above the model's limit is not paid", async () => {
  const { deps, seen } = fixture(BUY, { price: 1_400_000n });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "failed");
  assert.match(r.reason ?? "", /above the limit/);
  assert.deepEqual([seen.invoices, seen.swaps.length, seen.paid], [1, 0, 0]);
});

test("a limit above the listed price plus 3 percent fails before any invoice", async () => {
  const { deps, seen } = fixture({ ...BUY, max_price_usdc: "1.36" });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "failed");
  assert.match(r.reason ?? "", /limit is above the listed price/);
  assert.deepEqual([seen.invoices, seen.swaps.length, seen.paid], [0, 0, 0]);
});

test("only the shortfall is swapped", async () => {
  const { deps, seen } = fixture(BUY, { held: 90_000n });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "delivered");
  assert.deepEqual(seen.swaps, [1_220_000n]);
});

test("a payer that already holds the price swaps nothing", async () => {
  const { deps, seen } = fixture(BUY, { held: 2_000_000n });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "delivered");
  assert.equal(seen.swaps.length, 0);
  assert.equal(r.near.deposit, undefined);
});

test("a refusal by the contract is recorded with its NEAR transaction", async () => {
  // x402 wraps the signer's error: the refusal is found in the cause chain
  const payError = new Error("payment failed", { cause: new GateRefused("policy: over the cap", "REFUSEDTX") });
  const { deps, seen } = fixture(BUY, { payError });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "refused");
  assert.equal(r.near.payment, "REFUSEDTX");
  assert.match(r.reason ?? "", /policy: over the cap/);
  assert.equal(r.baseTx, undefined);
  // the views said the policy covers it, so the payer was funded before the contract refused
  assert.deepEqual(seen.swaps, [1_310_000n]);
});

test("the voucher is written under the secrets directory and is absent from the receipt", async () => {
  const { deps, dir } = fixture(BUY);
  const r = await placeOrder("a KFC voucher", deps);
  const file = join(dir, ".secrets", "order-inv-1.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), SECRET);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(join(dir, ".orders", `${r.id}.json`), "utf8");
  for (const s of ["redemption_info", "VOUCHER-CODE-12345", "9876"]) assert.ok(!text.includes(s), s);
});

test("a replay sends the recorded decision and asks the model nothing", async () => {
  const first = fixture(BUY);
  const r1 = await placeOrder("a KFC voucher", first.deps);
  const { deps, calls } = fixture({ action: "refuse", reason: "must not be asked" });
  const r2 = await placeOrder("a KFC voucher", {
    ...deps,
    replay: {
      model: r1.model,
      request: new Uint8Array(Buffer.from(r1.request_b64, "base64")),
      response: new Uint8Array(Buffer.from(r1.response_b64, "base64")),
      proof: r1.proof,
      query: "kfc-my",
      country: "MY",
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(r2.status, "delivered");
  assert.deepEqual(r2.proof, r1.proof);
});

test("a replay whose listed price has dropped still reaches the contract, a fresh order with the same numbers does not", async () => {
  // first decision: listed 1.32, limit 1.36 (the ceiling is 1.36)
  const first = fixture({ ...BUY, max_price_usdc: "1.36" });
  const at132 = [{ ...candidates[0]!, packages: [{ value: "5", currency: "MYR", priceUsd: "1.32" }] }];
  first.deps.rails[0]!.search = async () => at132;
  const r1 = await placeOrder("a KFC voucher", first.deps);
  assert.equal(r1.status, "delivered");
  // now the catalogue says 1.31: the ceiling is 1.35, below the recorded limit
  const refuse = { method: "sign_payment", reason: "this decision was already used", tx: "REFUSEDTX" } as const;
  const { deps, calls, seen } = fixture({ action: "refuse", reason: "must not be asked" }, { refuse, used: true });
  const r2 = await placeOrder("a KFC voucher", {
    ...deps,
    replay: {
      model: r1.model,
      request: new Uint8Array(Buffer.from(r1.request_b64, "base64")),
      response: new Uint8Array(Buffer.from(r1.response_b64, "base64")),
      proof: r1.proof,
      query: "kfc-my",
      country: "MY",
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(r2.status, "refused");
  assert.equal(r2.near.payment, "REFUSEDTX");
  assert.match(r2.reason ?? "", /decision was already used.*replay of a recorded decision/);
  assert.equal(seen.paid, 1);
  assert.equal(seen.swaps.length, 0);
  // the same numbers in a fresh order fail on the ceiling
  const fresh = fixture({ ...BUY, max_price_usdc: "1.36" });
  const r3 = await placeOrder("a KFC voucher", fresh.deps);
  assert.equal(r3.status, "failed");
  assert.match(r3.reason ?? "", /limit is above the listed price/);
  assert.equal(fresh.seen.invoices, 0);
});

test("a replay of a decision whose limit exceeds its own recorded price is bounded: no invoice, no swap, no payment", async () => {
  // a fresh order fails at the ceiling (limit 9.99, listed 1.31): the decision was never used, its receipt is kept
  const first = fixture({ ...BUY, max_price_usdc: "9.99" });
  const r1 = await placeOrder("a KFC voucher", first.deps);
  assert.equal(r1.status, "failed");
  // the catalogue now lists a price high enough that the fresh ceiling alone would not stop it
  const { deps, calls, seen } = fixture({ action: "refuse", reason: "must not be asked" });
  deps.rails[0]!.search = async () => [
    { ...candidates[0]!, packages: [{ value: "5", currency: "MYR", priceUsd: "9.50" }] },
  ];
  const r2 = await placeOrder("a KFC voucher", {
    ...deps,
    replay: {
      model: r1.model,
      request: new Uint8Array(Buffer.from(r1.request_b64, "base64")),
      response: new Uint8Array(Buffer.from(r1.response_b64, "base64")),
      proof: r1.proof,
      query: "kfc-my",
      country: "MY",
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(r2.status, "failed");
  assert.match(r2.reason ?? "", /limit is above the listed price/);
  assert.deepEqual([seen.invoices, seen.swaps.length, seen.paid], [0, 0, 0]);
});

test("a failure before any decision still leaves a receipt", async () => {
  const { deps } = fixture(BUY);
  deps.rails[0]!.search = async () => {
    throw new Error("rail down");
  };
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "failed");
  assert.match(r.reason ?? "", /rail down/);
  assert.ok(existsSync(join(deps.ordersDir, `${r.id}.json`)));
});

/** Each case: the views say the contract will refuse. It is still asked once, so the refusal is on chain; nothing is swapped. */
const cannotPay: [string, Parameters<typeof fixture>[1], RegExp][] = [
  [
    "price above the cap",
    { price: 1_340_000n, account: account({ per_payment_cap: "1300000" }) },
    /policy does not cover.*cap/,
  ],
  ["price above the allowance", { account: account({ allowance: "1000000" }) }, /policy does not cover.*allowance/],
  ["expired policy", { account: account({ expires_at: String(NOW) }) }, /policy does not cover.*expired/],
  ["model not in the policy", { account: account({ models: ["other-model"] }) }, /policy does not cover.*model/],
  ["decision already used", { used: true }, /decision was already used/],
  [
    "another account is the policy's agent",
    { account: account({ agent: "other.testnet" }) },
    /names agent other\.testnet/,
  ],
  ["zero storage balance", { account: { ...account(), storage_balance: "0" } }, /storage balance is zero/],
];
for (const [name, opts, reason] of cannotPay)
  test(`${name}: refused on chain, nothing swapped`, async () => {
    const refuse = { method: "sign_payment", reason: "refused by the contract", tx: "REFUSEDTX" } as const;
    const { deps, seen } = fixture(BUY, { ...opts, refuse });
    const r = await placeOrder("a KFC voucher", deps);
    assert.equal(r.status, "refused");
    assert.match(r.reason ?? "", reason);
    assert.match(r.reason ?? "", /refused by the contract/);
    assert.equal(r.near.payment, "REFUSEDTX");
    assert.equal(seen.swaps.length, 0);
    assert.equal(seen.paid, 1);
  });

for (const [name, opts, reason] of [
  ["no account", { account: null }, /no paygate account/],
  ["no policy", { account: account(null) }, /no policy/],
] as const)
  test(`${name}: refused locally, the contract is not asked`, async () => {
    const { deps, seen } = fixture(BUY, opts);
    const r = await placeOrder("a KFC voucher", deps);
    assert.equal(r.status, "refused");
    assert.match(r.reason ?? "", reason);
    assert.equal(r.near.payment, undefined);
    assert.equal(seen.swaps.length, 0);
    assert.equal(seen.paid, 0);
  });

test("a pre-check the contract disagrees with, and a payer that can pay, is a normal paid order", async () => {
  const { deps, seen } = fixture(BUY, { used: true, held: 2_000_000n });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "delivered");
  assert.equal(seen.swaps.length, 0);
  assert.equal(r.near.payment, "PAYTX");
});

test("the contract signs against the pre-check and the payer is short: failed, decision consumed, no swap", async () => {
  const { deps, seen } = fixture(BUY, {
    used: true,
    payError: new Error("insufficient funds for transfer"),
  });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "failed");
  assert.match(r.reason ?? "", /^pre-check disagreed with the contract; /);
  assert.match(r.reason ?? "", /decision and allowance were consumed without a swap/);
  assert.equal(r.near.payment, "PAYTX");
  assert.equal(r.baseTx, undefined);
  assert.equal(seen.swaps.length, 0);
});

test("a payer still short after the swap is not paid for", async () => {
  const { deps, seen } = fixture(BUY, { swapFunds: false });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "failed");
  assert.match(r.reason ?? "", /^deposited; .*swap did not fund the payer.*may still complete.*DEPOSITTX/);
  assert.equal(r.near.deposit, "DEPOSITTX");
  assert.equal(seen.paid, 0);
});

test("a swap that throws after its deposit leaves the deposit hash on the receipt", async () => {
  const { deps, seen } = fixture(BUY, { swapError: new Error("1click status unreachable") });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "failed");
  assert.equal(r.near.deposit, "DEPOSITTX");
  assert.match(
    r.reason ?? "",
    /^deposited; the swap failed \(1click status unreachable\).*may still complete.*DEPOSITTX/,
  );
  assert.equal(seen.paid, 0);
});

const FETCH = /^paid; .*voucher can be fetched from fake with invoice inv-1/;

test("a wait that throws after payment says the order was paid", async () => {
  const { deps } = fixture(BUY, {
    wait: async () => {
      throw new Error("timed out");
    },
  });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "failed");
  assert.match(r.reason ?? "", FETCH);
  assert.match(r.reason ?? "", /timed out/);
  assert.equal(r.baseTx, "0xBASETX");
});

test("a pay that throws after the contract signed says the settlement is unknown", async () => {
  const { deps, seen } = fixture(BUY, { payError: new Error("facilitator timed out") });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "failed");
  assert.match(r.reason ?? "", /^payment signed; settlement unknown; facilitator timed out.*invoice inv-1 at fake/);
  assert.equal(r.near.payment, "PAYTX");
  assert.equal(r.baseTx, undefined);
  assert.equal(seen.paid, 1);
});

test("a delivery that is not complete says the order was paid", async () => {
  const { deps } = fixture(BUY, { wait: async () => ({ status: "pending", delivered: false, secret: SECRET }) });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "failed");
  assert.match(r.reason ?? "", FETCH);
  assert.match(r.reason ?? "", /delivery ended pending/);
});

test("a voucher file that cannot be written says the order was paid", async () => {
  const { deps, dir } = fixture(BUY);
  writeFileSync(join(dir, "blocker"), "x");
  deps.secretsDir = join(dir, "blocker", ".secrets"); // a path under a file
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "failed");
  assert.match(r.reason ?? "", FETCH);
  assert.match(r.reason ?? "", /could not be written/);
});

test("the secrets directory is created private", async () => {
  const { deps, dir } = fixture(BUY);
  await placeOrder("a KFC voucher", deps);
  assert.equal(statSync(join(dir, ".secrets")).mode & 0o777, 0o700);
});

test("a receipt that cannot be written is printed and returned", async () => {
  const { deps, dir } = fixture(BUY);
  writeFileSync(join(dir, "blocker"), "x");
  deps.ordersDir = join(dir, "blocker", ".orders");
  const out: string[] = [];
  const log = console.log;
  console.log = (s: string) => void out.push(s);
  let r: Awaited<ReturnType<typeof placeOrder>>;
  try {
    r = await placeOrder("a KFC voucher", deps);
  } finally {
    console.log = log;
  }
  assert.equal(r.status, "delivered");
  assert.match(out[0] ?? "", /receipt file could not be written/);
  assert.equal(JSON.parse(out[1] ?? "").id, r.id);
  assert.ok(!out.join("").includes("VOUCHER-CODE-12345"));
});

test("a payment refusal survives the payment library dropping the error's cause", async () => {
  const refuse = {
    method: "sign_payment",
    reason: "the payment is above the per-payment cap",
    tx: "REFUSEDTX",
  } as const;
  const { deps } = fixture(BUY, { refuse });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "refused");
  assert.equal(r.near.payment, "REFUSEDTX");
  assert.equal(r.near.login, "LOGINTX");
  assert.match(r.reason ?? "", /paygate refused: the payment is above the per-payment cap \(NEAR tx REFUSEDTX\)/);
});

test("a sign-in refusal survives the payment library dropping the error's cause", async () => {
  const refuse = { method: "sign_login", reason: "domain not in the policy", tx: "LOGINREFUSEDTX" } as const;
  const { deps, seen } = fixture(BUY, { refuse });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "refused");
  assert.equal(r.near.login, "LOGINREFUSEDTX");
  assert.equal(r.near.payment, undefined);
  assert.match(r.reason ?? "", /domain not in the policy/);
  assert.deepEqual([seen.invoices, seen.swaps.length, seen.paid], [0, 0, 0]);
});
