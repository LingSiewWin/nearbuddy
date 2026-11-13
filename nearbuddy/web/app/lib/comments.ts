// Comments on a match: free text from signed-in visitors, kept off chain. This file is what the page and the server
// share: the text rule, the comment's shape, and the NEP-413 sign-in message with its time-stamped nonce. Comments
// never reach a model: only a paid shout does, through the contract. No Node API.

export type Comment = { id: string; at: number; by: string; text: string };

export const MAX_COMMENT = 200;
/** A nonce is accepted for this long after the time it carries (and at most a minute before it). */
export const NONCE_TTL_MS = 5 * 60_000;

// control characters (line breaks included) and the invisible format characters: zero-width, bidi overrides and
// isolates, word joiners, BOM. A comment is one visible line.
const BANNED = /[\p{Cc}​-‏‪-‮⁠-⁤⁦-⁩﻿]/u;

/** The comment as it is stored, or why it is refused. Markup is kept as written: the page renders text only. */
export function clean(text: unknown): { text: string } | { error: string } {
  if (typeof text !== "string") return { error: "comment must be text" };
  const t = text.trim();
  if (!t) return { error: "comment empty" };
  if ([...t].length > MAX_COMMENT) return { error: `comment too long: at most ${MAX_COMMENT} characters` };
  if (BANNED.test(t)) return { error: "comment has a control or invisible character" };
  return { text: t };
}

/** What the wallet shows and signs to open a comment session on `host`. */
export const loginMessage = (host: string) =>
  `Sign in to comment on NearBuddy (${host}). This is not a transaction: it moves no funds and costs nothing.`;

/** A NEP-413 nonce (32 bytes): the time in ms in its first 8 bytes, big-endian, then random bytes. */
export function newNonce(nowMs: number): Uint8Array {
  const n = crypto.getRandomValues(new Uint8Array(32));
  new DataView(n.buffer).setBigUint64(0, BigInt(nowMs));
  return n;
}

export function freshNonce(nonce: Uint8Array, nowMs: number): boolean {
  if (nonce.length !== 32) return false;
  const at = Number(new DataView(nonce.buffer, nonce.byteOffset, 8).getBigUint64(0));
  return nowMs - at < NONCE_TTL_MS && at - nowMs < 60_000;
}
