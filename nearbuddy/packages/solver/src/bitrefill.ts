// Bitrefill x402 client: buy a gift card or voucher with USDC on Base, no account and no API key.
// Routes and field names from https://api.bitrefill.com/openapi.json ("Bitrefill x402" 1.0.0, read 2026-11-13).
// A free sign-in-with-x session token removes the per-call micro-fees; only `payInvoice` moves money.
import { ExactEvmScheme } from "@x402/evm";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { createPublicClient, erc20Abi, http } from "viem";
import { base } from "viem/chains";

const API = process.env.BITREFILL_X402_URL ?? "https://api.bitrefill.com/x402";
const BASE = "eip155:8453";
export const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Whoever holds the USDC on Base: the paygate contract (`gateSigner`). */
export type Payer = { readonly address: `0x${string}` } & Parameters<typeof createSIWxPayload>[1] &
  ConstructorParameters<typeof ExactEvmScheme>[0];

export function usdcBalance(owner: `0x${string}`): Promise<bigint> {
  const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC) });
  return client.readContract({ address: USDC_BASE_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) throw new Error(`bitrefill ${what} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/** Sign Bitrefill's sign-in-with-x challenge as the payer. Returns the X-Access-Token. Costs nothing. */
export async function connect(payer: Payer): Promise<string> {
  const url = `${API}/connect`;
  const first = await fetch(url, { method: "POST" });
  if (first.status !== 402) throw new Error(`bitrefill connect: expected a 402 challenge, got ${first.status}`);
  const challenge = (await first.json()) as { extensions?: Record<string, { info?: Record<string, unknown> }> };
  const info = challenge.extensions?.["sign-in-with-x"]?.info;
  if (!info) throw new Error("bitrefill connect: no sign-in-with-x challenge in the 402");
  const complete = { ...info, chainId: BASE, type: "eip191" } as Parameters<typeof createSIWxPayload>[0];
  const header = encodeSIWxHeader(await createSIWxPayload(complete, payer, url));
  const body = await json(await fetch(url, { method: "POST", headers: { "SIGN-IN-WITH-X": header } }), "connect");
  if (typeof body.token !== "string") throw new Error("bitrefill connect: no token in the response");
  return body.token;
}

/** Search gift cards by text in one country (ISO alpha-2, e.g. "MY"). Free with a session token. */
export async function searchGiftCards(token: string, q: string, country: string): Promise<unknown> {
  const query = new URLSearchParams({ q, country });
  return json(
    await fetch(`${API}/gift-cards/search?${query}`, { headers: { "X-Access-Token": token } }),
    "gift-cards/search",
  );
}

/** One product with its packages, by slug. Free with a session token. */
export async function productDetail(token: string, slug: string): Promise<unknown> {
  const query = new URLSearchParams({ slug });
  return json(
    await fetch(`${API}/products/detail?${query}`, { headers: { "X-Access-Token": token } }),
    "products/detail",
  );
}

export interface Invoice {
  invoice_id: string;
  /** Locked price in USDC base units (6 decimals). */
  price_usdc: string;
}

/** Create a price-locked invoice for one package of one product. Free with a session token. */
export async function createInvoice(token: string, productId: string, packageValue: string): Promise<Invoice> {
  const body = await json(
    await fetch(`${API}/invoice/create`, {
      method: "POST",
      headers: { "X-Access-Token": token, "content-type": "application/json" },
      body: JSON.stringify({ items: [{ product_id: productId, package_value: packageValue }] }),
    }),
    "invoice/create",
  );
  if (typeof body.invoice_id !== "string" || typeof body.price_usdc !== "string")
    throw new Error(`bitrefill invoice/create: unexpected body ${JSON.stringify(body).slice(0, 200)}`);
  return { invoice_id: body.invoice_id, price_usdc: body.price_usdc };
}

export interface PaymentOption {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}

/** Pick the USDC-on-Base option from a 402 challenge and refuse any amount other than the invoice price.
 *  This is the spend limit: the payer signs for `price` exactly or for nothing. */
export function pickBaseUsdc<T extends PaymentOption>(options: readonly T[], price: bigint): T {
  const option = options.find(
    (o) => o.network === BASE && o.asset.toLowerCase() === USDC_BASE_ADDRESS.toLowerCase() && o.scheme === "exact",
  );
  if (!option) throw new Error("the challenge offers no exact USDC payment on Base");
  if (BigInt(option.amount) !== price)
    throw new Error(`the challenge asks for ${option.amount}, the invoice price is ${price}`);
  return option;
}

/** Pay the invoice over x402 (EIP-3009 authorization signed by `payer`; the facilitator pays the gas).
 *  Returns the settlement transaction hash on Base. */
export async function payInvoice(payer: Payer, invoice: Invoice): Promise<string> {
  const price = BigInt(invoice.price_usdc);
  const pay = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: BASE, client: new ExactEvmScheme(payer) }],
    // The library's own ceiling is $1 per payment; set it to this invoice. `pickBaseUsdc` checks the exact amount.
    spendControls: { maxAmountPerPayment: `$${Number(price) / 1e6}` },
    paymentRequirementsSelector: (_version, options) => pickBaseUsdc(options, price),
  });
  const res = await pay(`${API}/invoice/pay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invoice_id: invoice.invoice_id }),
  });
  await json(res, "invoice/pay");
  const receipt = res.headers.get("PAYMENT-RESPONSE");
  if (!receipt) throw new Error("bitrefill invoice/pay: accepted but no PAYMENT-RESPONSE header");
  const settled = decodePaymentResponseHeader(receipt);
  if (!settled.success) throw new Error(`bitrefill invoice/pay: settlement not successful: ${JSON.stringify(settled)}`);
  return settled.transaction;
}

/** Poll until the invoice is complete (the body then carries `redemption_info`, the voucher: treat it as a secret)
 *  or reaches another final status. */
export async function waitForInvoice(
  token: string,
  invoiceId: string,
  log: (s: string) => void = () => {},
): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  for (let i = 0; i < 90; i++) {
    const body = await json(
      await fetch(`${API}/invoice/status?invoice_id=${encodeURIComponent(invoiceId)}`, {
        headers: { "X-Access-Token": token },
      }),
      "invoice/status",
    );
    log(`invoice ${body.status} (${Date.now() - t0} ms after payment)`);
    if (body.status !== "payment_confirmed" && body.status !== "payment_detected" && body.status !== "pending")
      return body;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`invoice ${invoiceId} not final after 3 minutes`);
}
