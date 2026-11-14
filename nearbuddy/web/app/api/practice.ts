// The server side of a practice round (lib/practice.ts): the limits, and the two model calls with their enclave
// signatures. NEAR AI Cloud is called as packages/keeper/src/nearai.ts calls it, and each signature record is checked
// as packages/keeper/src/tee.ts checks it; the web app keeps its own copy, as it does for lib/keyless.ts.
import { createHash } from "node:crypto";
import { parseDecision } from "../lib/keyless";
import {
  PRACTICE_MODEL,
  type PracticeCall,
  type PracticeRound,
  practiceRequest,
  reasonOf,
  SNAPSHOT,
  type Target,
  verdictOf,
} from "../lib/practice";
import { b64, hex, teeText, verify } from "../lib/protocol";

export const NEAR_AI_BASE = "https://cloud-api.near.ai/v1";
export const PER_ADDRESS = 5;
export const WINDOW_S = 600;
export const SITE_DAILY = 600;
export const DAY_S = 86_400;
// the slowest answer seen in testing took over 25 s; the route may run 60 s in all
const COMPLETION_MS = 35_000;
const SIGNATURE_MS = 3_000;
const SIGNATURE_TRIES = 3;

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** Seconds to wait before this address may play again; 0 when the round may run now. `bump` adds one to a counter
 *  that expires after `ttlS` and answers its new value. Each round spends the owner's model credit.
 *  ponytail: fixed windows named by the clock, so an address can play 10 rounds across a window's edge; a sliding
 *  window if that is ever abused. */
export async function limit(
  address: string,
  bump: (key: string, ttlS: number) => Promise<number>,
  nowS: number,
): Promise<number> {
  if ((await bump(`nb:practice:ip:${address}:${Math.floor(nowS / WINDOW_S)}`, WINDOW_S)) > PER_ADDRESS)
    return WINDOW_S - (nowS % WINDOW_S);
  if ((await bump(`nb:practice:all:${Math.floor(nowS / DAY_S)}`, DAY_S)) > SITE_DAILY) return DAY_S - (nowS % DAY_S);
  return 0;
}

/** The model failed: no answer, an error status, or an answer with no decision in it. */
export class ModelFailed extends Error {}

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const unhex = (s: string) => new Uint8Array(Buffer.from(s.replace(/^0x/, ""), "hex"));

type SigRecord = {
  text?: string;
  signature?: string;
  signing_address?: string;
  signing_algo?: string;
  signature_kind?: string;
};

/** The enclave's record for one completion, checked: provider enclave, ed25519, its text exactly
 *  `model:sha256(request):sha256(response)` over our own bytes, and the signature valid for that text. */
export function checkRecord(rec: SigRecord, model: string, requestHash: Uint8Array, responseHash: Uint8Array): boolean {
  if ((rec.signature_kind ?? "provider_tee") !== "provider_tee" || (rec.signing_algo ?? "ed25519") !== "ed25519")
    return false;
  const text = teeText(2, model, requestHash, responseHash);
  if (rec.text !== new TextDecoder().decode(text) || !rec.signing_address || !rec.signature) return false;
  return verify(b64.enc(unhex(rec.signing_address)), text, b64.enc(unhex(rec.signature)));
}

/** What a round needs from outside, replaceable in tests: the HTTP client, the pause between signature tries and
 *  how long one completion may take. */
export type Deps = {
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  wait: (ms: number) => Promise<void>;
  timeoutMs: number;
};
const DEPS: Deps = { fetchFn: (url, init) => fetch(url, init), wait: sleep, timeoutMs: COMPLETION_MS };
/** Where baselines are kept: the comment store's Redis when configured, else this process. */
export type Cache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlS: number): Promise<void>;
};
export const BASELINE_TTL_S = 6 * 3600;

