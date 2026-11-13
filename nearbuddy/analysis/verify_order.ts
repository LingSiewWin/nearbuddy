// Re-check one order receipt from public sources only, the way a stranger would: the receipt file, the NEAR
// transaction that signed the payment (FastNEAR tx API) and the Base transaction that moved the USDC (eth_getTransactionReceipt).
// Prints PASS / FAIL / SKIP per line and exits 1 on any FAIL. Sends nothing, spends nothing.
//   bun run verify-order path/to/receipt.json
// A NEAR outcome is read from the contract receipt's own status, never the transaction-level one (see verify_duel.ts).
// Env: FASTNEAR_TX_API (default the network's FastNEAR tx API), BASE_RPC (default https://mainnet.base.org).
import "../packages/protocol/src/env.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Receipt } from "../packages/orders/src/receipt.ts";
import { b64, hex } from "../packages/protocol/src/index.ts";
import { teeText, verify } from "../packages/protocol/src/intent.ts";
import { NET } from "../packages/protocol/src/network.ts";
import type { Tx } from "./verify_duel.ts";

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface BaseReceipt {
  status: string; // "0x1" success
  logs: { address: string; topics: string[]; data: string }[];
}
/** The two public reads. The CLI wires real ones, the tests wire fakes. */
export interface ChainReads {
  nearTx(hash: string): Promise<Tx>;
  baseReceipt(hash: string): Promise<BaseReceipt | null>;
}
export type Line = { line: string; ok: boolean };

const sha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const dec = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(b);
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const json = (s: string): unknown => JSON.parse(s);
const need = (ok: boolean, msg: string) => {
  if (!ok) throw new Error(msg);
};

