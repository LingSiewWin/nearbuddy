import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NearAi } from "../../keeper/src/nearai.ts";
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

function fixture(decision: object, o: { price?: bigint; held?: bigint; payError?: Error } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "order-test-"));
  const { ai, calls } = fakeAi(decision);
  let held = o.held ?? 0n;
  const seen = { invoices: 0, swaps: [] as bigint[], paid: 0, opened: 0, signers: [] as boolean[] };
  const price = o.price ?? 1_310_000n;
  const rail: Rail = {
    name: "fake",
    open: async () => void seen.opened++,
    search: async () => candidates,
    invoice: async (): Promise<RailInvoice> => {
      seen.invoices++;
      return { rail: "fake", id: "inv-1", priceUsdc: price };
    },
    pay: async () => {
      seen.paid++;
      if (o.payError) throw o.payError;
      return "0xBASETX";
    },
    wait: async (): Promise<Delivery> => ({ status: "complete", delivered: true, secret: SECRET }),
  };
  const deps: OrderDeps = {
    ai,
    model: MODEL,
    rails: [rail],
    gate: "gate.testnet",
    owner: "owner.testnet",
    payer: PAYER,
    signer: (d, log) => {
      seen.signers.push(d !== undefined);
      log(d ? "paygate sign_payment: NEAR tx PAYTX (3 ms)" : "paygate sign_login: NEAR tx LOGINTX (3 ms)");
      return { address: PAYER } as unknown as Payer;
    },
    balance: async () => held,
    swap: async (out) => {
      seen.swaps.push(out);
      held += out;
      return { depositTx: "DEPOSITTX" };
    },
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
  const { deps } = fixture(BUY, { payError });
  const r = await placeOrder("a KFC voucher", deps);
  assert.equal(r.status, "refused");
  assert.equal(r.near.payment, "REFUSEDTX");
  assert.match(r.reason ?? "", /policy: over the cap/);
  assert.equal(r.baseTx, undefined);
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
