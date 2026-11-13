// verify_order on a hand-built receipt: a local ed25519 key plays the enclave (so the signature check runs for real)
// and the chain reads are fakes shaped like FastNEAR's tx and eth_getTransactionReceipt. Each tampering must FAIL
// the check that covers it, and only that one.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import type { Receipt } from "../packages/orders/src/receipt.ts";
import { b64, hex } from "../packages/protocol/src/index.ts";
import { teeText } from "../packages/protocol/src/intent.ts";
import type { Tx } from "./verify_duel.ts";
import { BASE_USDC, type BaseReceipt, type ChainReads, checkReceipt } from "./verify_order.ts";

const MODEL = "test-model";
const GATE = "paygate.testnet";
const PAYER = "0x1111111111111111111111111111111111111111";
const TO = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const VALUE = "1310000";
const SENTENCE = "a KFC voucher worth 5 MYR";
const sha = (s: Uint8Array | string) => new Uint8Array(createHash("sha256").update(s).digest());
const enc = (s: string) => new TextEncoder().encode(s);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const signer = b64.enc(new Uint8Array(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url")));

const request = enc(
  JSON.stringify({
    model: MODEL,
    messages: [
      { role: "system", content: "decide" },
      { role: "user", content: JSON.stringify({ sentence: SENTENCE, candidates: [] }) },
    ],
  }),
);
const reply = (o: object) => enc(JSON.stringify({ choices: [{ message: { content: JSON.stringify(o) } }] }));
const response = reply({ action: "buy", product_id: "kfc-my", package_value: "5", max_price_usdc: "1.40" });
const [reqHash, respHash] = [sha(request), sha(response)];
const proof = {
  kind: 2 as const,
  request_hash: b64.enc(reqHash),
  response_hash: b64.enc(respHash),
  signer,
  signature: b64.enc(new Uint8Array(sign(null, teeText(2, MODEL, reqHash, respHash), privateKey))),
};

const receipt: Receipt = {
  id: "r1",
  createdAt: "2026-11-13T00:00:00Z",
  sentence: SENTENCE,
  owner: "alice.testnet",
  model: MODEL,
  request_b64: b64.enc(request),
  response_b64: b64.enc(response),
  proof,
  decision: { action: "buy", productId: "kfc-my", packageValue: "5", maxPriceUsdc: "1400000" },
  rail: "bitrefill",
  invoiceId: "inv-1",
  priceUsdc: VALUE,
  payer: PAYER,
  gate: GATE,
  near: { payment: "nearTx1" },
  baseTx: "0xbase1",
  status: "delivered",
  legsMs: {},
};

const event = {
  standard: "nearbuddy-paygate",
  version: "1.0.0",
  event: "payment_signed",
  data: {
    owner: "alice.testnet",
    to: TO.toLowerCase(),
    value: VALUE,
    nonce: `0x${"00".repeat(32)}`,
    model: MODEL,
    request_hash: hex(reqHash),
    response_hash: hex(respHash),
  },
};
const args = {
  owner: "alice.testnet",
  to: TO,
  value: VALUE,
  valid_after: "0",
  valid_before: "1",
  nonce: `0x${"00".repeat(32)}`,
  model_id: MODEL,
  decision: {
    kind: 2,
    ...Object.fromEntries(
      ["request_hash", "response_hash", "signer", "signature"].map((k) => [k, proof[k as keyof typeof proof]]),
    ),
  },
};
type Status = Record<string, unknown>;
const call = (method: string, a: object, status: Status, logs: string[] = []): Tx["receipts"][number] => ({
  receipt: {
    predecessor_id: "agent.testnet",
    receiver_id: GATE,
    receipt: {
      Action: {
        signer_id: "agent.testnet",
        actions: [
          {
            FunctionCall: {
              method_name: method,
              args: Buffer.from(JSON.stringify(a)).toString("base64"),
              deposit: "0",
            },
          },
        ],
      },
    },
  },
  execution_outcome: { block_hash: "h", block_timestamp: "1", outcome: { logs, status } },
});
const nearTx = (over: { args?: object; payment?: Status; callback?: Status; logs?: string[] } = {}): Tx => ({
  transaction: { hash: "nearTx1" },
  receipts: [
    call("sign_payment", over.args ?? args, over.payment ?? { SuccessReceiptId: "x" }),
    call("on_signed", {}, over.callback ?? { SuccessValue: "" }, over.logs ?? [`EVENT_JSON:${JSON.stringify(event)}`]),
  ],
});
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const baseRc = (value = BigInt(VALUE), status = "0x1"): BaseReceipt => ({
  status,
  logs: [
    {
      address: BASE_USDC,
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad(PAYER), pad(TO)],
      data: `0x${value.toString(16).padStart(64, "0")}`,
    },
  ],
});
const chain = (tx = nearTx(), rc: BaseReceipt | null = baseRc()): ChainReads => ({
  nearTx: async () => tx,
  baseReceipt: async () => rc,
});

/** Names of the checks that failed. */
const failed = async (r: Receipt, c: ChainReads = chain()) =>
  (await checkReceipt(r, c)).filter((l) => !l.ok).map((l) => l.line.split(/\s+/)[1]);

test("an untouched receipt passes every check", async () => {
  const lines = await checkReceipt(receipt, chain());
  assert.deepEqual(
    lines.filter((l) => !l.ok),
    [],
  );
  assert.deepEqual(
    lines.map((l) => l.line.split(/\s+/)[1]),
    [
      "hashes",
      "enclave-signature",
      "decision",
      "sentence",
      "near-payment-tx",
      "near-payment-args",
      "near-payment-event",
      "amount",
      "base-transfer",
    ],
  );
  assert.ok(lines.every((l) => l.line.startsWith("PASS")));
});

test("a changed sentence fails the sentence check", async () => {
  assert.deepEqual(await failed({ ...receipt, sentence: "a 500 MYR voucher" }), ["sentence"]);
});

test("a changed response fails the hash check", async () => {
  const forged = reply({ action: "buy", product_id: "kfc-my", package_value: "5", max_price_usdc: "9.00" });
  const f = await failed({ ...receipt, response_b64: b64.enc(forged) });
  assert.ok(f.includes("hashes") && f.includes("decision"), f.join());
});

test("a decision the response does not say fails the decision check", async () => {
  const d = { ...receipt.decision, maxPriceUsdc: "9000000" } as Receipt["decision"];
  assert.deepEqual(await failed({ ...receipt, decision: d, priceUsdc: VALUE }), ["decision"]);
});

test("a signature from another key, or another model, fails", async () => {
  assert.deepEqual(await failed({ ...receipt, model: "other-model" }), [
    "enclave-signature",
    "near-payment-args",
    "near-payment-event",
  ]);
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x as string;
  const p = { ...proof, signer: b64.enc(new Uint8Array(Buffer.from(other, "base64url"))) };
  assert.ok((await failed({ ...receipt, proof: p })).includes("enclave-signature"));
});

test("a Base transfer of another amount fails only the Base check", async () => {
  assert.deepEqual(await failed(receipt, chain(nearTx(), baseRc(1_000n))), ["base-transfer"]);
});

test("a failed Base tx, or a missing one, fails", async () => {
  assert.deepEqual(await failed(receipt, chain(nearTx(), baseRc(BigInt(VALUE), "0x0"))), ["base-transfer"]);
  assert.deepEqual(await failed(receipt, chain(nearTx(), null)), ["base-transfer"]);
});

test("a transfer from another payer fails", async () => {
  assert.deepEqual(await failed({ ...receipt, payer: "0x2222222222222222222222222222222222222222" }), [
    "base-transfer",
  ]);
});

test("a sign_payment whose own receipt failed fails, whatever the tx says", async () => {
  const tx = nearTx({ payment: { Failure: { ActionError: {} } } });
  assert.ok((await failed(receipt, chain(tx))).includes("near-payment-tx"));
});

test("no payment_signed event fails (the MPC network did not sign)", async () => {
  assert.deepEqual(await failed(receipt, chain(nearTx({ logs: ["the MPC network did not sign"] }))), [
    "near-payment-event",
  ]);
});

test("an event inside a failed callback receipt does not count", async () => {
  assert.deepEqual(await failed(receipt, chain(nearTx({ callback: { Failure: {} } }))), ["near-payment-event"]);
});

test("arguments with other hashes fail the argument check", async () => {
  const a = { ...args, decision: { ...args.decision, response_hash: b64.enc(sha("other")) } };
  assert.ok((await failed(receipt, chain(nearTx({ args: a })))).includes("near-payment-args"));
});

test("a value that is not priceUsdc, or is above the limit, fails the amount check", async () => {
  assert.deepEqual(await failed({ ...receipt, priceUsdc: "1" }), ["amount"]);
  const over = { ...receipt.decision, maxPriceUsdc: "1000000" } as Receipt["decision"];
  const lowReply = reply({ action: "buy", product_id: "kfc-my", package_value: "5", max_price_usdc: "1.00" });
  const h = sha(lowReply);
  const p = {
    ...proof,
    response_hash: b64.enc(h),
    signature: b64.enc(new Uint8Array(sign(null, teeText(2, MODEL, reqHash, h), privateKey))),
  };
  const r = { ...receipt, decision: over, response_b64: b64.enc(lowReply), proof: p };
  const tx = nearTx({
    args: { ...args, decision: { ...args.decision, response_hash: p.response_hash, signature: p.signature } },
    logs: [`EVENT_JSON:${JSON.stringify({ ...event, data: { ...event.data, response_hash: hex(h) } })}`],
  });
  assert.deepEqual(await failed(r, chain(tx)), ["amount"]);
});

test("a delivered receipt without a NEAR payment fails; a refusal has nothing to pay", async () => {
  assert.deepEqual(await failed({ ...receipt, near: {} }), ["near-payment"]);
  const refuse = reply({ action: "refuse", reason: "no match" });
  const h = sha(refuse);
  const p = {
    ...proof,
    response_hash: b64.enc(h),
    signature: b64.enc(new Uint8Array(sign(null, teeText(2, MODEL, reqHash, h), privateKey))),
  };
  const r: Receipt = {
    ...receipt,
    decision: { action: "refuse", reason: "no match" },
    response_b64: b64.enc(refuse),
    proof: p,
    near: {},
    status: "refused",
  };
  const lines = await checkReceipt(r, chain());
  assert.deepEqual(
    lines.filter((l) => !l.ok),
    [],
  );
  assert.ok(lines.some((l) => l.line.startsWith("SKIP")));
});

test("a malformed receipt fails instead of throwing", async () => {
  const f = await failed({ ...receipt, request_b64: "not base64!", proof: { ...proof, signer: "x" } });
  assert.ok(f.includes("hashes") && f.includes("enclave-signature") && f.includes("sentence"));
});
