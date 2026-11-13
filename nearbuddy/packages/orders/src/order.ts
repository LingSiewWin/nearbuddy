// One sentence to one order: model picks the purchase inside an enclave, the code enforces the price limit, only
// the shortfall is swapped, the paygate contract signs the payment, the voucher goes to the secrets directory.
// Every exit path writes a receipt, so a failed or refused order still leaves evidence.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NearAi } from "../../keeper/src/nearai.ts";
import type { Account as GateAccount } from "../../protocol/src/abi/paygate.ts";
import { b64 } from "../../protocol/src/index.ts";
import { proofHash, type TeeProof } from "../../protocol/src/intent.ts";
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
  /** A signer for the payer. No decision: sign-in only. With one: it can also sign a payment. `onTx` gets the NEAR transaction of each signature. */
  signer(
    decision: { model: string; proof: TeeProof } | undefined,
    onTx: (method: "sign_payment" | "sign_login", nearTx: string) => void,
    /** The contract refused: the refused transaction (when there is one) and its reason. */
    onRefused: (method: "sign_payment" | "sign_login", nearTx: string | undefined, reason: string) => void,
  ): Payer;
  /** The gate's views. Read before any swap, so a policy that cannot pay never costs NEAR. */
  gateView: {
    account(owner: string): Promise<GateAccount | null>;
    /** `proofHash` is base64 of sha256(request hash and response hash). */
    isDecisionUsed(proofHash: string): Promise<boolean>;
  };
  /** Unix seconds; defaults to the clock. */
  nowSec?: () => number;
  balance(address: `0x${string}`): Promise<bigint>;
  /** Buys `usdcOut` USDC base units onto the payer's address. `onDeposit` gets the NEAR transaction as soon as it is
   *  sent: from then on NEAR has left the funding account, whatever happens next. */
  swap(usdcOut: bigint, onDeposit: (depositTx: string) => void): Promise<{ depositTx: string }>;
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

/** `price_usd` of one package in the candidates the recorded decision request carried (its user message is JSON). */
function recordedPrice(request: Uint8Array, productId: string, packageValue: string): string | undefined {
  try {
    const body = JSON.parse(new TextDecoder().decode(request)) as { messages?: { role?: string; content?: string }[] };
    const user = body.messages?.find((m) => m.role === "user")?.content;
    const offered = (
      JSON.parse(user ?? "") as {
        candidates?: { product_id?: string; packages?: { value?: string; price_usd?: unknown }[] }[];
      }
    ).candidates;
    const price = offered
      ?.find((c) => c.product_id === productId)
      ?.packages?.find((p) => p.value === packageValue)?.price_usd;
    return typeof price === "string" && /^\d{1,9}(\.\d{1,9})?$/.test(price) ? price : undefined;
  } catch {
    return undefined;
  }
}

/** Why the contract would refuse this payment, read from its views; undefined when it should sign. `local`: there is
 *  no account or policy for the contract to check against, so asking it would only fail on a missing record. */
