// Re-check one order receipt from public sources only, the way a stranger would: the receipt file, the NEAR
// transaction that signed the payment (FastNEAR tx API), the gate's own account record (NEAR view) and the Base
// transaction that moved the USDC (eth_getTransactionReceipt). Prints PASS / FAIL / SKIP per line and exits 1 on any
// FAIL. Sends nothing, spends nothing.
//   bun run verify-order path/to/receipt.json --gate <paygate account>      (or PAYGATE=<account>)
// The gate is an INPUT, never read from the receipt: a forger can deploy a contract of their own that logs the same
// event. The enclave signer needs no pin of its own: the pinned gate's successful `sign_payment` receipt already
// checked it against the gate's own signer list (`unknown tee signer` is a panic), so a signer that appears in a
// successful `sign_payment` on the pinned gate is one the gate trusts. The PASS line prints it.
// A NEAR outcome is read from the contract receipt's own status, never the transaction-level one (see verify_duel.ts).
// Env: FASTNEAR_TX_API (default the network's FastNEAR tx API), VERIFY_RPC (NEAR view), BASE_RPC (default
// https://mainnet.base.org).
//
// What a PASS does NOT prove: that the goods were delivered, or that the invoice was what the receipt says. Neither is
// read. It proves the sentence led, through an enclave-signed decision, to a payment of the stated amount that the
// pinned gate signed and that settled on Base from the owner's payer address. It also does not check that no other
// receipt reuses the same Base transaction (there is no receipt store to compare against).
import "../packages/protocol/src/env.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { keccak256, toBytes } from "viem";
import { modelObject } from "../packages/orders/src/intake.ts";
import type { Receipt } from "../packages/orders/src/receipt.ts";
import { b64, hex } from "../packages/protocol/src/index.ts";
import { teeText, verify } from "../packages/protocol/src/intent.ts";
import { NET, NETWORK_ID } from "../packages/protocol/src/network.ts";
import type { Tx } from "./verify_duel.ts";

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** keccak256("AuthorizationUsed(address,bytes32)"): USDC logs it when a transferWithAuthorization runs. */
export const AUTHORIZATION_USED = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));

export interface BaseReceipt {
  status: string; // "0x1" success
  logs: { address: string; topics: string[]; data: string }[];
}
/** The public reads. The CLI wires real ones, the tests wire fakes. */
export interface ChainReads {
  nearTx(hash: string): Promise<Tx>;
  /** The gate's `get_account({ owner })` at the latest block: the account record, or null. */
  gateAccount(gate: string, owner: string): Promise<{ payer?: unknown } | null>;
  baseReceipt(hash: string): Promise<BaseReceipt | null>;
}
export type Line = { check: string; line: string; ok: boolean };

const sha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const dec = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(b);
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const json = (s: string): unknown => JSON.parse(s);
const need = (ok: unknown, msg: string): void => {
  if (!ok) throw new Error(msg);
};
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
/** A non-negative decimal string as bigint: "", hex, signs and whitespace are refused. */
function units(s: unknown, name: string): bigint {
  need(typeof s === "string" && /^\d+$/.test(s), `${name} ${JSON.stringify(s)} is not a decimal string`);
  return BigInt(s as string);
}
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const str = (x: unknown): string | undefined => (typeof x === "string" && x !== "" ? x : undefined);

/** "1.40" to 1400000n (6 decimals), the same rule the intake parser applies. */
function usdcUnits(s: unknown): bigint {
  const m = typeof s === "string" ? /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(s) : null;
  need(m, `max_price_usdc ${JSON.stringify(s)} is not a decimal with at most 6 digits after the point`);
  const [, whole, frac] = m as RegExpExecArray;
  return BigInt(whole as string) * 1_000_000n + BigInt((frac ?? "").padEnd(6, "0"));
}

const DECISION_KEYS: Record<string, string[]> = {
  buy: ["action", "product_id", "package_value", "max_price_usdc"],
  refuse: ["action", "reason"],
  ask: ["action", "question"],
};

