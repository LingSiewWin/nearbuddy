// Entering a keyless agent (arena deploy 18): the one `register_keyless` call a wallet signs, checked with the
// contract's own rules first, and what the /enter page reads back: a slot's request inputs and a one-line status.
// No Node API (process.env only as keylessArena's default, read on the server), so the page, the MCP `enter` tool and
// the tests share it. The request bytes themselves come from lib/keyless.ts, the twin of arena/src/keyless.rs.

import type { NetworkId } from "../network";
import type { AgentView, Chaos, Duel, KeylessAgent, Slot } from "./abi/arena";
import type { Call } from "./inject";
import { b64strict, checkStrategy, KEYLESS_TEMPLATE_VERSION, type KeylessInputs, SLOT_TTL_NS } from "./keyless";

/** The keyless arena per network, a contract separate from NET.arena (the production arena has no keyless methods
 *  yet); KEYLESS_ARENA_CONTRACT overrides it on the server (api/keyless.ts). null: none on that network. */
export const KEYLESS_ARENAS: Record<NetworkId, string | null> = {
  testnet: "v3.nb-keyless-arena-1111.testnet",
  mainnet: null,
};

/** The keyless arena of network `id`; throws unless the account belongs to that network: a `.testnet` account on
 *  testnet, anything but one on mainnet. */
export function keylessArena(id: NetworkId, env: Record<string, string | undefined> = process.env): string | null {
  const v = env.KEYLESS_ARENA_CONTRACT?.trim() || KEYLESS_ARENAS[id];
  if (v && v.endsWith(".testnet") !== (id === "testnet"))
    throw new Error(`NEAR_NETWORK=${id} but KEYLESS_ARENA_CONTRACT=${v} is not a ${id} account: fix or unset`);
  return v;
}

/** A duel id as the contract writes a U64: decimal, no sign, no leading zero, at most 12 digits. */
export const canonicalDuelId = (s: string): boolean => /^(0|[1-9]\d{0,11})$/.test(s);

/** A 32-byte agent key in canonical base64 (near-sdk's Base64VecU8), so one key has one spelling. */
export function canonicalPk(s: string): boolean {
  try {
    return b64strict(s).length === 32;
  } catch {
    return false;
  }
}

const NEAR = 10n ** 24n;
/** The least deposit the page and the MCP tool build: the agent's records cost at most about 0.011 NEAR of storage
 *  (64-byte model id, 512-byte strategy) and the contract refuses a deposit at or below that ("bond required"). */
export const MIN_BOND_NEAR = "0.02";
export const DEFAULT_BOND_NEAR = "0.1";
/** The most these tools attach: a bond only pays slot storage and a lost duel's slash, so a typo of 1000 NEAR is
 *  refused before a wallet sees it. */
export const MAX_BOND_NEAR = "100";
/** register_keyless measured 3.4 TGas on the real wasm; the rest is refunded. */
export const ENTER_GAS = "30000000000000";

/** A NEAR amount ("0.1", "2") in yoctoNEAR; RangeError for anything else. */
export function yocto(near: string): bigint {
  const m = /^(\d{1,9})(?:\.(\d{1,24}))?$/.exec(near.trim());
  if (!m) throw new RangeError(`bond: a NEAR amount like ${DEFAULT_BOND_NEAR}`);
  return BigInt(m[1] ?? "0") * NEAR + BigInt((m[2] ?? "").padEnd(24, "0"));
}

/** register_keyless's model_id rules: at most 64 bytes, no C0 control character but a line feed. */
export function checkModelId(model_id: string): void {
  if (new TextEncoder().encode(model_id).length > 64) throw new RangeError("model_id too long");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters the contract refuses
  if (/[\u0000-\u0009\u000b-\u001f]/.test(model_id)) throw new RangeError("control character");
}

/** The unsigned `register_keyless` call on `contract`. Throws a RangeError with the contract's panic text
 *  ("strategy empty", "strategy too long", "strategy character", "model_id too long", "control character") or the
 *  bond's rule, so nothing the contract would refuse reaches a wallet. The deposit is the bond; the contract keeps the
 *  records' storage out of it. */
export function enterCall(
  contract: string,
  i: { model_id: string; strategy: string; bond_near?: string | undefined },
): Call {
  checkModelId(i.model_id);
  checkStrategy(i.strategy);
  const deposit = yocto(i.bond_near?.trim() || DEFAULT_BOND_NEAR);
  if (deposit < yocto(MIN_BOND_NEAR)) throw new RangeError(`bond: at least ${MIN_BOND_NEAR} NEAR`);
  if (deposit > yocto(MAX_BOND_NEAR)) throw new RangeError(`bond: at most ${MAX_BOND_NEAR} NEAR`);
  return {
    receiverId: contract,
    methodName: "register_keyless",
    args: { model_id: i.model_id, strategy: i.strategy, template_version: KEYLESS_TEMPLATE_VERSION },
    gas: ENTER_GAS,
    deposit: deposit.toString(),
  };
}

/** The request a first slot would carry: every input the contract fills at `open_slot` (price, time left, duel,
 *  nonce) at a placeholder value, so the page can show the template with the user's model and strategy before any
 *  duel exists. */
