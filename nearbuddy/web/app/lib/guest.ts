// A guest account: a throwaway NEAR testnet account for a visitor with no wallet. The browser makes the key pair and
// keeps the private key (localStorage); only the public key goes to this site's /api/guest, which asks NEAR's public
// testnet faucet service to create and fund the account. It then signs like any account: calls and NEP-413 messages,
// with no wallet window. Testnet only: there is no faucet on mainnet. The key is as safe as this browser profile, so
// the page calls the account temporary and lets the visitor export or drop it.
// This file is the record only (no NEAR library), so every page can ask "is there a guest?" cheaply; making the
// account and signing live in guest-signer.ts, loaded when a guest is made or signs.
export type Guest = { accountId: string; privateKey: string };
type Box = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The only names /api/guest will create: nobody can use it to take a name someone would want. */
export const GUEST_NAME = /^nb-guest-[a-z0-9]{10}\.testnet$/;
const KEY = "nb:guest";
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newGuestName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `nb-guest-${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("")}.testnet`;
}

const box = (): Box | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage blocked
  }
};

/** The guest this browser holds, or null. */
export function recall(storage: Box | null = box()): Guest | null {
  try {
    const g = JSON.parse(storage?.getItem(KEY) ?? "null") as Partial<Guest> | null;
    return g && typeof g.accountId === "string" && GUEST_NAME.test(g.accountId) && typeof g.privateKey === "string"
      ? { accountId: g.accountId, privateKey: g.privateKey }
      : null;
  } catch {
    return null;
  }
}
export const remember = (g: Guest, storage: Box | null = box()) => storage?.setItem(KEY, JSON.stringify(g));
export const forget = (storage: Box | null = box()) => storage?.removeItem(KEY);