/** The sentence the request carries: exactly one system and one user message; the user content is JSON `{ sentence, candidates }`. */
function requestSentence(request: Uint8Array): unknown {
  const body = json(dec(request)) as { messages?: { role?: string; content?: unknown }[] };
  const m = body?.messages;
  need(Array.isArray(m) && m.length === 2, "request must have exactly two messages");
  const roles = (m as { role?: string }[]).map((x) => x.role).sort();
  need(roles[0] === "system" && roles[1] === "user", "request must have exactly one system and one user message");
  const user = (m as { role?: string; content?: unknown }[]).find((x) => x.role === "user");
  need(typeof user?.content === "string", "user message has no text content");
  const o = json(user?.content as string);
  need(isObj(o), "user message is not a JSON object");
  return (o as Record<string, unknown>).sentence;
}

type Call = { method: string; args: string; predecessor: string; status: unknown; ok: boolean; logs: string[] };
/** Every function-call receipt this tx ran on `gate`, each with its own outcome. */
function gateCalls(tx: Tx, gate: string): Call[] {
  return tx.receipts.flatMap((r) => {
    const a = r.receipt.receipt.Action;
    if (!a || r.receipt.receiver_id !== gate) return [];
    const status = r.execution_outcome.outcome.status;
    const ok = isObj(status) && ("SuccessValue" in status || "SuccessReceiptId" in status);
    return a.actions.flatMap((x) => {
      const fc = typeof x === "object" ? x.FunctionCall : undefined;
      if (!fc) return [];
      return [
        {
          method: fc.method_name,
          args: fc.args,
          predecessor: r.receipt.predecessor_id,
          status,
          ok,
          logs: r.execution_outcome.outcome.logs,
        },
      ];
    });
  });
}
const argsOf = (c: Call): Record<string, unknown> => {
  const a = json(Buffer.from(c.args, "base64").toString());
  need(isObj(a), "call arguments are not a JSON object");
  return a as Record<string, unknown>;
};
const failText = (status: unknown) => JSON.stringify(status).slice(0, 200);

