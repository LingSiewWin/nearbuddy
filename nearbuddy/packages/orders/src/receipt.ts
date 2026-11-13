import type { TeeProof } from "../../protocol/src/intent.ts";
import type { Decision } from "./intake.ts";

/** A `Decision` as stored in a receipt file: JSON has no bigint, so `maxPriceUsdc` is a decimal string of base units. */
export type StoredDecision =
  | Exclude<Decision, { action: "buy" }>
  | (Omit<Extract<Decision, { action: "buy" }>, "maxPriceUsdc"> & { maxPriceUsdc: string });

export interface Receipt {
  id: string;
  createdAt: string;
  sentence: string;
  owner: string;
  model: string;
  request_b64: string;
  response_b64: string;
  proof: TeeProof;
  decision: StoredDecision;
  rail: string;
  invoiceId: string;
  priceUsdc: string;
  payer: string;
  gate: string;
  near: { deposit?: string; login?: string; payment?: string }; // tx hashes
  baseTx?: string;
  status: "delivered" | "refused" | "asked" | "failed";
  reason?: string;
  legsMs: Record<string, number>;
}
