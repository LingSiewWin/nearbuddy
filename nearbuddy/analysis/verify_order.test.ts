// verify_order on a hand-built receipt: a local ed25519 key plays the enclave (so the signature check runs for real)
// and the chain reads are fakes shaped like FastNEAR's tx, the gate's get_account and eth_getTransactionReceipt.
// Each tampering must FAIL the check that covers it. The legitimate receipts the order flow writes (delivered, refused
// by the model, refused by the contract, asked, failed after and before a decision) must not FAIL.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import type { Receipt } from "../packages/orders/src/receipt.ts";
import { b64, hex } from "../packages/protocol/src/index.ts";
import { teeText } from "../packages/protocol/src/intent.ts";
import type { Tx } from "./verify_duel.ts";
import {
  AUTHORIZATION_USED,
  BASE_USDC,
  type BaseReceipt,
  type ChainReads,
  checkReceipt,
  footer,
} from "./verify_order.ts";

const MODEL = "test-model";
const GATE = "paygate.testnet";
const EVIL = "evil-gate.testnet";
const PAYER = "0x1111111111111111111111111111111111111111";
const TO = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const OTHER_TO = "0x3333333333333333333333333333333333333333";
const NONCE = `0x${"0a".repeat(32)}`;
const VALUE = "1310000";
const SENTENCE = "a KFC voucher worth 5 MYR";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const sha = (s: Uint8Array | string) => new Uint8Array(createHash("sha256").update(s).digest());
const enc = (s: string) => new TextEncoder().encode(s);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const signer = b64.enc(new Uint8Array(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url")));

const chat = (messages: object[]) => enc(JSON.stringify({ model: MODEL, messages }));
const CANDIDATES = [
  { product_id: "kfc-my", country: "MY", packages: [{ value: "5", currency: "MYR", price_usd: "1.31" }] },
];
const userMsg = (sentence = SENTENCE) => ({
  role: "user",
  content: JSON.stringify({ sentence, candidates: CANDIDATES }),
});
const request = chat([{ role: "system", content: "decide" }, userMsg()]);
const reply = (content: string | object) =>
  enc(
    JSON.stringify({
      choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    }),
  );
const BUY = { action: "buy", product_id: "kfc-my", package_value: "5", max_price_usdc: "1.40" };
const proofFor = (req: Uint8Array, resp: Uint8Array, model = MODEL) => {
  const [a, b] = [sha(req), sha(resp)];
  return {
    kind: 2 as const,
    request_hash: b64.enc(a),
    response_hash: b64.enc(b),
    signer,
    signature: b64.enc(new Uint8Array(sign(null, teeText(2, model, a, b), privateKey))),
  };
};
const response = reply(BUY);
const proof = proofFor(request, response);

const buyDecision = { action: "buy", productId: "kfc-my", packageValue: "5", maxPriceUsdc: "1400000" } as const;
const base: Receipt = {
  id: "r1",
  createdAt: "2026-11-13T00:00:00Z",
  sentence: SENTENCE,
  owner: "alice.testnet",
  model: MODEL,
  request_b64: b64.enc(request),
  response_b64: b64.enc(response),
  proof,
  decision: buyDecision,
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
/** The same receipt with another signed model response and decision. */
function answered(content: string | object, decision: Receipt["decision"], over: Partial<Receipt> = {}): Receipt {
  const resp = reply(content);
  return { ...base, response_b64: b64.enc(resp), proof: proofFor(request, resp), decision, ...over };
}

const eventOf = (data: object = {}) => ({
  standard: "nearbuddy-paygate",
  version: "1.0.0",
  event: "payment_signed",
  data: {
    owner: "alice.testnet",
    to: TO.toLowerCase(),
    value: VALUE,
    nonce: NONCE,
    model: MODEL,
    request_hash: hex(sha(request)),
    response_hash: hex(sha(response)),
    ...data,
  },
});
const argsOf = (over: object = {}) => ({
  owner: "alice.testnet",
  to: TO,
  value: VALUE,
  valid_after: "0",
  valid_before: "1",
  nonce: NONCE,
  model_id: MODEL,
  decision: {
    kind: 2,
    request_hash: proof.request_hash,
    response_hash: proof.response_hash,
    signer: proof.signer,
    signature: proof.signature,
  },
  ...over,
});
type Status = Record<string, unknown>;
const call = (
  gate: string,
  pred: string,
  method: string,
  a: object,
  status: Status,
  logs: string[] = [],
): Tx["receipts"][number] => ({
  receipt: {
    predecessor_id: pred,
    receiver_id: gate,
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
interface TxOpts {
  gate?: string;
  args?: object;
  payment?: Status;
  callback?: Status;
  logs?: string[]; // the callback's logs
  cbEvent?: string | null; // the `event` argument of the callback
  extra?: Tx["receipts"];
}
const nearTx = (o: TxOpts = {}): Tx => {
  const gate = o.gate ?? GATE;
  const logs = o.logs ?? [`EVENT_JSON:${JSON.stringify(eventOf())}`];
  return {
    transaction: { hash: "nearTx1" },
    // the tx-level status says success whatever the receipts did, as FastNEAR does
    ...{ status: { SuccessValue: "" } },
    receipts: [
      call(gate, "agent.testnet", "sign_payment", o.args ?? argsOf(), o.payment ?? { SuccessReceiptId: "x" }),
      call(
        gate,
        gate,
        "on_signed",
        { event: o.cbEvent === undefined ? (logs[0] ?? null) : o.cbEvent },
        o.callback ?? { SuccessValue: "" },
        logs,
      ),
      ...(o.extra ?? []),
    ],
  } as Tx;
};
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const baseRc = (
  o: { value?: bigint; status?: string; to?: string; token?: string; nonce?: string; auth?: boolean } = {},
): BaseReceipt => ({
  status: o.status ?? "0x1",
  logs: [
    ...(o.auth === false
      ? []
      : [{ address: BASE_USDC, topics: [AUTHORIZATION_USED, pad(PAYER), o.nonce ?? NONCE], data: "0x" }]),
    {
      address: o.token ?? BASE_USDC,
      topics: [TRANSFER, pad(PAYER), pad(o.to ?? TO)],
      data: `0x${(o.value ?? BigInt(VALUE)).toString(16).padStart(64, "0")}`,
    },
  ],
});
/** `used`: what the gate says of the decision; `auth`: what USDC says of the authorization; "throw": the read fails. */
interface World {
  used?: boolean | "throw";
  auth?: boolean | "throw";
}
const chain = (
  tx: Tx = nearTx(),
  rc: BaseReceipt | null = baseRc(),
  payer: string | null = PAYER,
  w: World = {},
): ChainReads => ({
  nearTx: async () => tx,
  gateAccount: async (_g, owner) => (owner === "alice.testnet" && payer ? { payer } : null),
  baseReceipt: async () => rc,
  decisionUsed: async () => {
    if (w.used === "throw") throw new Error("rpc down");
    return w.used ?? true;
  },
  authorizationUsed: async () => {
    if (w.auth === "throw") throw new Error("rpc down");
    return w.auth ?? true;
  },
});

const lines = (r: Receipt, c: ChainReads = chain(), gate = GATE) => checkReceipt(r, c, gate);
const failed = async (r: Receipt, c: ChainReads = chain(), gate = GATE) =>
  (await lines(r, c, gate)).filter((l) => !l.ok).map((l) => l.check);
const clean = async (r: Receipt, c: ChainReads = chain()) => {
  const l = await lines(r, c);
  assert.deepEqual(
    l.filter((x) => !x.ok),
    [],
    l.map((x) => x.line).join("\n"),
  );
  return l;
};

test("an untouched receipt passes every check, and prints the enclave signer", async () => {
  const l = await clean(base);
  assert.deepEqual(
    l.map((x) => x.check),
    [
      "status agrees with the decision",
      "gate",
      "hashes",
      "enclave-signature",
      "decision",
      "sentence",
      "decision-used",
      "payer",
      "near-payment-tx",
      "near-payment-args",
      "authorization-state",
      "near-payment-event",
      "amount",
      "base-transfer",
      "base-authorization",
    ],
  );
  assert.ok(l.every((x) => x.line.startsWith("PASS")));
  assert.ok(l.find((x) => x.check === "enclave-signature")?.line.includes(hex(b64.dec(signer))));
});

test("the AuthorizationUsed topic is the one USDC emits (read from a real Base receipt)", () => {
  assert.equal(AUTHORIZATION_USED, "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5");
});

// ---- trust root

test("a receipt from another gate fails, even when its own gate's tx is perfect", async () => {
  const forged = { ...base, gate: EVIL };
  const f = await failed(forged, chain(nearTx({ gate: EVIL })));
  assert.ok(f.includes("gate") && f.includes("near-payment-tx"), f.join());
});

test("a sign_payment on another gate fails although the receipt names the pinned one", async () => {
  assert.ok((await failed(base, chain(nearTx({ gate: EVIL })))).includes("near-payment-tx"));
});

test("a payment for another owner fails", async () => {
  const f = await failed({ ...base, owner: "bob.testnet" });
  assert.ok(f.includes("payer") && f.includes("near-payment-args"), f.join());
});

test("a payer the gate does not hold for this owner fails", async () => {
  assert.deepEqual(await failed(base, chain(nearTx(), baseRc(), "0x2222222222222222222222222222222222222222")), [
    "payer",
  ]);
  assert.deepEqual(await failed(base, chain(nearTx(), baseRc(), PAYER.toUpperCase().replace("0X", "0x"))), []);
});

// ---- the model side

test("a changed sentence fails the sentence check", async () => {
  assert.deepEqual(await failed({ ...base, sentence: "a 500 MYR voucher" }), ["sentence"]);
});

test("a request without exactly one system and one user message fails the sentence check", async () => {
  const req = chat([userMsg("x"), userMsg()]);
  const r = { ...base, request_b64: b64.enc(req), proof: proofFor(req, response) };
  assert.deepEqual(
    await failed(
      r,
      chain(
        nearTx({
          args: argsOf({
            decision: {
              ...argsOf().decision,
              request_hash: b64.enc(sha(req)),
              signature: proofFor(req, response).signature,
            },
          }),
        }),
      ),
    ),
    ["sentence", "near-payment-event"],
  );
});

test("a changed response fails the hash check", async () => {
  const forged = reply({ ...BUY, max_price_usdc: "9.00" });
  const f = await failed({ ...base, response_b64: b64.enc(forged) });
  assert.ok(f.includes("hashes") && f.includes("decision"), f.join());
});

test("a decision the response does not say fails the decision check", async () => {
  assert.deepEqual(await failed({ ...base, decision: { ...buyDecision, maxPriceUsdc: "9000000" } }), ["decision"]);
});

test("duplicate keys or extra keys in the model content fail the decision check", async () => {
  const dup = `{"action":"buy","product_id":"kfc-my","package_value":"5","max_price_usdc":"1.40","action":"refuse"}`;
  assert.ok(
    (await failed(answered(dup, buyDecision), chain(nearTx({ args: argsOf({ decision: undefined }) })))).includes(
      "decision",
    ),
  );
  const extra = { ...BUY, note: "hi" };
  assert.ok((await failed(answered(extra, buyDecision))).includes("decision"));
});

test("an unknown action fails (it is not read as a question)", async () => {
  const r = answered({ action: "foo" }, { action: "foo" } as unknown as Receipt["decision"], {
    near: {},
    baseTx: undefined as never,
    status: "failed",
  });
  assert.ok((await failed(r)).includes("decision"));
  const d = answered({ action: "foo" }, { action: "foo" } as unknown as Receipt["decision"], { status: "delivered" });
  assert.ok((await failed(d)).includes("status agrees with the decision"));
});

test("a signature from another key, or another model, fails", async () => {
  const f = await failed({ ...base, model: "other-model" });
  assert.ok(f.includes("enclave-signature"));
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x as string;
  const p = { ...proof, signer: b64.enc(new Uint8Array(Buffer.from(other, "base64url"))) };
  assert.ok((await failed({ ...base, proof: p })).includes("enclave-signature"));
  assert.ok((await failed({ ...base, proof: { ...proof, kind: 1 } })).includes("enclave-signature"));
});

// ---- the NEAR side

test("a sign_payment whose own receipt failed fails, whatever the tx-level status says", async () => {
  const tx = nearTx({ payment: { Failure: { ActionError: { kind: "FunctionCallError" } } } });
  assert.ok((await failed(base, chain(tx))).includes("near-payment-tx"));
});

test("no payment_signed event fails", async () => {
  assert.ok(
    (await failed(base, chain(nearTx({ logs: ["the MPC network did not sign"] })))).includes("near-payment-event"),
  );
});

test("an event in a failed callback, or in a receipt that is not the callback, does not count", async () => {
  assert.deepEqual(await failed(base, chain(nearTx({ callback: { Failure: {} } }))), ["near-payment-event"]);
  const e = `EVENT_JSON:${JSON.stringify(eventOf())}`;
  const tx = nearTx({ logs: [] });
  (tx.receipts[0] as Tx["receipts"][number]).execution_outcome.outcome.logs.push(e);
  assert.deepEqual(await failed(base, chain(tx)), ["near-payment-event"]);
});

test("an event that is not the one the callback was given fails", async () => {
  assert.deepEqual(await failed(base, chain(nearTx({ cbEvent: "EVENT_JSON:{}" }))), ["near-payment-event"]);
});

test("an event that disagrees with the arguments or the receipt fails", async () => {
  for (const data of [
    { nonce: `0x${"0b".repeat(32)}` },
    { to: OTHER_TO },
    { value: "1" },
    { owner: "bob.testnet" },
    { model: "m2" },
    { response_hash: "00" },
  ]) {
    const logs = [`EVENT_JSON:${JSON.stringify(eventOf(data))}`];
    assert.deepEqual(await failed(base, chain(nearTx({ logs }))), ["near-payment-event"], JSON.stringify(data));
  }
});

test("arguments with other hashes fail the argument check", async () => {
  const a = argsOf({ decision: { ...argsOf().decision, response_hash: b64.enc(sha("other")) } });
  assert.ok((await failed(base, chain(nearTx({ args: a })))).includes("near-payment-args"));
});

test("a value that is not priceUsdc, or is above the limit, fails the amount check", async () => {
  assert.deepEqual(await failed({ ...base, priceUsdc: "1" }), ["amount"]);
  const lowReply = { ...BUY, max_price_usdc: "1.00" };
  const r = answered(lowReply, { ...buyDecision, maxPriceUsdc: "1000000" });
  const resp = reply(lowReply);
  const tx = nearTx({
    args: argsOf({
      decision: { ...argsOf().decision, response_hash: r.proof.response_hash, signature: r.proof.signature },
    }),
    logs: [`EVENT_JSON:${JSON.stringify(eventOf({ response_hash: hex(sha(resp)) }))}`],
  });
  assert.deepEqual(await failed(r, chain(tx)), ["amount"]);
});

test("numbers must be plain decimal strings", async () => {
  for (const bad of ["", " 1310000", "0x14000", "1310000.0", "-1"])
    assert.ok((await failed({ ...base, priceUsdc: bad })).includes("amount"), bad);
  const f = await failed({ ...base, decision: { ...buyDecision, maxPriceUsdc: "0x155cc0" } });
  assert.ok(f.includes("decision") && f.includes("amount"), f.join());
  assert.ok((await failed(base, chain(nearTx({ args: argsOf({ value: "0x14" }) })))).includes("near-payment-args"));
});

// ---- the Base side

test("a Base transfer of another amount, to another address, or on another token fails only the Base transfer", async () => {
  assert.deepEqual(await failed(base, chain(nearTx(), baseRc({ value: 1_000n }))), ["base-transfer"]);
  assert.deepEqual(await failed(base, chain(nearTx(), baseRc({ to: OTHER_TO }))), ["base-transfer"]);
  assert.deepEqual(
    await failed(base, chain(nearTx(), baseRc({ token: "0x4200000000000000000000000000000000000006" }))),
    ["base-transfer"],
  );
});

test("a different `to` in the sign_payment arguments than on Base fails, and so does another payer", async () => {
  const to = OTHER_TO;
  const tx = nearTx({ args: argsOf({ to }), logs: [`EVENT_JSON:${JSON.stringify(eventOf({ to }))}`] });
  assert.deepEqual(await failed(base, chain(tx)), ["base-transfer"]);
  assert.deepEqual(
    await failed(
      { ...base, payer: "0x2222222222222222222222222222222222222222" },
      chain(nearTx(), baseRc(), "0x2222222222222222222222222222222222222222"),
    ),
    ["base-transfer", "base-authorization"],
  );
});

test("a Base tx without this order's AuthorizationUsed nonce fails only that check", async () => {
  assert.deepEqual(await failed(base, chain(nearTx(), baseRc({ auth: false }))), ["base-authorization"]);
  assert.deepEqual(await failed(base, chain(nearTx(), baseRc({ nonce: `0x${"0b".repeat(32)}` }))), [
    "base-authorization",
  ]);
});

test("a failed or missing Base tx fails", async () => {
  assert.ok((await failed(base, chain(nearTx(), baseRc({ status: "0x0" })))).includes("base-transfer"));
  assert.ok((await failed(base, chain(nearTx(), null))).includes("base-transfer"));
});

// ---- status, decision and payment

test("a legitimate receipt of every exit path of the flow has no FAIL", async () => {
  const refuseReply = { action: "refuse", reason: "no match" };
  const askReply = { action: "ask", question: "which size?" };
  const stripped: Partial<Receipt> = { near: {}, baseTx: undefined as never };
  const unpaid: World = { used: false, auth: false };
  // refused by the model (a login tx may be recorded)
  await clean(
    answered(
      refuseReply,
      { action: "refuse", reason: "no match" },
      { ...stripped, near: { login: "loginTx" }, status: "refused", reason: "no match" },
    ),
    chain(nearTx(), baseRc(), PAYER, unpaid),
  );
  // asked
  await clean(
    answered(askReply, { action: "ask", question: "which size?" }, { ...stripped, status: "asked" }),
    chain(nearTx(), baseRc(), PAYER, unpaid),
  );
  // refused by the contract: the sign_payment receipt failed (the decision stays unused)
  await clean(
    { ...base, status: "refused", baseTx: undefined as never },
    chain(nearTx({ payment: { Failure: { ActionError: { kind: "FunctionCallError" } } } }), baseRc(), PAYER, unpaid),
  );
  // refused by the contract: the MPC network did not sign (receipt succeeded, no event, decision spent, nothing executed)
  await clean(
    { ...base, status: "refused", baseTx: undefined as never },
    chain(
      nearTx({ logs: ["the MPC network did not sign; the decision and the allowance stay spent"] }),
      baseRc(),
      PAYER,
      { used: true, auth: false },
    ),
  );
  // refused by the contract before any transaction was recorded
  const l = await clean(
    { ...base, status: "refused", near: {}, baseTx: undefined as never },
    chain(nearTx(), baseRc(), PAYER, unpaid),
  );
  assert.ok(l.some((x) => x.line.startsWith("SKIP")));
  // the gate refused to reuse a decision an earlier order spent
  await clean(
    { ...base, status: "refused", baseTx: undefined as never },
    chain(
      nearTx({
        payment: {
          Failure: {
            ActionError: {
              kind: {
                FunctionCallError: { ExecutionError: "Smart contract panicked: this decision was already used" },
              },
            },
          },
        },
      }),
      baseRc(),
      PAYER,
      { used: true, auth: false },
    ),
  );
  // failed after a decision, before paying; and after signing but before settling; and after settling
  await clean(
    { ...base, status: "failed", near: {}, baseTx: undefined as never, reason: "invoice price above the limit" },
    chain(nearTx(), baseRc(), PAYER, unpaid),
  );
  const unsettled = await clean(
    { ...base, status: "failed", baseTx: undefined as never },
    chain(nearTx(), baseRc(), PAYER, { used: true, auth: false }),
  );
  assert.ok(unsettled.some((x) => x.check === "base-transfer" && x.line.startsWith("SKIP")));
  await clean({ ...base, status: "failed", reason: "delivery ended expired" });
  // failed after the gate refused, recorded as failed
  await clean(
    { ...base, status: "failed", baseTx: undefined as never },
    chain(nearTx({ payment: { Failure: {} } }), baseRc(), PAYER, unpaid),
  );
  // failed because the model's output was not a decision: the flow keeps the placeholder decision
  const placeholder = { action: "refuse", reason: "no decision was reached" } as const;
  for (const bad of [
    "not json at all",
    { ...BUY, product_id: "not-offered" },
    { ...BUY, extra: 1 },
    { action: "foo" },
  ]) {
    const g = await clean(
      answered(bad, placeholder, { ...stripped, status: "failed" }),
      chain(nearTx(), baseRc(), PAYER, unpaid),
    );
    assert.ok(
      g.some((x) => x.check === "decision" && x.line.startsWith("SKIP")),
      JSON.stringify(bad),
    );
  }
});

test("failed before a model decision prints one SKIP line and no FAIL", async () => {
  const empty: Receipt = {
    ...base,
    request_b64: "",
    response_b64: "",
    proof: { kind: 2, request_hash: "", response_hash: "", signer: "", signature: "" },
    decision: { action: "refuse", reason: "no decision was reached" },
    priceUsdc: "0",
    near: {},
    baseTx: undefined as never,
    status: "failed",
  };
  const l = await lines(empty);
  assert.equal(l.length, 1);
  assert.ok(l[0]?.ok && l[0].line.startsWith("SKIP") && l[0].line.includes("nothing to verify"));
  // the contract refused the sign-in before any decision
  assert.deepEqual(
    (await lines({ ...empty, status: "refused", near: { login: "t" } })).map((x) => x.ok),
    [true],
  );
});

test("a mixed empty-and-filled receipt fails", async () => {
  const empty = {
    ...base,
    request_b64: "",
    response_b64: "",
    proof: { kind: 2 as const, request_hash: "", response_hash: "", signer: "", signature: "" },
    near: {},
    baseTx: undefined as never,
    status: "failed" as const,
  };
  assert.ok((await failed({ ...empty, response_b64: base.response_b64 })).includes("hashes"));
  assert.ok((await failed({ ...empty, proof })).includes("hashes"));
  assert.ok(
    (await failed({ ...empty, status: "delivered", near: { payment: "nearTx1" }, baseTx: "0xbase1" })).includes(
      "hashes",
    ),
  );
  assert.ok((await failed({ ...empty, near: { payment: "nearTx1" } })).length > 0);
  assert.ok((await failed({ ...empty, status: "delivered" })).includes("status agrees with the decision"));
});

test("each status and decision pair the flow cannot produce fails the status line", async () => {
  const refuse = { action: "refuse", reason: "no match" } as const;
  const ask = { action: "ask", question: "q" } as const;
  const none = { near: {}, baseTx: undefined as never };
  const cases: [string, Receipt][] = [
    ["delivered, decision refuse", { ...base, decision: refuse }],
    ["delivered, no baseTx", { ...base, baseTx: undefined as never }],
    ["delivered, no payment", { ...base, near: {} }],
    ["asked, decision buy", { ...base, status: "asked", ...none }],
    ["asked, decision refuse", { ...base, status: "asked", decision: refuse, ...none }],
    ["asked with a payment", { ...base, status: "asked", decision: ask }],
    ["refused, decision ask", { ...base, status: "refused", decision: ask, ...none }],
    [
      "refused by the model with a payment",
      { ...base, status: "refused", decision: refuse, baseTx: undefined as never },
    ],
    ["refused with a Base tx", { ...base, status: "refused" }],
    ["unknown status", { ...base, status: "weird" as never }],
    ["missing status", { ...base, status: undefined as never }],
  ];
  for (const [name, r] of cases) assert.ok((await failed(r)).includes("status agrees with the decision"), name);
});

test("a refusal the chain contradicts fails: the gate signed the payment", async () => {
  assert.ok((await failed({ ...base, status: "refused", baseTx: undefined as never })).includes("near-payment-tx"));
});

// ---- malformed receipts

test("a malformed receipt fails instead of throwing", async () => {
  const bad: unknown[] = [
    null,
    7,
    {},
    { ...base, near: undefined },
    { ...base, proof: undefined },
    { ...base, decision: undefined },
    { ...base, request_b64: "not base64!", proof: { ...proof, signer: "x" } },
    { ...base, owner: 5 },
    { ...base, payer: undefined },
    { ...base, priceUsdc: undefined },
  ];
  for (const b of bad) {
    const l = await checkReceipt(b as Receipt, chain(), GATE);
    assert.ok(l.length > 0 && l.some((x) => !x.ok), JSON.stringify(b)?.slice(0, 60));
  }
  const f = await failed({ ...base, request_b64: "not base64!", proof: { ...proof, signer: "x" } });
  assert.ok(f.includes("hashes") && f.includes("enclave-signature") && f.includes("sentence"));
});

test("a chain read that throws fails its line", async () => {
  const c: ChainReads = {
    nearTx: async () => {
      throw new Error("rpc down");
    },
    gateAccount: async () => {
      throw new Error("rpc down");
    },
    baseReceipt: async () => {
      throw new Error("rpc down");
    },
    decisionUsed: async () => {
      throw new Error("rpc down");
    },
    authorizationUsed: async () => {
      throw new Error("rpc down");
    },
  };
  const f = await failed(base, c);
  for (const check of ["payer", "decision-used", "near-payment-tx", "authorization-state", "base-transfer"])
    assert.ok(f.includes(check), check);
});

// ---- an unpaid receipt must be shown unpaid

const noPay: Partial<Receipt> = { near: {}, baseTx: undefined as never };
const modelRefusal = answered(
  { action: "refuse", reason: "no match" },
  { action: "refuse", reason: "no match" },
  { ...noPay, status: "refused" },
);
const modelQuestion = answered(
  { action: "ask", question: "q?" },
  { action: "ask", question: "q?" },
  { ...noPay, status: "asked" },
);
const line = async (r: Receipt, c: ChainReads, check: string) => (await lines(r, c)).find((l) => l.check === check);

test("decision-used, both directions: a decision the gate spent needs the recorded payment, an unspent one must not claim it", async () => {
  // consumed and recorded: PASS with its own wording
  assert.match((await line(base, chain(), "decision-used"))?.line ?? "", /^PASS.*consumed by the recorded payment/);
  // unspent and recorded as signed: FAIL
  assert.deepEqual(await failed(base, chain(nearTx(), baseRc(), PAYER, { used: false })), ["decision-used"]);
  // unspent and unrecorded: PASS
  assert.match(
    (await line(modelQuestion, chain(nearTx(), baseRc(), PAYER, { used: false }), "decision-used"))?.line ?? "",
    /^PASS.*decision unused on the gate/,
  );
  // spent and unrecorded: FAIL
  assert.deepEqual(await failed(modelQuestion, chain(nearTx(), baseRc(), PAYER, { used: true })), ["decision-used"]);
});

test("a model refusal or question whose proof the gate already paid with fails", async () => {
  for (const r of [modelRefusal, modelQuestion]) {
    const l = await line(r, chain(nearTx(), baseRc(), PAYER, { used: true }), "decision-used");
    assert.ok(l && !l.ok && l.line.includes("the gate has consumed this decision but the receipt shows no payment"));
  }
});

test("a refused or failed buy with no recorded payment fails when the gate consumed the decision", async () => {
  const refused = { ...base, status: "refused" as const, ...noPay };
  const failedBuy = { ...base, status: "failed" as const, ...noPay };
  assert.deepEqual(await failed(refused, chain(nearTx(), baseRc(), PAYER, { used: true })), ["decision-used"]);
  assert.deepEqual(await failed(failedBuy, chain(nearTx(), baseRc(), PAYER, { used: true })), ["decision-used"]);
  assert.deepEqual(await failed(refused, chain(nearTx(), baseRc(), PAYER, { used: false })), []);
});

test("the placeholder decision over a valid decision response fails", async () => {
  const placeholder = { action: "refuse", reason: "no decision was reached" } as const;
  const r = { ...base, ...noPay, status: "failed" as const, decision: placeholder };
  const l = await lines(r, chain(nearTx(), baseRc(), PAYER, { used: false }));
  assert.deepEqual(
    l.filter((x) => !x.ok).map((x) => x.check),
    ["decision"],
  );
  assert.match(l.find((x) => x.check === "decision")?.line ?? "", /valid decision/);
});

test("a signed payment without the event, executed on Base after the MPC call timed out, fails", async () => {
  const noEvent = nearTx({ logs: ["the MPC network did not sign; the decision and the allowance stay spent"] });
  const asRefused = { ...base, status: "refused" as const, baseTx: undefined as never };
  const asFailed = { ...base, status: "failed" as const, baseTx: undefined as never };
  for (const r of [asRefused, asFailed]) {
    const l = await line(r, chain(noEvent, baseRc(), PAYER, { used: true, auth: true }), "authorization-state");
    assert.ok(l && !l.ok && l.line.includes("this authorization was executed on Base"), r.status);
    assert.match(
      (await line(r, chain(noEvent, baseRc(), PAYER, { used: true, auth: false }), "authorization-state"))?.line ?? "",
      /^PASS.*authorization not executed on Base/,
    );
  }
});

test("authorization-state on a non-delivered receipt: executed fails, not executed passes; delivered must be executed", async () => {
  for (const status of ["refused", "failed"] as const) {
    const r = { ...base, status, baseTx: undefined as never };
    const tx = nearTx({ payment: { Failure: {} } });
    assert.ok(
      !(await line(r, chain(tx, baseRc(), PAYER, { used: false, auth: true }), "authorization-state"))?.ok,
      status,
    );
    assert.ok(
      (await line(r, chain(tx, baseRc(), PAYER, { used: false, auth: false }), "authorization-state"))?.ok,
      status,
    );
  }
  assert.ok((await line(base, chain(), "authorization-state"))?.line.includes("executed on Base"));
  assert.deepEqual(await failed(base, chain(nearTx(), baseRc(), PAYER, { auth: false })), ["authorization-state"]);
  // a recorded Base tx whose authorization was never executed
  assert.ok(
    (await failed({ ...base, status: "failed" }, chain(nearTx(), baseRc(), PAYER, { auth: false }))).includes(
      "authorization-state",
    ),
  );
});

test("a read that fails is a FAIL on its own line, never a SKIP", async () => {
  const d = await lines(base, chain(nearTx(), baseRc(), PAYER, { used: "throw" }));
  assert.deepEqual(
    d.filter((x) => !x.ok).map((x) => x.check),
    ["decision-used"],
  );
  assert.match(d.find((x) => x.check === "decision-used")?.line ?? "", /^FAIL.*rpc down/);
  const a = await lines(base, chain(nearTx(), baseRc(), PAYER, { auth: "throw" }));
  assert.deepEqual(
    a.filter((x) => !x.ok).map((x) => x.check),
    ["authorization-state"],
  );
  assert.match(a.find((x) => x.check === "authorization-state")?.line ?? "", /^FAIL.*rpc down/);
});

test("the signer is trusted only when a successful sign_payment on the pinned gate carries the proof", async () => {
  const trusted = await line(base, chain(), "enclave-signature");
  assert.ok(trusted?.line.includes("trusted: the pinned gate accepted it"));
  assert.ok(!(await lines(base, chain())).some((x) => x.check === "signer-pinned"));
  // no sign_payment at all (a question): the signature is valid maths, the key is not vouched for, and a SKIP says so
  const l = await lines(modelQuestion, chain(nearTx(), baseRc(), PAYER, { used: false }));
  const sig = l.find((x) => x.check === "enclave-signature");
  assert.ok(sig?.ok && !sig.line.includes("trusted") && sig.line.includes("not vouched for"));
  assert.match(l.find((x) => x.check === "signer-pinned")?.line ?? "", /^SKIP.*not pinned by the gate/);
  // a random key signs a receipt whose payment sits on another contract: valid signature, no trust
  const key = generateKeyPairSync("ed25519");
  const rogue = b64.enc(new Uint8Array(Buffer.from(key.publicKey.export({ format: "jwk" }).x as string, "base64url")));
  const [a, b] = [sha(request), sha(response)];
  const p = {
    ...proof,
    signer: rogue,
    signature: b64.enc(new Uint8Array(sign(null, teeText(2, MODEL, a, b), key.privateKey))),
  };
  const forged = await lines({ ...base, proof: p }, chain(nearTx({ gate: EVIL })));
  assert.ok(!forged.find((x) => x.check === "enclave-signature")?.line.includes("trusted"));
  assert.match(forged.find((x) => x.check === "signer-pinned")?.line ?? "", /^SKIP/);
  assert.ok(forged.some((x) => !x.ok));
});

test("the footer counts SKIP lines and says what an unpaid receipt left unverified", async () => {
  const l = await lines(modelQuestion, chain(nearTx(), baseRc(), PAYER, { used: false }));
  const f = footer(l, "asked");
  assert.match(f, /no FAIL · \d+ PASS · 3 SKIP/);
  assert.match(f, /does not prove delivery/);
  assert.match(f, /This receipt is asked: only the recorded transactions and two on-chain reads/);
  assert.ok(!footer(await lines(base, chain()), "delivered").includes("This receipt is"));
});
