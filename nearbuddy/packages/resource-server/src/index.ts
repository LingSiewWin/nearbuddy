// A paid API speaking x402 V2 over HTTP with the NearBuddy scheme.
// GET /quote?pair=NEAR/USD
//   -> 402 + PAYMENT-REQUIRED: base64(PaymentRequired{accepts:[{scheme:"nearbuddy-iou", network:"near:testnet", ...}]})
//   retry with PAYMENT-SIGNATURE: base64(PaymentPayload{accepted, payload: SignedIou})
//   -> 200 + PAYMENT-RESPONSE: base64(SettlementResponse)   (data in body)
import { createServer } from "node:http";
import {
  decodeHeader,
  encodeHeader,
  HEADERS,
  NETWORK,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  SCHEME,
  type SettlementResponse,
  type VerifyRequest,
  type VerifyResponse,
  X402_VERSION,
} from "../../protocol/src/x402.ts";

const PAYEE = process.env.API_ID ?? "nearbuddy-api.testnet";
const PORT = Number(process.env.API_PORT ?? 4010);
const SOLVER_URL = process.env.SOLVER_URL ?? "http://127.0.0.1:4020"; // the solver is our x402 facilitator
const PRICE = process.env.API_PRICE_YOCTO ?? "50000000000000000000"; // 0.00005 NEAR per call
const CONTRACT = process.env.NEARBUDDY_CONTRACT ?? "nearbuddy-vault.testnet";

const requirements: PaymentRequirements = {
  scheme: SCHEME,
  network: NETWORK,
  amount: PRICE,
  asset: "NEAR",
  payTo: PAYEE,
  maxTimeoutSeconds: 3600,
  extra: { contract: CONTRACT, paymentFlow: "authorization" },
};
const paymentRequired = (url: string, error?: string): PaymentRequired => ({
  x402Version: X402_VERSION,
  error,
  resource: { url, description: "spot price quote", mimeType: "application/json", serviceName: "nearbuddy-quotes" },
  accepts: [requirements],
});

let served = 0;
function priceOf(pair: string) {
  // deterministic fake quote; the product here is the payment rail, not the data
  const base = { "NEAR/USD": 3.21, "BTC/USD": 97_410, "ETH/USD": 3_380 }[pair] ?? 1;
  return +(base * (1 + Math.sin(Date.now() / 7_000) * 0.002)).toFixed(4);
}
const sameTerms = (a: PaymentRequirements) =>
  a.scheme === SCHEME && a.network === NETWORK && a.payTo === PAYEE && BigInt(a.amount) >= BigInt(PRICE);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/quote") {
    res.writeHead(404);
    return res.end();
  }
  const deny = (error: string, status = 402) => {
    res.writeHead(status, {
      "content-type": "application/json",
      [HEADERS.required]: encodeHeader(paymentRequired(url.href, error)),
    });
    res.end(JSON.stringify({ error }));
  };
  const sig = req.headers[HEADERS.signature];
  if (!sig || Array.isArray(sig)) return deny("payment required");
  let pp: PaymentPayload;
  try {
    pp = decodeHeader<PaymentPayload>(sig);
  } catch {
    return deny("malformed PAYMENT-SIGNATURE", 400);
  }
  if (pp.x402Version !== X402_VERSION || !sameTerms(pp.accepted)) return deny("accepted terms do not match");
  if (pp.payload.iou.payee !== PAYEE || BigInt(pp.payload.iou.amount) < BigInt(PRICE))
    return deny("iou does not match terms");

  // Facilitator step: the solver verifies and underwrites. This server never reads chain state itself.
  const vreq: VerifyRequest = { x402Version: X402_VERSION, paymentPayload: pp, paymentRequirements: requirements };
  const v = (await (
    await fetch(`${SOLVER_URL}/verify`, { method: "POST", body: JSON.stringify(vreq) })
  ).json()) as VerifyResponse;
  if (!v.isValid) return deny(`solver declined: ${v.invalidReason}`);

  served++;
  const settlement: SettlementResponse = {
    success: true,
    payer: pp.payload.iou.owner,
    transaction: "",
    network: NETWORK,
    amount: pp.payload.iou.amount,
    extra: { status: "underwritten", solver: v.extra?.solver, nonce: pp.payload.iou.nonce },
  };
  const pair = url.searchParams.get("pair") ?? "NEAR/USD";
  res.writeHead(200, { "content-type": "application/json", [HEADERS.response]: encodeHeader(settlement) });
  res.end(JSON.stringify({ pair, price: priceOf(pair), ts: Date.now(), served }));
}).listen(PORT, () =>
  console.log(
    `[api] ${PAYEE} listening on :${PORT}, x402 v2 scheme ${SCHEME} on ${NETWORK}, ${PRICE} yocto/call, facilitator ${SOLVER_URL}`,
  ),
);
