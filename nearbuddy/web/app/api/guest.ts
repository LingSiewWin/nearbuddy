// The server side of guest accounts (lib/guest.ts): what /api/guest accepts and how many accounts it will ask the
// faucet for. Pure, so the route only does the calls.
import { GUEST_NAME } from "../lib/guest";

/** An ed25519 public key as NEAR writes it: the prefix and 32 bytes in base58. */
const PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;
export const PER_ADDRESS = 3;
export const SITE_WIDE = 60;
export const WINDOW_S = 3600;

/** The request's account and key when both are well formed, else null. */
export function checkGuest(body: unknown): { accountId: string; publicKey: string } | null {
  const b = (body ?? {}) as Record<string, unknown>;
  return typeof b.accountId === "string" &&
    typeof b.publicKey === "string" &&
    GUEST_NAME.test(b.accountId) &&
    PUBLIC_KEY.test(b.publicKey)
    ? { accountId: b.accountId, publicKey: b.publicKey }
    : null;
}

/** Whether one more account may be made for this address now. `bump` adds one to a counter that expires after
 *  WINDOW_S and answers its new value. The faucet is a shared public service: this keeps one visitor, or a script,
 *  from draining it through us. */
export async function allow(address: string, bump: (key: string) => Promise<number>): Promise<boolean> {
  if ((await bump(`nb:guest:ip:${address}`)) > PER_ADDRESS) return false;
  return (await bump("nb:guest:all")) <= SITE_WIDE;
}
