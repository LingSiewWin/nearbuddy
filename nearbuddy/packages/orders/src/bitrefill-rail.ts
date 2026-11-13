import type { Payer } from "../../solver/src/bitrefill.ts";
import * as live from "../../solver/src/bitrefill.ts";
import { type Candidate, type Delivery, type Rail, type RailInvoice, sanitize } from "./rail.ts";

/** The slice of the Bitrefill client this rail uses; tests inject a fake. */
export type BitrefillClient = Pick<
  typeof live,
  "connect" | "searchGiftCards" | "productDetail" | "createInvoice" | "payInvoice" | "waitForInvoice"
>;

/** A voucher is something: `redemption_info` present but null, "", {} or [] is not one. */
const hasVoucher = (v: unknown): boolean =>
  v !== null && v !== undefined && v !== "" && !(typeof v === "object" && Object.keys(v).length === 0);

export class BitrefillRail implements Rail {
  readonly name = "bitrefill";
  #token: string | undefined;

  constructor(private readonly client: BitrefillClient = live) {}

  #session(): string {
    if (!this.#token) throw new Error("rail not open");
    return this.#token;
  }

  async open(payer: Payer): Promise<void> {
    this.#token = await this.client.connect(payer);
  }

  async search(query: string, country: string): Promise<Candidate[]> {
    const token = this.#session();
    const found = (await this.client.searchGiftCards(token, query, country)) as { products?: { slug?: unknown }[] };
    const slugs = (found.products ?? []).flatMap((p) => (typeof p.slug === "string" ? [p.slug] : [])).slice(0, 5);
    return sanitize(await Promise.all(slugs.map((slug) => this.client.productDetail(token, slug))));
  }

  async invoice(productId: string, packageValue: string): Promise<RailInvoice> {
    const inv = await this.client.createInvoice(this.#session(), productId, packageValue);
    return { rail: this.name, id: inv.invoice_id, priceUsdc: BigInt(inv.price_usdc) };
  }

  pay(payer: Payer, invoice: RailInvoice): Promise<string> {
    return this.client.payInvoice(payer, { invoice_id: invoice.id, price_usdc: invoice.priceUsdc.toString() });
  }

  async wait(invoice: RailInvoice, log?: (s: string) => void): Promise<Delivery> {
    const body = await this.client.waitForInvoice(this.#session(), invoice.id, log);
    const status = String(body.status);
    return { status, delivered: status === "complete" && hasVoucher(body.redemption_info), secret: body };
  }
}
