// One sentence to one order: model picks the purchase inside an enclave, the code enforces the price limit, only
// the shortfall is swapped, the paygate contract signs the payment, the voucher goes to the secrets directory.
// Every exit path writes a receipt, so a failed or refused order still leaves evidence.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NearAi } from "../../keeper/src/nearai.ts";
import { b64 } from "../../protocol/src/index.ts";
import type { TeeProof } from "../../protocol/src/intent.ts";
import type { Payer } from "../../solver/src/bitrefill.ts";
import { GateRefused } from "../../solver/src/paygate.ts";
import { attest, decisionRequest, parseDecision, parseSearch, searchRequest } from "./intake.ts";
import { pickRail, type Rail } from "./rail.ts";
import { type Receipt, type StoredDecision, writeReceipt } from "./receipt.ts";

/** A recorded decision to send to the gate again instead of asking the model (shows the contract refusing reuse). */
export interface Replay {
  model: string;
  request: Uint8Array;
  response: Uint8Array;
  proof: TeeProof;
  query: string;
  country: string;
}

export interface OrderDeps {
  ai: NearAi;
  model: string;
  rails: Rail[];
  /** The paygate contract and the account that opened it. */
  gate: string;
  owner: string;
  /** The EVM address the gate's key controls. */
  payer: `0x${string}`;
  /** A signer for the payer. No decision: sign-in only. With one: it can also sign a payment. `log` receives the signer's lines. */
  signer(decision: { model: string; proof: TeeProof } | undefined, log: (s: string) => void): Payer;
  balance(address: `0x${string}`): Promise<bigint>;
  /** Buys `usdcOut` USDC base units onto the payer's address. */
  swap(usdcOut: bigint): Promise<{ depositTx: string }>;
  /** Vouchers: `order-<invoice>.json`, mode 0600. */
  secretsDir: string;
  /** Receipts: `<id>.json`. */
  ordersDir: string;
  replay?: Replay;
  log?: (s: string) => void;
  /** Wait between balance polls after a swap. */
  pollMs?: number;
}

const UNIT = 1_000_000n;
/** "1.31" to 1310000n. The rail already bounds the text to at most 9 decimals; extra digits are cut. */
const units = (s: string): bigint => {
  const [whole = "0", frac = ""] = s.split(".");
  return BigInt(whole) * UNIT + BigInt(frac.padEnd(6, "0").slice(0, 6));
};
const usd = (u: bigint): string => `${u / UNIT}.${String(u % UNIT).padStart(6, "0")}`;
/** The listed price plus 3 percent, rounded up to the cent, in base units. */
const ceiling = (listed: bigint): bigint => ((listed * 103n + 999_999n) / 1_000_000n) * 10_000n;

const NO_PROOF: TeeProof = { kind: 2, request_hash: "", response_hash: "", signer: "", signature: "" };

/** x402 wraps the signer's error; the contract's refusal is somewhere in the cause chain. */
function refusal(e: unknown): GateRefused | undefined {
  for (let c = e; c; c = (c as { cause?: unknown }).cause) if (c instanceof GateRefused) return c;
  return undefined;
}