export async function checkReceipt(r: Receipt, chain: ChainReads, expectedGate: string): Promise<Line[]> {
  const out: Line[] = [];
  /** One line per check. `fn` returns the detail, throws on FAIL, or returns `{ skip }`. Never throws itself. */
  const run = async (name: string, fn: () => string | { skip: string } | Promise<string | { skip: string }>) => {
    let res: "PASS" | "FAIL" | "SKIP" = "PASS";
    let detail: string;
    try {
      const v = await fn();
      if (typeof v === "string") detail = v;
      else [res, detail] = ["SKIP", v.skip];
    } catch (e) {
      [res, detail] = ["FAIL", e instanceof Error ? e.message : String(e)];
    }
    out.push({ check: name, line: `${res.padEnd(4)}  ${name.padEnd(24)} ${detail}`, ok: res !== "FAIL" });
  };

  try {
    need(isObj(r), "the receipt is not a JSON object");
    need(str(expectedGate), "no gate to pin");
    const decision: Record<string, unknown> = isObj(r.decision) ? r.decision : {};
    const near: Record<string, unknown> = isObj(r.near) ? r.near : {};
    const payHash = str(near.payment);
    const baseHash = str(r.baseTx);
    const action = decision.action;
    const bytes = (b64s: unknown) => {
      try {
        return b64.strict(b64s);
      } catch {
        return new Uint8Array();
      }
    };
    const request = bytes(r.request_b64);
    const response = bytes(r.response_b64);

    // An order that stopped before the model decided (a failed search, a login the gate refused) is written with empty
    // request, response and proof and a placeholder decision: there is nothing to verify, and it says so. A payment
    // field, or any other mix of empty and filled fields, takes the normal path and FAILs there.
    const proofVals = isObj(r.proof)
      ? [r.proof.request_hash, r.proof.response_hash, r.proof.signer, r.proof.signature]
      : ["x"];
    if (
      (r.status === "failed" || r.status === "refused") &&
      !payHash &&
      !baseHash &&
      [r.request_b64, r.response_b64, ...proofVals].every((v) => v === "")
    ) {
      await run("status agrees with the decision", () => ({
        skip: "failed before a model decision; nothing to verify",
      }));
      return out;
    }

    // Allowed combinations of status, decision and payment. `refused` with a buy decision is the contract's refusal
    // (the sign_payment receipt failed, or the MPC network did not sign, or no transaction was recorded).
    const refusedByGate = r.status === "refused" && action === "buy";
    await run("status agrees with the decision", () => {
      switch (r.status) {
        case "delivered":
          need(action === "buy", `delivered, but the decision is ${String(action)}`);
          need(payHash && baseHash, "delivered needs near.payment and baseTx");
          break;
        case "asked":
          need(action === "ask", `asked, but the decision is ${String(action)}`);
          need(!payHash && !baseHash, "asked, but the receipt records a payment");
          break;
        case "refused":
          need(action === "refuse" || action === "buy", `refused, but the decision is ${String(action)}`);
          need(!baseHash, "refused, but the receipt records a Base payment");
          need(action === "buy" || !payHash, "refused by the model, but the receipt records a payment");
          break;
        case "failed":
          break;
        default:
          throw new Error(`unknown status ${JSON.stringify(r.status)}`);
      }
      return `${r.status} with decision ${String(action)}`;
    });

    await run("gate", () => {
      need(r.gate === expectedGate, `receipt gate ${JSON.stringify(r.gate)} is not the pinned gate ${expectedGate}`);
      return `pinned gate ${expectedGate}`;
    });

    await run("hashes", () => {
      need(request.length > 0 && response.length > 0, "request or response is not canonical base64");
      need(eq(sha(request), b64.strict(r.proof.request_hash)), "sha256(request) differs from proof.request_hash");
      need(eq(sha(response), b64.strict(r.proof.response_hash)), "sha256(response) differs from proof.response_hash");
      return `sha256 of both bodies match the proof (${hex(sha(response)).slice(0, 12)}...)`;
    });

    await run("enclave-signature", () => {
      need(r.proof.kind === 2, `proof kind is ${r.proof.kind}, the gate accepts only 2 (the model's enclave)`);
      const text = teeText(2, r.model, b64.strict(r.proof.request_hash), b64.strict(r.proof.response_hash));
      need(
        verify(r.proof.signer, text, r.proof.signature),
        `no valid ed25519 signature over ${dec(text).slice(0, 40)}...`,
      );
      return `signed by ${hex(b64.strict(r.proof.signer))} over model:req:resp (trusted because the gate accepted it)`;
    });

    await run("decision", () => {
      // The flow keeps this placeholder when the model's output was not a valid decision (parseDecision threw): the
      // bytes are still hashed and signature-checked above.
      if (r.status === "failed" && action === "refuse" && decision.reason === "no decision was reached")
        return { skip: "no decision was reached (the model's output was not a valid decision)" };
      const o = modelObject(response, (x) =>
        typeof x.action === "string" && Object.hasOwn(DECISION_KEYS, x.action) ? DECISION_KEYS[x.action] : undefined,
      );
      need(o.action === action, `response action ${JSON.stringify(o.action)}, receipt ${String(action)}`);
      if (action === "buy") {
        need(
          o.product_id === decision.productId,
          `response product_id ${JSON.stringify(o.product_id)}, receipt ${String(decision.productId)}`,
        );
        need(
          o.package_value === decision.packageValue,
          `response package_value ${JSON.stringify(o.package_value)}, receipt ${String(decision.packageValue)}`,
        );
        need(
          usdcUnits(o.max_price_usdc) === units(decision.maxPriceUsdc, "maxPriceUsdc"),
          `response limit ${String(o.max_price_usdc)} USDC, receipt ${String(decision.maxPriceUsdc)} base units`,
        );
      } else if (action === "refuse") need(o.reason === decision.reason, "response reason differs from the receipt");
      else if (action === "ask") need(o.question === decision.question, "response question differs from the receipt");
      else throw new Error(`unknown action ${JSON.stringify(action)}`);
      return `response says ${action}`;
    });

    await run("sentence", () => {
      need(
        typeof r.sentence === "string" && requestSentence(request) === r.sentence,
        "the request's sentence is not the receipt's sentence",
      );
      return "the request carries the receipt's sentence";
    });

    // ---- payment: the gate's account, the NEAR tx (it yields `to`, `value`, `nonce`), then the Base tx
    if (payHash || r.status === "delivered") {
      await run("payer", async () => {
        const acct = await chain.gateAccount(expectedGate, r.owner);
        need(acct, `the gate has no account for ${r.owner}`);
        const payer = (acct as { payer?: unknown }).payer;
        need(
          typeof payer === "string" && typeof r.payer === "string" && payer.toLowerCase() === r.payer.toLowerCase(),
          `the gate's payer for ${r.owner} is ${String(payer)}, receipt ${String(r.payer)}`,
        );
        return `gate account of ${r.owner} has payer ${r.payer}`;
      });
    }

    let paid: { to: string; value: bigint; nonce: string } | undefined;
    let succeeded = false;
    let tx: Tx | undefined;
    if (!payHash) {
      if (r.status === "delivered")
        await run("near-payment-tx", () => Promise.reject(new Error("delivered receipt has no NEAR payment tx")));
      else
        await run("near-payment-tx", () => ({
          skip: refusedByGate ? "the gate refused before a transaction was recorded" : `no payment (${r.status})`,
        }));
    } else {
      await run("near-payment-tx", async () => {
        tx = await chain.nearTx(payHash);
        const calls = gateCalls(tx, expectedGate).filter((c) => c.method === "sign_payment");
        need(calls.length === 1, `${calls.length} sign_payment calls on ${expectedGate} in the tx, want 1`);
        const c = calls[0] as Call;
        succeeded = c.ok;
        if (refusedByGate) {
          if (!c.ok) return `the gate refused: ${failText(c.status)}`;
          // The other refusal the flow records: the call succeeded but the MPC network did not sign, so the callback
          // logged no payment_signed event.
          const cbs = gateCalls(tx, expectedGate).filter(
            (x) => x.method === "on_signed" && x.predecessor === expectedGate,
          );
          const logged = cbs.flatMap((x) => x.logs);
          need(
            cbs.length === 1 && cbs[0]?.ok && !logged.some((l) => l.startsWith("EVENT_JSON:")),
            "refused by the gate, but the payment was signed",
          );
          succeeded = false;
          return `the gate did not sign: ${logged.join(" | ").slice(0, 200)}`;
        }
        if (r.status === "failed" && !c.ok) return `sign_payment failed, order failed: ${failText(c.status)}`;
        need(c.ok, `the sign_payment receipt did not succeed: ${failText(c.status)}`);
        return `sign_payment on ${expectedGate} succeeded`;
      });
      await run("near-payment-args", () => {
        const call = tx ? gateCalls(tx, expectedGate).find((c) => c.method === "sign_payment") : undefined;
        need(call, "no sign_payment call to read");
        const a = argsOf(call as Call);
        need(isObj(a.decision), "sign_payment arguments carry no decision");
        const p = a.decision as Record<string, unknown>;
        need(typeof a.to === "string" && ADDR.test(a.to), "to is not an address");
        need(typeof a.nonce === "string" && WORD.test(a.nonce), "nonce is not 32 bytes of hex");
        paid = {
          to: (a.to as string).toLowerCase(),
          value: units(a.value, "value"),
          nonce: (a.nonce as string).toLowerCase(),
        }; // later checks still run if the next ones fail
        need(a.owner === r.owner, `owner ${JSON.stringify(a.owner)}, receipt ${r.owner}`);
        need(a.model_id === r.model, `model_id ${JSON.stringify(a.model_id)}, receipt ${r.model}`);
        for (const k of ["request_hash", "response_hash", "signer", "signature"] as const)
          need(p[k] === r.proof[k], `decision.${k} differs from the receipt's proof`);
        return `arguments carry owner, model, the proof, to ${a.to}, value ${a.value}`;
      });
    }

    const settled = r.status === "delivered" || (r.status === "failed" && succeeded);
    if (!payHash || !settled) {
      if (payHash)
        await run("payment-settlement", () => ({
          skip: refusedByGate ? "the gate refused, nothing settled" : "payment not signed, nothing settled",
        }));
    } else {
      await run("near-payment-event", () => {
        need(paid, "no arguments to compare");
        const p = paid as { to: string; value: bigint; nonce: string };
        const calls = gateCalls(tx as Tx, expectedGate).filter(
          (c) => c.method === "on_signed" && c.predecessor === expectedGate,
        );
        need(calls.length === 1, `${calls.length} on_signed callbacks in the tx, want 1`);
        const cb = calls[0] as Call;
        need(cb.ok, "the on_signed receipt did not succeed");
        const events = cb.logs.filter((l) => l.startsWith("EVENT_JSON:"));
        need(
          events.length === 1,
          `${events.length} events in the callback, want 1 (the MPC network may not have signed)`,
        );
        need(argsOf(cb).event === events[0], "the logged event is not the event the callback was given");
        const e = json((events[0] as string).slice("EVENT_JSON:".length)) as {
          standard?: string;
          event?: string;
          data?: Record<string, unknown>;
        };
        need(
          e.standard === "nearbuddy-paygate" && e.event === "payment_signed" && isObj(e.data),
          "the log is not a nearbuddy-paygate payment_signed event",
        );
        const d = e.data as Record<string, unknown>;
        const want = {
          owner: r.owner,
          to: p.to,
          value: String(p.value),
          nonce: p.nonce,
          model: r.model,
          request_hash: hex(b64.strict(r.proof.request_hash)),
          response_hash: hex(b64.strict(r.proof.response_hash)),
        };
        for (const [k, v] of Object.entries(want)) need(d[k] === v, `event ${k} is ${JSON.stringify(d[k])}, want ${v}`);
        return "the gate's callback logged payment_signed for the same owner, to, value, nonce, model and hashes";
      });

      await run("amount", () => {
        need(paid, "no value from the NEAR payment");
        const value = (paid as { value: bigint }).value;
        need(value === units(r.priceUsdc, "priceUsdc"), `value ${value} differs from priceUsdc ${r.priceUsdc}`);
        need(action === "buy", `decision is ${String(action)}, a payment needs buy`);
        const limit = units(decision.maxPriceUsdc, "maxPriceUsdc");
        need(value <= limit, `value ${value} is above the decision's limit ${limit}`);
        return `value ${value} equals priceUsdc and is within the limit ${limit} (USDC base units)`;
      });

      let rc: BaseReceipt | null = null;
      let baseErr: string | undefined;
      if (baseHash) {
        try {
          rc = await chain.baseReceipt(baseHash);
        } catch (e) {
          baseErr = e instanceof Error ? e.message : String(e);
        }
      }
      const baseRead = () => {
        need(baseHash, "the payment was not settled: the receipt has no Base tx");
        need(!baseErr, `Base read failed: ${baseErr}`);
        need(rc, "Base tx not found");
        const b = rc as BaseReceipt;
        need(b.status === "0x1", `Base tx status ${b.status}`);
        need(typeof r.payer === "string" && ADDR.test(r.payer), "payer is not an address");
        need(paid, "no to/value/nonce from the NEAR payment");
        return { b, p: paid as { to: string; value: bigint; nonce: string } };
      };
      const usdc = (l: { address: string }) => l.address.toLowerCase() === BASE_USDC.toLowerCase();
      if (!baseHash && r.status === "failed") {
        await run("base-transfer", () => ({ skip: "the payment was signed but not settled (no Base tx)" }));
      } else {
        await run("base-transfer", () => {
          const { b, p } = baseRead();
          const hit = b.logs.some(
            (l) =>
              usdc(l) &&
              l.topics[0] === TRANSFER &&
              l.topics.length === 3 &&
              l.topics[1]?.toLowerCase() === pad(r.payer) &&
              l.topics[2]?.toLowerCase() === pad(p.to) &&
              WORD.test(l.data) &&
              BigInt(l.data) === p.value,
          );
          need(hit, `no USDC (${BASE_USDC}) Transfer of ${p.value} from ${r.payer} to ${p.to} in the Base tx`);
          return `USDC Transfer of ${p.value} from ${r.payer} to ${p.to}`;
        });
        await run("base-authorization", () => {
          const { b, p } = baseRead();
          const hit = b.logs.some(
            (l) =>
              usdc(l) &&
              l.topics[0] === AUTHORIZATION_USED &&
              l.topics.length === 3 &&
              l.topics[1]?.toLowerCase() === pad(r.payer) &&
              l.topics[2]?.toLowerCase() === p.nonce,
          );
          need(
            hit,
            `no USDC AuthorizationUsed by ${r.payer} with nonce ${p.nonce} in the Base tx: it is not this order's payment`,
          );
          return `USDC AuthorizationUsed by ${r.payer} with the sign_payment nonce ${p.nonce}`;
        });
      }
    }
  } catch (e) {
    out.push({
      check: "receipt",
      line: `FAIL  receipt                  malformed: ${e instanceof Error ? e.message : String(e)}`,
      ok: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------- real reads

async function post<T>(url: string, body: unknown): Promise<T> {
  let last = "";
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    }).catch((x) => ({ ok: false, status: String(x) }) as const);
    if (res.ok && "json" in res) return (await res.json()) as T;
    last = String(res.status);
    await new Promise((s) => setTimeout(s, 500 * 2 ** i));
  }
  throw new Error(`${url} failed: ${last}`);
}

export const realReads: ChainReads = {
  async nearTx(hash) {
    const api = process.env.FASTNEAR_TX_API ?? NET.txApi;
    const { transactions } = await post<{ transactions: Tx[] }>(`${api}/transactions`, { tx_hashes: [hash] });
    const tx = transactions[0];
    if (!tx) throw new Error(`NEAR tx ${hash} not found`);
    return tx;
  },
  async gateAccount(gate, owner) {
    const rpc =
      process.env.VERIFY_RPC ??
      (NETWORK_ID === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
    const res = await post<{ result?: { result?: number[]; error?: string }; error?: unknown }>(rpc, {
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: gate,
        method_name: "get_account",
        args_base64: Buffer.from(JSON.stringify({ owner })).toString("base64"),
      },
    });
    if (res.error || !res.result?.result)
      throw new Error(`get_account on ${gate}: ${JSON.stringify(res.error ?? res.result?.error)}`);
    return json(Buffer.from(res.result.result).toString()) as { payer?: unknown } | null;
  },
  async baseReceipt(hash) {
    const rpc = process.env.BASE_RPC ?? "https://mainnet.base.org";
    const { result, error } = await post<{ result: BaseReceipt | null; error?: unknown }>(rpc, {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionReceipt",
      params: [hash],
    });
    if (error) throw new Error(`Base RPC: ${JSON.stringify(error)}`);
    return result;
  },
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const g = args.indexOf("--gate");
  const gate = g >= 0 ? args.splice(g, 2)[1] : process.env.PAYGATE;
  const path = args[0];
  if (!path || !gate) {
    console.error("usage: bun run verify-order <receipt.json> --gate <paygate account>   (or PAYGATE=<account>)");
    process.exit(2);
  }
  const lines = await checkReceipt(JSON.parse(readFileSync(path, "utf8")) as Receipt, realReads, gate);
  console.log(lines.map((l) => l.line).join("\n"));
  const fails = lines.filter((l) => !l.ok).length;
  console.log(
    `\n${fails ? `${fails} FAIL` : "no FAIL"} · ${lines.filter((l) => l.line.startsWith("PASS")).length} PASS`,
  );
  console.log("A PASS does not prove delivery of the goods or the invoice: neither is checked.");
  process.exit(fails ? 1 : 0);
}