export const exampleInputs = (model_id: string, strategy: string): KeylessInputs => ({
  template_version: KEYLESS_TEMPLATE_VERSION,
  model_id,
  strategy,
  symbol: "wrap.near",
  open_price: "366000000",
  price: "366000000",
  seconds_left: 300,
  duel_id: "0",
  seq: "1",
  nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  headlines: [],
});

/** The inputs slot `s` froze, read back from views (the keeper's `slotInputs`): what `keyless_request` builds. */
export function slotInputs(agent: AgentView, k: KeylessAgent, d: Duel, s: Slot, chaos: Chaos[] | null): KeylessInputs {
  const headlines: KeylessInputs["headlines"] = [];
  for (let i = 0; i < s.seen; i++)
    if (s.heads & (1 << i)) {
      const c = chaos?.[i];
      if (!c) throw new Error(`get_chaos(${d.id}) has no record ${i}`);
      headlines.push({ text: c.headline, arm: c.arm });
    }
  if (d.open_price === null) throw new Error(`duel ${d.id} has no open price`);
  return {
    template_version: k.template,
    model_id: agent.model_id,
    strategy: k.strategy,
    symbol: d.symbol,
    open_price: d.open_price,
    price: s.price,
    seconds_left: String((BigInt(d.close_at) - BigInt(s.opened_at)) / 1_000_000_000n),
    duel_id: d.id,
    seq: s.seq,
    nonce: s.nonce,
    headlines,
  };
}

/** The agent a `register_keyless` transaction returned, from its final outcome (RPC `tx`): the call answers the new
 *  AgentView, whose pk is the agent's id. null when the call failed or the outcome holds anything else. */
export function enteredAgent(outcome: unknown): AgentView | null {
  const v = (outcome as { status?: { SuccessValue?: unknown } } | null)?.status?.SuccessValue;
  if (typeof v !== "string") return null;
  try {
    const a = JSON.parse(new TextDecoder().decode(b64strict(v))) as Partial<AgentView> | null;
    return a && typeof a.owner === "string" && typeof a.pk === "string" && canonicalPk(a.pk) ? (a as AgentView) : null;
  } catch {
    return null;
  }
}

/** How many of an agent's duels /enter lists (agent_duels, newest first). */
export const RECENT_DUELS = 6;

/** GET /api/keyless?agent=: the views one keyless agent's status is read from. */
export type AgentState = {
  agent: AgentView | null;
  keyless: KeylessAgent | null;
  duel: Duel | null;
  slot: Slot | null;
  /** get_chaos of the duel, when the slot carries a headline. */
  chaos: Chaos[] | null;
  /** agent_duels: the newest few, newest first. */
  duels: string[];
};

/** Where the agent is, in one line: "waiting for a duel", "slot 3 open", "decided Long 500 bps". `c` is the CSS
 *  class (globals.css). */
export function statusLine(s: AgentState, nowNs: bigint): { t: string; c: string } {
  if (!s.agent || !s.keyless) return { t: "not a keyless agent on this arena", c: "bad" };
  const d = s.duel;
  if (!s.agent.in_duel || !d || d.resolved) return { t: "waiting for a duel", c: "dim" };
  const closed = nowNs >= BigInt(d.close_at);
  const tail = closed ? " · duel closed, waiting for the oracle to settle it" : "";
  const at = `duel #${d.id}`;
  const sl = s.slot;
  if (!sl) return { t: `${at} · waiting for a keeper to open a slot${tail}`, c: "open" };
  // SLOT_TTL_NS is template 1's (lib/keyless.ts, the contract's twin): a deploy that changes it changes the twin
  if (sl.response_hash === null && nowNs >= BigInt(sl.opened_at) + SLOT_TTL_NS)
    return { t: `${at} · slot ${sl.seq} expired with no answer; a keeper may open the next${tail}`, c: "warn" };
  if (sl.response_hash === null)
    return { t: `${at} · slot ${sl.seq} open · waiting for a keeper's answer${tail}`, c: "open" };
  if (sl.side === null) return { t: `${at} · slot ${sl.seq} answered with no readable decision${tail}`, c: "warn" };
  return { t: `${at} · slot ${sl.seq} decided ${sl.side} ${sl.size_bps} bps${tail}`, c: "ok" };
}

// Shown as is: printable ASCII but the backslash, and any letter, digit, punctuation or symbol.
const PLAIN = /^[\x20-\x5b\x5d-\x7e]$|^[\p{L}\p{N}\p{P}\p{S}]$/u;
/** `s` cut into the units a page shows, so that no character of a request is hidden: a backslash as `\\`, anything
 *  not plain (controls, format characters such as zero-width spaces, soft hyphens and Unicode tags, combining marks
 *  and variation selectors, separators other than the space, private use, unassigned) as `\u{HEX}`. The units joined
 *  name every code point of `s` in order. */
export function shownUnits(s: string): string[] {
  return Array.from(s, (c) =>
    c === "\\" ? "\\\\" : PLAIN.test(c) ? c : `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
}

/** `units` packed into lines of at most `width` characters, never splitting a unit (a longer one gets its own line). */
export function wrapUnits(units: string[], width: number): string[][] {
  const lines: string[][] = [];
  let cur: string[] = [];
  let n = 0;
  for (const u of units) {
    if (cur.length && n + u.length > width) {
      lines.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(u);
    n += u.length;
  }
  lines.push(cur);
  return lines;
}