export async function placeOrder(sentence: string, deps: OrderDeps): Promise<Receipt> {
  const t0 = Date.now();
  const log = deps.log ?? (() => {});
  const legsMs: Record<string, number> = {};
  const leg = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await f();
    } finally {
      legsMs[name] = Date.now() - t;
    }
  };
  const r: Receipt = {
    id: `${new Date(t0).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date(t0).toISOString(),
    sentence,
    owner: deps.owner,
    model: deps.replay?.model ?? deps.model,
    // before a decision exists these stay empty: the status says why
    request_b64: "",
    response_b64: "",
    proof: NO_PROOF,
    decision: { action: "refuse", reason: "no decision was reached" },
    rail: "",
    invoiceId: "",
    priceUsdc: "0",
    payer: deps.payer,
    gate: deps.gate,
    near: {},
    status: "failed",
    legsMs,
  };
  const done = (status: Receipt["status"], reason?: string): Receipt => {
    r.status = status;
    if (reason !== undefined) r.reason = reason;
    legsMs.total = Date.now() - t0;
    writeReceipt(deps.ordersDir, r);
    return r;
  };
  // ponytail: the signer reports its NEAR transaction only through its log line; parse it. Return the hash from the signer if that line changes.
  const capture = (s: string) => {
    log(s);
    const m = /^paygate (sign_login|sign_payment): NEAR tx (\S+)/.exec(s);
    if (m) r.near[m[1] === "sign_login" ? "login" : "payment"] = m[2] as string;
  };

  let stage: "login" | "pay" | "other" = "other";
  try {
    const found = await leg("search", async () => {
      const q = deps.replay ?? parseSearch((await deps.ai.complete(searchRequest(deps.model, sentence))).response);
      const rail = pickRail(deps.rails, q.country);
      r.rail = rail.name;
      stage = "login";
      await rail.open(deps.signer(undefined, capture));
      stage = "other";
      return { rail, candidates: await rail.search(q.query, q.country) };
    });
    const { rail, candidates } = found;
    if (candidates.length === 0) return done("failed", "the rail found no product for that search");

    const a = await leg(
      "decide",
      async () =>
        deps.replay ?? {
          model: deps.model,
          ...(await attest(deps.ai, deps.model, decisionRequest(deps.model, sentence, candidates))),
        },
    );
    r.model = a.model;
    r.request_b64 = b64.enc(a.request);
    r.response_b64 = b64.enc(a.response);
    r.proof = a.proof;
    const decision = parseDecision(a.response, candidates);
    if (decision.action !== "buy") {
      r.decision = decision;
      return decision.action === "refuse" ? done("refused", decision.reason) : done("asked", decision.question);
    }
    r.decision = { ...decision, maxPriceUsdc: decision.maxPriceUsdc.toString() } satisfies StoredDecision;

    // The limit is enforced here, not only by the prompt: the model's number may not exceed the listed price plus 3 percent.
    const listed = units(
      candidates
        .find((c) => c.productId === decision.productId)
        ?.packages.find((p) => p.value === decision.packageValue)?.priceUsd as string,
    );
    if (decision.maxPriceUsdc > ceiling(listed))
      return done(
        "failed",
        `the limit is above the listed price plus 3 percent: limit ${usd(decision.maxPriceUsdc)}, listed ${usd(listed)} USDC`,
      );

    const invoice = await leg("invoice", () => rail.invoice(decision.productId, decision.packageValue));
    r.invoiceId = invoice.id;
    r.priceUsdc = invoice.priceUsdc.toString();
    if (invoice.priceUsdc > decision.maxPriceUsdc)
      return done(
        "failed",
        `invoice price ${usd(invoice.priceUsdc)} is above the limit ${usd(decision.maxPriceUsdc)} USDC`,
      );

    // Buy only what the payer is short of; an earlier run can leave a few cents behind.
    const held = await deps.balance(deps.payer);
    if (held < invoice.priceUsdc) {
      const swap = await leg("swap", async () => {
        const s = await deps.swap(invoice.priceUsdc - held);
        for (let i = 0; i < 30 && (await deps.balance(deps.payer)) < invoice.priceUsdc; i++)
          await new Promise((res) => setTimeout(res, deps.pollMs ?? 2_000));
        return s;
      });
      r.near.deposit = swap.depositTx;
      if ((await deps.balance(deps.payer)) < invoice.priceUsdc)
        return done("failed", "the payer's USDC balance is still short after the swap");
    }

    stage = "pay";
    r.baseTx = await leg("pay", () => rail.pay(deps.signer({ model: a.model, proof: a.proof }, capture), invoice));
    stage = "other";
    const delivery = await leg("wait", () => rail.wait(invoice, log));
    mkdirSync(deps.secretsDir, { recursive: true });
    writeFileSync(join(deps.secretsDir, `order-${invoice.id}.json`), JSON.stringify(delivery.secret, null, 2), {
      mode: 0o600,
    });
    return delivery.delivered ? done("delivered") : done("failed", `delivery ended ${delivery.status}`);
  } catch (e) {
    const gate = refusal(e);
    if (gate) {
      if (gate.nearTx && stage !== "other") r.near[stage === "pay" ? "payment" : "login"] = gate.nearTx;
      return done("refused", gate.message);
    }
    const m = /paygate refused: [^\n]*/.exec(String((e as Error)?.message ?? e));
    return m ? done("refused", m[0]) : done("failed", String((e as Error)?.message ?? e));
  }
}
