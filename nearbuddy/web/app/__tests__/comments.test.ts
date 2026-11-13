// Comments: what text is accepted, the session a signed NEP-413 login buys, and the login check itself, run with a
// real ed25519 signature and a stub of the one chain read it makes.
import { expect, test } from "bun:test";
import { Account, KeyPair, KeyPairSigner, keyToImplicitAddress } from "near-api-js";
import { signMessage } from "near-api-js/nep413";
import { login, openSession, sealSession } from "../api/comments";
import { clean, freshNonce, loginMessage, MAX_COMMENT, newNonce } from "../lib/comments";

test("a comment is trimmed and kept as written", () => {
  expect(clean("  Qwen is fading again  ")).toEqual({ text: "Qwen is fading again" });
  expect(clean('<img src=x onerror="alert(1)">')).toEqual({ text: '<img src=x onerror="alert(1)">' });
});

test("empty, too long, or carrying control or invisible characters is refused with the reason", () => {
  expect(clean("   ")).toEqual({ error: "comment empty" });
  expect(clean("x".repeat(MAX_COMMENT + 1))).toEqual({ error: `comment too long: at most ${MAX_COMMENT} characters` });
  expect(clean("x".repeat(MAX_COMMENT))).toEqual({ text: "x".repeat(MAX_COMMENT) });
  expect(clean("line\nbreak")).toEqual({ error: "comment has a control or invisible character" });
  expect(clean("zero​width")).toEqual({ error: "comment has a control or invisible character" });
  expect(clean(42)).toEqual({ error: "comment must be text" });
});

test("a session opens for its account until it expires, and not after a change", () => {
  const t = sealSession("alice.testnet", 2_000, "k");
  expect(openSession(t, "k", 1_999)).toBe("alice.testnet");
  expect(openSession(t, "k", 2_000)).toBeNull();
  expect(openSession(t, "other key", 1_000)).toBeNull();
  expect(openSession(t.replace("alice", "mallo"), "k", 1_000)).toBeNull();
  expect(openSession("garbage", "k", 1_000)).toBeNull();
  expect(openSession(undefined, "k", 1_000)).toBeNull();
});

test("a nonce is fresh for five minutes from the time it carries", () => {
  const n = newNonce(1_000_000);
  expect(n.length).toBe(32);
  expect(freshNonce(n, 1_000_000 + 299_000)).toBe(true);
  expect(freshNonce(n, 1_000_000 + 301_000)).toBe(false);
  expect(freshNonce(n, 1_000_000 - 61_000)).toBe(false); // from the future
  expect(freshNonce(new Uint8Array(31), 1_000_000)).toBe(false);
});

const HOST = "nearbuddy.vercel.app";
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
/** A real signed login for a fresh implicit account, as a wallet would post it. */
async function signed(nowMs: number, message = loginMessage(HOST)) {
  const kp = KeyPair.fromRandom("ed25519");
  const accountId = keyToImplicitAddress(kp.getPublicKey());
  const nonce = newNonce(nowMs);
  const s = await signMessage({
    signerAccount: new Account(accountId, null as never, new KeyPairSigner(kp)),
    payload: { message, recipient: HOST, nonce },
  });
  return { accountId, publicKey: kp.getPublicKey().toString(), signature: b64(s.signature), nonce: b64(nonce) };
}
/** The chain as the login check reads it: a key is a full-access key of the implicit account it derives, and of no
 *  other account. */
const owns = {
  viewAccessKey: async ({ accountId, publicKey }: { accountId: string; publicKey: string }) => {
    if (keyToImplicitAddress(publicKey) !== accountId) throw new Error("access key does not exist");
    return { permission: "FullAccess", nonce: 1n };
  },
} as never;
const used = () => {
  const seen = new Set<string>();
  return async (n: string) => {
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  };
};

test("a login signed for this site by the account's key is accepted once", async () => {
  const body = await signed(5_000_000);
  const once = used();
  expect(await login(body, HOST, 5_000_100, owns, once)).toEqual({ account: body.accountId });
  expect(await login(body, HOST, 5_000_200, owns, once)).toEqual({ error: "this sign-in was already used" });
});

test("a login is refused when stale, signed for another site, or tampered with", async () => {
  const body = await signed(5_000_000);
  expect(await login(body, HOST, 5_000_000 + 400_000, owns, used())).toEqual({
    error: "this sign-in expired: try again",
  });
  expect(await login(body, "evil.example", 5_000_100, owns, used())).toEqual({
    error: "the signature does not verify",
  });
  const other = await signed(5_000_000);
  expect(await login({ ...body, accountId: other.accountId }, HOST, 5_000_100, owns, used())).toEqual({
    error: "the signature does not verify",
  });
  expect(await login({ ...body, signature: "AAAA" }, HOST, 5_000_100, owns, used())).toEqual({
    error: "the signature does not verify",
  });
  expect(await login({ accountId: 1 }, HOST, 5_000_100, owns, used())).toEqual({ error: "bad sign-in" });
});

test("a function-call key is not enough to sign in", async () => {
  const body = await signed(5_000_000);
  const limited = { viewAccessKey: async () => ({ permission: { FunctionCall: {} }, nonce: 1n }) } as never;
  expect(await login(body, HOST, 5_000_100, limited, used())).toEqual({ error: "the signature does not verify" });
});