async function policyProblem(
  deps: OrderDeps,
  decision: { model: string; proof: TeeProof },
  price: bigint,
): Promise<{ text: string; local?: true } | undefined> {
  const account = await deps.gateView.account(deps.owner);
  if (!account) return { text: `no paygate account is open for ${deps.owner}`, local: true };
  const p = account.policy;
  if (!p) return { text: "policy does not cover the payment: the account has no policy", local: true };
  const no = (text: string) => ({ text: `policy does not cover the payment: ${text}` });
  if (BigInt(account.storage_balance) === 0n) return { text: "the account's storage balance is zero" };
  const now = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  if (now >= Number(p.expires_at)) return no(`it expired at ${p.expires_at}`);
  if (price > BigInt(p.per_payment_cap))
    return no(`${usd(price)} is above the per-payment cap ${usd(BigInt(p.per_payment_cap))} USDC`);
  if (price > BigInt(p.allowance)) return no(`${usd(price)} is above the allowance ${usd(BigInt(p.allowance))} USDC`);
  if (!p.models.includes(decision.model)) return no(`model ${decision.model} is not in the policy`);
  const hash = proofHash(b64.strict(decision.proof.request_hash), b64.strict(decision.proof.response_hash));
  if (await deps.gateView.isDecisionUsed(hash)) return { text: "this decision was already used" };
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
    if (deps.replay)
      r.reason = r.reason ? `${r.reason}; replay of a recorded decision` : "replay of a recorded decision";
    legsMs.total = Date.now() - t0;
    try {
      writeReceipt(deps.ordersDir, r);
    } catch (e) {
      // The order may have moved money: the receipt (it holds no secret) must still reach the operator.
      console.log(`the receipt file could not be written (${(e as Error).message}); the receipt follows`);
      console.log(JSON.stringify(r, null, 2));
    }
    return r;
  };
  const onTx = (method: "sign_payment" | "sign_login", nearTx: string) => {
    r.near[method === "sign_login" ? "login" : "payment"] = nearTx;
  };
  // The payment library rethrows its own error without the signer's, so the refusal is taken from this callback.
  let refusedBy: GateRefused | undefined;
  const onRefused = (method: "sign_payment" | "sign_login", nearTx: string | undefined, reason: string) => {
    if (nearTx) r.near[method === "sign_login" ? "login" : "payment"] = nearTx;
    refusedBy = new GateRefused(reason, nearTx);
  };
  /** The payment settled: whatever fails after that must say where the voucher can still be fetched. */
  const paid = (what: string) => `paid; ${what}; the voucher can be fetched from ${r.rail} with invoice ${r.invoiceId}`;

  /** NEAR left the funding account: whatever fails after that must say where to look. */
  const deposited = (what: string) =>
    `deposited; ${what}; the 1Click swap may still complete: look up the deposit tx ${r.near.deposit} (NEAR, funding account)`;

  /** Set when the views say the contract will refuse; the refusal text is then appended to it. */
  let precheck: string | undefined;
  const refused = (text: string) => done("refused", precheck ? `${precheck}; contract: ${text}` : text);
  let stage: "login" | "pay" | "other" = "other";
  try {
    const found = await leg("search", async () => {
      const q = deps.replay ?? parseSearch((await deps.ai.complete(searchRequest(deps.model, sentence))).response);
      const rail = pickRail(deps.rails, q.country);
      r.rail = rail.name;
      stage = "login";
      await rail.open(deps.signer(undefined, onTx, onRefused));
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
    // A replay is bounded by the price its own request listed, not by today's catalogue (it may have moved since the
    // decision was made), and never left unbounded: a decision that failed this check was never used.
    const listedText = deps.replay
      ? recordedPrice(a.request, decision.productId, decision.packageValue)
      : candidates
          .find((c) => c.productId === decision.productId)
          ?.packages.find((p) => p.value === decision.packageValue)?.priceUsd;
    if (listedText === undefined) return done("failed", "the request lists no price for the chosen package");
    const listed = units(listedText);
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

    // The contract enforces its policy only inside sign_payment, after the swap. Read it first: when it will refuse,
    // nothing is swapped, but the contract is still asked, so the refusal is on chain.
    const held = await deps.balance(deps.payer);
    const problem = await policyProblem(deps, a, invoice.priceUsdc);
    if (problem?.local) return done("refused", problem.text);
    precheck = problem?.text;

    // Buy only what the payer is short of; an earlier run can leave a few cents behind.
    if (held < invoice.priceUsdc && !problem) {
      try {
        await leg("swap", async () => {
          await deps.swap(invoice.priceUsdc - held, (hash) => {
            r.near.deposit = hash;
          });
          for (let i = 0; i < 30 && (await deps.balance(deps.payer)) < invoice.priceUsdc; i++)
            await new Promise((res) => setTimeout(res, deps.pollMs ?? 2_000));
        });
      } catch (e) {
        if (!r.near.deposit) throw e;
        return done("failed", deposited(`the swap failed (${(e as Error).message})`));
      }
      if ((await deps.balance(deps.payer)) < invoice.priceUsdc)
        return done(
          "failed",
          deposited("the swap did not fund the payer: its USDC balance is still short, nothing was paid"),
        );
    }

    stage = "pay";
    try {
      r.baseTx = await leg("pay", () =>
        rail.pay(deps.signer({ model: a.model, proof: a.proof }, onTx, onRefused), invoice),
      );
    } catch (e) {
      if (precheck && !refusedBy && !refusal(e) && r.near.payment)
        return done(
          "failed",
          `pre-check disagreed with the contract; it signed although ${precheck}, so the decision and allowance were consumed without a swap: ${(e as Error).message}`,
        );
      throw e;
    }
    stage = "other";
    const delivery = await leg("wait", () => rail.wait(invoice, log));
    try {
      mkdirSync(deps.secretsDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(deps.secretsDir, `order-${invoice.id}.json`), JSON.stringify(delivery.secret, null, 2), {
        mode: 0o600,
      });
    } catch (e) {
      return done("failed", paid(`the voucher file could not be written (${(e as Error).message})`));
    }
    return delivery.delivered ? done("delivered") : done("failed", paid(`delivery ended ${delivery.status}`));
  } catch (e) {
    const gate = refusedBy ?? refusal(e);
    if (gate) {
      if (gate.nearTx && stage !== "other") r.near[stage === "pay" ? "payment" : "login"] = gate.nearTx;
      return refused(gate.message);
    }
    const msg = String((e as Error)?.message ?? e);
    return done("failed", r.baseTx ? paid(msg) : msg);
  }
}
