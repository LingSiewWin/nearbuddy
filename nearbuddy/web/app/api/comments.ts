// The server side of comments (lib/comments.ts): the NEP-413 sign-in check, the session it buys (an HMAC-sealed
// account and expiry in an HttpOnly cookie) and the store (Upstash Redis through the Vercel integration, one capped
// list per match). Server only.
import { createHmac, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { Provider } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { freshNonce, loginMessage } from "../lib/comments";

export const COOKIE = "nb_session";
export const SESSION_MS = 7 * 24 * 3_600_000;
/** Comments kept per match, and for how long after the last one. */
export const KEEP = 200;
export const KEEP_S = 30 * 24 * 3600;

let redis: Redis | null | undefined;
/** The store, or null where the integration's variables are not set (comments are then off). */
export function store(): Redis | null {
  if (redis === undefined)
    redis = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN ? Redis.fromEnv() : null;
  return redis;
}
/** The key sessions are sealed with: derived from the store's token, so there is no second secret to manage. */
export const sessionKey = (): string | null =>
  process.env.KV_REST_API_TOKEN
    ? createHmac("sha256", process.env.KV_REST_API_TOKEN).update("nearbuddy comment sessions v1").digest("hex")
    : null;

const mac = (payload: string, key: string) => createHmac("sha256", key).update(payload).digest("base64url");

/** `account.expiry.mac`: an account id has no "." followed by digits and a dot at its end, so it parses one way. */
export const sealSession = (account: string, expMs: number, key: string): string =>
  `${account}.${expMs}.${mac(`${account}.${expMs}`, key)}`;

/** The account a sealed session is for, or null when it is missing, changed, sealed with another key or expired. */
export function openSession(token: string | undefined, key: string, nowMs: number): string | null {
  const m = /^(.+)\.(\d{1,16})\.([\w-]{43})$/.exec(token ?? "");
  if (!m) return null;
  const [, account, exp, sig] = m as unknown as [string, string, string, string];
  const want = Buffer.from(mac(`${account}.${exp}`, key));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return Number(exp) > nowMs ? account : null;
}

const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

/** Checks a wallet's signed sign-in: fresh, signed for `host` with this site's message by a full-access key of the
 *  account (one chain read), and not used before (`once` answers false for a nonce it has seen). */
export async function login(
  body: unknown,
  host: string,
  nowMs: number,
  provider: Provider,
  once: (nonce: string) => Promise<boolean>,
): Promise<{ account: string } | { error: string }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const { accountId, publicKey, signature, nonce } = b;
  if (
    typeof accountId !== "string" ||
    typeof publicKey !== "string" ||
    typeof signature !== "string" ||
    typeof nonce !== "string" ||
    !ACCOUNT.test(accountId) ||
    publicKey.length > 120 ||
    signature.length > 200 ||
    nonce.length > 60
  )
    return { error: "bad sign-in" };
  const n = bytes(nonce);
  if (!freshNonce(n, nowMs)) return { error: "this sign-in expired: try again" };
  try {
    await verifyMessage({
      signerAccountId: accountId,
      signerPublicKey: publicKey,
      signature: bytes(signature),
      payload: { message: loginMessage(host), recipient: host, nonce: n },
      provider,
    });
  } catch {
    return { error: "the signature does not verify" };
  }
  if (!(await once(nonce))) return { error: "this sign-in was already used" };
  return { account: accountId };
}

const cookieOf = (req: Request) =>
  req.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);

/** The Set-Cookie line for a session value: HttpOnly, SameSite=Lax, Secure on https. */
export const setCookie = (req: Request, value: string, maxAgeS: number) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`;

/** The account the request's session cookie is for, or null. */
export function sessionOf(req: Request): string | null {
  const key = sessionKey();
  return key ? openSession(cookieOf(req), key, Date.now()) : null;
}