/** "1.40" to 1400000n (6 decimals), the same rule the intake parser applies. */
function usdcUnits(s: unknown): bigint {
  const m = typeof s === "string" ? /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(s) : null;
  if (!m) throw new Error(`max_price_usdc ${JSON.stringify(s)} is not a decimal with at most 6 digits after the point`);
  return BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** The model's one JSON object, read from `choices[0].message.content` of the response bytes. */
function modelObject(response: Uint8Array): Record<string, unknown> {
  const content = (json(dec(response)) as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message
    ?.content;
  need(typeof content === "string", "response has no choices[0].message.content text");
  const o = json((content as string).trim());
  need(isObj(o), "model content is not one JSON object");
  return o as Record<string, unknown>;
}

/** The sentence the request carries: the user message's content is JSON `{ sentence, candidates }`. */
function requestSentence(request: Uint8Array): unknown {
  const body = json(dec(request)) as { messages?: { role?: string; content?: unknown }[] };
  const user = body?.messages?.find((m) => m.role === "user");
  need(typeof user?.content === "string", "request has no user message");
  const o = json(user?.content as string);
  need(isObj(o), "user message is not a JSON object");
  return (o as Record<string, unknown>).sentence;
}

const okStatus = (st: unknown) => isObj(st) && ("SuccessValue" in st || "SuccessReceiptId" in st);

/** Every function-call receipt this tx ran on `gate`, with the receipt's own outcome. */
function gateCalls(tx: Tx, gate: string) {
  return tx.receipts.flatMap((r) => {
    const a = r.receipt.receipt.Action;
    if (!a || r.receipt.receiver_id !== gate) return [];
    return a.actions.flatMap((x) => {
      const fc = typeof x === "object" ? x.FunctionCall : undefined;
      if (!fc) return [];
      return [
        {
          method: fc.method_name,
          args: fc.args,
          ok: okStatus(r.execution_outcome.outcome.status),
          logs: r.execution_outcome.outcome.logs,
        },
      ];
    });
  });
}

export async function checkReceipt(r: Receipt, chain: ChainReads): Promise<Line[]> {
  const out: Line[] = [];
  /** One line per check. `fn` returns the detail, throws on FAIL, or returns `{ skip }`. */
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
    out.push({ line: `${res.padEnd(4)}  ${name.padEnd(24)} ${detail}`, ok: res !== "FAIL" });
  };

  const request = (() => {
    try {
      return b64.strict(r.request_b64);
    } catch {
      return new Uint8Array();
    }
  })();
  const response = (() => {
    try {
      return b64.strict(r.response_b64);
    } catch {
      return new Uint8Array();
    }
  })();

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
    return `signed by ${hex(b64.strict(r.proof.signer)).slice(0, 12)}... over model:req:resp`;
  });

  await run("decision", () => {
    const o = modelObject(response);
    const d = r.decision;
    need(o.action === d.action, `response action ${JSON.stringify(o.action)}, receipt ${d.action}`);
    if (d.action === "buy") {
      need(o.product_id === d.productId, `response product_id ${JSON.stringify(o.product_id)}, receipt ${d.productId}`);
      need(
        o.package_value === d.packageValue,
        `response package_value ${JSON.stringify(o.package_value)}, receipt ${d.packageValue}`,
      );
      need(
        usdcUnits(o.max_price_usdc) === BigInt(d.maxPriceUsdc),
        `response limit ${String(o.max_price_usdc)} USDC, receipt ${d.maxPriceUsdc} base units`,
      );
    } else if (d.action === "refuse") need(o.reason === d.reason, "response reason differs from the receipt");
    else need(o.question === d.question, "response question differs from the receipt");
    return `response says ${d.action}`;
  });

  await run("sentence", () => {
    need(requestSentence(request) === r.sentence, "the request's sentence is not the receipt's sentence");
    return "the request carries the receipt's sentence";
  });

  // payment: the NEAR tx first (it yields `to`), then the Base tx
  let paid: { to: string; value: bigint } | undefined;
  const hash = r.near.payment;
  if (!hash) {
    await run("near-payment", () =>
      r.status === "delivered"
        ? Promise.reject(new Error("delivered receipt has no NEAR payment tx"))
        : { skip: `no payment (${r.status})` },
    );
  } else {
    let tx: Tx | undefined;
    await run("near-payment-tx", async () => {
      tx = await chain.nearTx(hash);
      const calls = gateCalls(tx, r.gate).filter((c) => c.method === "sign_payment");
      need(calls.length === 1, `${calls.length} sign_payment calls on ${r.gate} in the tx, want 1`);
      need((calls[0] as { ok: boolean }).ok, "the sign_payment receipt did not succeed");
      return `sign_payment on ${r.gate} succeeded`;
    });
    let args: Record<string, unknown> = {};
    await run("near-payment-args", () => {
      const call = tx ? gateCalls(tx, r.gate).find((c) => c.method === "sign_payment") : undefined;
      need(!!call, "no sign_payment call to read");
      const a = json(Buffer.from((call as { args: string }).args, "base64").toString());
      need(isObj(a) && isObj(a.decision), "sign_payment arguments carry no decision");
      args = a as Record<string, unknown>;
      const p = args.decision as Record<string, unknown>;
      need(typeof args.to === "string" && /^0x[0-9a-fA-F]{40}$/.test(args.to), "to is not an address");
      need(typeof args.value === "string" && /^\d+$/.test(args.value), "value is not a decimal string");
      paid = { to: (args.to as string).toLowerCase(), value: BigInt(args.value as string) }; // later checks run on it even if the next ones fail
      need(args.owner === r.owner, `owner ${JSON.stringify(args.owner)}, receipt ${r.owner}`);
      need(args.model_id === r.model, `model_id ${JSON.stringify(args.model_id)}, receipt ${r.model}`);
      for (const k of ["request_hash", "response_hash", "signer", "signature"] as const)
        need(p[k] === r.proof[k], `decision.${k} differs from the receipt's proof`);
      return `arguments carry the proof hashes, to ${args.to}, value ${args.value}`;
    });
    await run("near-payment-event", () => {
      need(!!paid, "no arguments to compare");
      const events = (tx ? gateCalls(tx, r.gate) : [])
        .filter((c) => c.ok)
        .flatMap((c) => c.logs)
        .filter((l) => l.startsWith("EVENT_JSON:"))
        .map(
          (l) =>
            json(l.slice("EVENT_JSON:".length)) as {
              standard?: string;
              event?: string;
              data?: Record<string, unknown>;
            },
        );
      const e = events.find((x) => x.standard === "nearbuddy-paygate" && x.event === "payment_signed");
      need(!!e?.data, "the gate logged no payment_signed event (the MPC network may not have signed)");
      const d = e?.data as Record<string, unknown>;
      const want = {
        owner: r.owner,
        to: (paid as { to: string }).to,
        value: String((paid as { value: bigint }).value),
        model: r.model,
        request_hash: hex(b64.strict(r.proof.request_hash)),
        response_hash: hex(b64.strict(r.proof.response_hash)),
      };
      for (const [k, v] of Object.entries(want)) need(d[k] === v, `event ${k} is ${JSON.stringify(d[k])}, want ${v}`);
      return "the gate logged payment_signed for the same owner, to, value, model and hashes";
    });

    await run("amount", () => {
      need(!!paid, "no value from the NEAR payment");
      const value = (paid as { value: bigint }).value;
      need(value === BigInt(r.priceUsdc), `value ${value} differs from priceUsdc ${r.priceUsdc}`);
      need(r.decision.action === "buy", `decision is ${r.decision.action}, a payment needs buy`);
      const limit = BigInt((r.decision as { maxPriceUsdc: string }).maxPriceUsdc);
      need(value <= limit, `value ${value} is above the decision's limit ${limit}`);
      return `value ${value} equals priceUsdc and is within the limit ${limit} (USDC base units)`;
    });

    await run("base-transfer", async () => {
      need(!!r.baseTx, "receipt has no Base tx");
      need(!!paid, "no to/value from the NEAR payment");
      const { to, value } = paid as { to: string; value: bigint };
      const rc = await chain.baseReceipt(r.baseTx as string);
      need(!!rc, "Base tx not found");
      need((rc as BaseReceipt).status === "0x1", `Base tx status ${(rc as BaseReceipt).status}`);
      const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
      const hit = (rc as BaseReceipt).logs.some(
        (l) =>
          l.address.toLowerCase() === BASE_USDC.toLowerCase() &&
          l.topics[0] === TRANSFER &&
          l.topics[1]?.toLowerCase() === pad(r.payer) &&
          l.topics[2]?.toLowerCase() === pad(to) &&
          /^0x[0-9a-f]+$/i.test(l.data) &&
          BigInt(l.data) === value,
      );
      need(hit, `no USDC Transfer of ${value} from ${r.payer} to ${to} in the Base tx`);
      return `USDC Transfer of ${value} from ${r.payer} to ${to}`;
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
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun run verify-order <receipt.json>");
    process.exit(2);
  }
  const lines = await checkReceipt(JSON.parse(readFileSync(path, "utf8")) as Receipt, realReads);
  console.log(lines.map((l) => l.line).join("\n"));
  const fails = lines.filter((l) => !l.ok).length;
  console.log(
    `\n${fails ? `${fails} FAIL` : "no FAIL"} · ${lines.filter((l) => l.line.startsWith("PASS")).length} PASS`,
  );
  process.exit(fails ? 1 : 0);
}