/** One completion and its signature. Throws ModelFailed; a missing signature is not a failure, it is reported. */
async function call(
  key: string,
  target: Target,
  headline: string | null,
  deps: Deps,
  strategy?: string,
): Promise<PracticeCall> {
  const { fetchFn, wait } = deps;
  const started = Date.now();
  const headers = { Authorization: `Bearer ${key}`, accept: "application/json" };
  const body = practiceRequest(target, headline, strategy);
  const r = await fetchFn(`${NEAR_AI_BASE}/chat/completions`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: body as BodyInit,
    signal: AbortSignal.timeout(deps.timeoutMs),
    cache: "no-store",
  }).catch(() => null);
  if (r?.status !== 200) throw new ModelFailed();
  const response = new Uint8Array(await r.arrayBuffer());
  const decision = parseDecision(response, !!headline);
  if (!decision) throw new ModelFailed();
  const ms = Date.now() - started;
  const [requestHash, responseHash] = [sha256(body), sha256(response)];
  const out: PracticeCall = {
    side: decision.side,
    reason: reasonOf(response),
    ms,
    request_hash: hex(requestHash),
    response_hash: hex(responseHash),
    signature: { status: "unavailable", signer: null, signature: null },
  };
  let chatId: unknown;
  try {
    chatId = JSON.parse(new TextDecoder().decode(response)).id;
  } catch {}
  if (typeof chatId !== "string") return out;
  // the record lives on the enclave node that served the completion, so a miss is retried (nearai.ts `signature`)
  const q = new URLSearchParams({ model: PRACTICE_MODEL, signing_algo: "ed25519" });
  for (let i = 0; i < SIGNATURE_TRIES; i++) {
    const s = await fetchFn(`${NEAR_AI_BASE}/signature/${encodeURIComponent(chatId)}?${q}`, {
      headers,
      signal: AbortSignal.timeout(SIGNATURE_MS),
      cache: "no-store",
    }).catch(() => null);
    const rec = s?.status === 200 ? ((await s.json().catch(() => null)) as SigRecord | null) : null;
    if (rec) {
      out.signature = {
        status: checkRecord(rec, PRACTICE_MODEL, requestHash, responseHash) ? "verified" : "failed",
        signer: typeof rec.signing_address === "string" ? rec.signing_address.slice(0, 80) : null,
        signature: typeof rec.signature === "string" ? rec.signature.slice(0, 160) : null,
      };
      break;
    }
    if (i < SIGNATURE_TRIES - 1) await wait(600 * (i + 1));
  }
  return out;
}

const inflight = new Map<string, Promise<PracticeCall>>();
/** The defender's bet on the snapshot with no headline: asked once, then kept for BASELINE_TTL_S. The key is the hash
 *  of the request bytes, so a new snapshot or prompt never reads an old answer. Requests that arrive while it is being
 *  asked share the one call.
 *  ponytail: a failed call is not remembered, so each request retries while the model is down; cache the failure for
 *  a minute if that ever matters. */
export async function baselineOf(
  key: string,
  target: Target,
  cache: Cache,
  deps: Deps = DEPS,
  strategy?: string,
): Promise<PracticeCall> {
  const k = `nb:practice:base:${hex(sha256(practiceRequest(target, null, strategy))).slice(0, 24)}`;
  try {
    const hit = await cache.get(k);
    if (hit) return JSON.parse(hit) as PracticeCall;
  } catch {}
  let asking = inflight.get(k);
  if (!asking) {
    asking = call(key, target, null, deps, strategy)
      .then(async (c) => {
        await cache.set(k, JSON.stringify(c), BASELINE_TTL_S).catch(() => {});
        return c;
      })
      .finally(() => inflight.delete(k));
    inflight.set(k, asking);
  }
  return asking;
}

/** One practice round: the cached baseline, then the attacked call and the control call (the same request with no
 *  headline) at the same time. */
export async function playRound(
  key: string,
  target: Target,
  headline: string,
  cache: Cache,
  deps: Deps = DEPS,
  strategy?: string,
): Promise<PracticeRound> {
  const started = Date.now();
  const baseline = await baselineOf(key, target, cache, deps, strategy);
  const [control, attacked] = await Promise.all([
    call(key, target, null, deps, strategy),
    call(key, target, headline, deps, strategy),
  ]);
  return {
    practice: true,
    target,
    model: PRACTICE_MODEL,
    snapshot: SNAPSHOT,
    baseline,
    control,
    attacked,
    verdict: verdictOf(baseline.side, control.side, attacked.side),
    ms: Date.now() - started,
  };
}
