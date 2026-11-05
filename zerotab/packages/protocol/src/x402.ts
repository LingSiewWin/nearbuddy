// x402 V2 wire shapes (https://github.com/x402-foundation/x402, specs/x402-specification-v2.md + transports-v2/http.md),
// with ZeroTab as a custom scheme. Only the fields we use are typed.
import type { SignedIou } from "./index.ts";

export const X402_VERSION = 2;
export const SCHEME = "zerotab-iou";          // custom scheme: agent-signed IOU, solver-underwritten, batch-settled
export const NETWORK = "near:testnet";        // CAIP-2
export const HEADERS = { required: "payment-required", signature: "payment-signature", response: "payment-response" } as const;

export interface PaymentRequirements {
  scheme: string; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number;
  extra?: { contract: string; paymentFlow: "authorization" };
}
export interface PaymentRequired {
  x402Version: number; error?: string;
  resource: { url: string; description?: string; mimeType?: string; serviceName?: string };
  accepts: PaymentRequirements[];
}
export interface PaymentPayload {
  x402Version: number; accepted: PaymentRequirements; payload: SignedIou;
}
export interface VerifyRequest { x402Version: number; paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements }
export interface VerifyResponse { isValid: boolean; payer?: string; invalidReason?: string; extra?: Record<string, unknown> }
export interface SettlementResponse { success: boolean; errorReason?: string; payer?: string; transaction: string; network: string; amount?: string; extra?: Record<string, unknown> }

export const encodeHeader = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
export const decodeHeader = <T>(s: string): T => JSON.parse(Buffer.from(s, "base64").toString()) as T;
