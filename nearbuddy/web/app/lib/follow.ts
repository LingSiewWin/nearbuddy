// The follow call the arena accepts since deploy 15, shared by the drawer (a person copies it) and the MCP tool
// follow_transaction (an agent signs it). Deploy 15 fills a mandate in USDC and refuses min_out_per_near 0: a fill
// must return at least amount_in * min_out_per_near / 10^24 USDC units, so the floor is USDC units (6 decimals)
// per whole NEAR. Both callers price it at 95% of NEAR's Coinbase price, as the demo does from its 1Click quote.

/** USDC on NEAR, the token a deploy-15 fill pays out (the solver's oneclick.ts USDC_NEAR). */
export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const TICKER = "https://api.exchange.coinbase.com/products/NEAR-USD/ticker";

/** NEAR's last Coinbase trade in USD, or null when Coinbase does not answer within 5 s. */
export async function nearUsd(): Promise<number | null> {
  try {
    const r = await fetch(TICKER, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    const p = Number(((await r.json()) as { price?: string }).price);
    return p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** USDC units a fill must return per NEAR: `keep` of the USD price, floored, never 0 (the contract refuses 0). */
export const priceFloor = (usd: number, keep = 0.95) => String(Math.max(1, Math.floor(usd * keep * 1e6)));

/** NEAR to a yoctoNEAR string, exact to 4 decimals. */
export const yocto = (near: number) => (BigInt(Math.round(near * 1e4)) * 10n ** 20n).toString();

export type Terms = { capNear: number; allowanceNear: number; days: number; floor: string | null; now: number };

/** The `follow` args: a per-fill cap, a total allowance, USDC fills, an expiry and the price floor. */
export const followArgs = (agentPk: string, t: Terms) => ({
  agent_pk: agentPk,
  mandate: {
    per_tx_cap: yocto(t.capNear),
    allowance: yocto(t.allowanceNear),
    spent: "0",
    allowed_tokens: [USDC],
    expires_at: String(BigInt(Math.round(t.now + t.days * 86_400_000)) * 1_000_000n),
    revoked: false,
    min_out_per_near: t.floor ?? "<USDC units per NEAR>",
  },
});
