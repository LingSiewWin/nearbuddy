// A rail is one way to pay a merchant. Sprint 1 has one: Bitrefill vouchers over x402.
import type { Payer } from "../../solver/src/bitrefill.ts";

export interface Package {
  value: string;
  currency: string;
  priceUsd: string;
}
export interface Candidate {
  productId: string;
  /** Display-only catalogue text, reduced to `[\w .&'-]` and 60 characters. Plain words survive that cleaning,
   *  so it can still read as an instruction: never put it in a model prompt. */
  name: string;
  country: string;
  packages: Package[];
}
export interface RailInvoice {
  rail: string;
  id: string;
  priceUsdc: bigint;
}
/** `secret` is the provider's whole status body (the voucher): it never leaves `.secrets/`. */
export interface Delivery {
  status: string;
  delivered: boolean;
  secret: unknown;
}
export interface Rail {
  name: string;
  /** Sign in. */
  open(payer: Payer): Promise<void>;
  /** At most 5 candidates, sanitized. */
  search(query: string, country: string): Promise<Candidate[]>;
  invoice(productId: string, packageValue: string): Promise<RailInvoice>;
  /** Returns the settlement transaction hash. */
  pay(payer: Payer, invoice: RailInvoice): Promise<string>;
  wait(invoice: RailInvoice, log?: (s: string) => void): Promise<Delivery>;
}

const MAX_CANDIDATES = 5;
const ID = /^[a-z0-9_-]{1,64}$/;
const TOKEN = /^[\w.-]{1,16}$/;
const PRICE = /^\d{1,9}(\.\d{1,9})?$/;

const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;

/** Product details from a provider go to the model that picks the purchase. Keep only fields we can bound:
 *  a checked id, a name cut to `[\w .&'-]` and 60 characters, and packages. Free text (descriptions,
 *  instructions, notes, reviews) is never copied, so it cannot carry instructions. */
export function sanitize(raw: unknown): Candidate[] {
  if (!Array.isArray(raw)) return [];
  const out: Candidate[] = [];
  for (const item of raw) {
    const d = rec(item);
    if (!d || typeof d.id !== "string" || !ID.test(d.id)) continue;
    const name = String(d.name ?? "")
      .replace(/[^\w .&'-]/g, " ")
      .replace(/ +/g, " ")
      .trim()
      .slice(0, 60);
    if (!name) continue;
    const packages: Package[] = [];
    for (const p of Array.isArray(d.packages) ? d.packages : []) {
      const q = rec(p);
      if (
        typeof q?.package_value === "string" &&
        typeof q.package_currency === "string" &&
        typeof q.payment_price === "string" &&
        TOKEN.test(q.package_value) &&
        TOKEN.test(q.package_currency) &&
        PRICE.test(q.payment_price)
      )
        packages.push({ value: q.package_value, currency: q.package_currency, priceUsd: q.payment_price });
    }
    const country = typeof d.country_code === "string" && TOKEN.test(d.country_code) ? d.country_code : "";
    out.push({ productId: d.id, name, country, packages });
    if (out.length === MAX_CANDIDATES) break;
  }
  return out;
}

// ponytail: Sprint 1 has one rail, so this is the first one; route by country when a second rail exists.
export function pickRail(rails: Rail[], _country: string): Rail {
  const rail = rails[0];
  if (!rail) throw new Error("no rail available");
  return rail;
}
