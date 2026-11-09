// How a stranger's headline reaches a duel, behind one interface, with the adapter picked by what the contract offers.
// Deploy 16.1: the text goes to the solver (POST /api/chaos, which relays to its open POST /chaos); the solver keeps
// the text and answers its sha256; the wallet then signs `inject_chaos(duel_id, target, kind, payload_hash)` with
// `min_chaos_deposit` attached (arena/src/duels.rs).
// Deploy 17 (chaos v2): the headline itself goes on chain, `inject_chaos(duel_id, target, kind, headline)` with
// `kind` the side the lie pushes and the deposit `chaos_fee(duel_id)`, which rises with every paid attack
// (arena/src/chaos.rs). No solver is involved. `adapterFor` picks one from `get_config`: only deploy 17 has `chaos`.
// The terminal and the MCP server call check(), price() and prepare(); the wallet (or the agent) signs.

import type { ChaosKind } from "./abi/arena";

/** The side a lie pushes toward. */
export type Direction = Exclude<ChaosKind, "Placebo">;
export type InjectInput = { duel_id: string; target: string; text: string; kind?: Direction | null };
/** What the adapter reads from the arena: the contract, `get_config`'s minimum and, on deploy 17, the duel's
 *  `chaos_fee`. */
export type Chain = { contract: string; min_chaos_deposit: string; chaos_fee?: string | null };
/** One function call for the wallet to sign. */
export type Call = {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
};

/** A service the attack needs is down: the page says so and nothing is signed. */
export class Offline extends Error {}

export interface InjectAdapter {
  /** Shown in help: which contract call this adapter signs. */
  readonly name: string;
  /** Whether the call carries the lie's direction (`kind`): only the contract that judges flips needs it. */
  readonly needsKind: boolean;
  /** Why the contract would refuse this headline, or null: checked before anything is signed. */
  check(text: string): string | null;
  /** What the next attack costs in yoctoNEAR; null while the price is unknown. */
  price(chain: Chain): string | null;
  /** Off-chain work before signing; throws Offline when a service it needs is down, Error for a refused input. */
  prepare(input: InjectInput, chain: Chain, fetcher?: typeof fetch): Promise<Call>;
}

/** Longest headline: UTF-8 bytes on deploy 17 (arena/src/chaos.rs MAX_HEADLINE), characters at the deploy-16 relay. */
export const MAX_HEADLINE = 280;
/** inject_chaos `kind` for a headline typed on the web (deploy 16); the spectator bot writes "fake_news/<mode>/<move>". */
export const WEB_KIND = "fake_news/web";
const GAS = "60000000000000"; // 60 Tgas, as the spectator bot attaches
// deploy 17 stores the headline and reads every record of the duel (up to 32) to price and settle it
const GAS_V17 = "100000000000000";
const GAS_CLAIM = "30000000000000";

const utf8 = new TextEncoder();
export const utf8Bytes = (s: string) => utf8.encode(s).length;

// Rust's `str::trim` drops White_Space, `char::is_control` is general category Cc, and HIDDEN in arena/src/chaos.rs
// lists the invisible format characters: zero-width, bidi overrides and isolates, word joiners, BOM.
const BLANK = /^\p{White_Space}*$/u;
const LONE = /\p{Cs}/u; // a lone surrogate: JSON carries it, but it is not UTF-8 and the contract cannot read it
const BANNED = /[\p{Cc}​-‏‪-‮⁠-⁤⁦-⁩﻿]/u;

/** The contract's own refusal for a deploy-17 headline (check_headline), in its order and words; null when it
 *  passes. */
export function checkHeadline(h: string): string | null {
  if (LONE.test(h)) return "headline is not valid UTF-8";
  if (BLANK.test(h)) return "headline empty";
  if (utf8Bytes(h) > MAX_HEADLINE) return "headline too long";
  if (BANNED.test(h)) return "headline control character";
  return null;
}

export const chaosDeploy16: InjectAdapter = {
  name: "inject_chaos (deploy 16.1): text held by the solver, its sha256 on chain",
  needsKind: false,
  check: (text) => (!text.trim() ? "headline empty" : text.length > MAX_HEADLINE ? "headline too long" : null),
  price: (chain) => chain.min_chaos_deposit,
  async prepare(input, chain, fetcher = fetch) {
    let r: Response;
    try {
      r = await fetcher("/api/chaos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: input.text }),
      });
    } catch {
      throw new Offline("this page's server did not answer");
    }
    const j = (await r.json().catch(() => ({}))) as { payload_hash?: string; error?: string; offline?: boolean };
    if (j.offline) throw new Offline(j.error ?? "solver offline");
    if (!r.ok || !j.payload_hash) throw new Error(j.error ?? `HTTP ${r.status}`);
    return {
      receiverId: chain.contract,
      methodName: "inject_chaos",
      args: { duel_id: input.duel_id, target: input.target, kind: WEB_KIND, payload_hash: j.payload_hash },
      gas: GAS,
      deposit: chain.min_chaos_deposit,
    };
  },
};

export const chaosDeploy17: InjectAdapter = {
  name: "inject_chaos (deploy 17): the headline on chain, priced by chaos_fee",
  needsKind: true,
  check: checkHeadline,
  price: (chain) => chain.chaos_fee ?? null,
  async prepare(input, chain) {
    const bad = checkHeadline(input.text);
    if (bad) throw new Error(bad);
    if (input.kind !== "Long" && input.kind !== "Short") throw new Error("say which way the lie pushes: long or short");
    if (!chain.chaos_fee) throw new Error("this duel's price (chaos_fee) is not read yet: try again in a few seconds");
    return {
      receiverId: chain.contract,
      methodName: "inject_chaos",
      args: { duel_id: input.duel_id, target: input.target, kind: input.kind, headline: input.text },
      gas: GAS_V17,
      deposit: chain.chaos_fee,
    };
  },
};

/** Deploy 17 by feature: its `get_config` carries the `chaos` terms, which 16.1's lacks. */
export const isChaosV2 = (config: { chaos?: unknown } | null | undefined) => config?.chaos != null;
export const adapterFor = (config: { chaos?: unknown } | null | undefined): InjectAdapter =>
  isChaosV2(config) ? chaosDeploy17 : chaosDeploy16;

/** The slice of a deploy-17 `get_chaos` record that decides a claim. */
type Owed = { injector: string; payout: string; claimed: boolean };
/** yoctoNEAR `claim_chaos` would pay `account` from these records: unclaimed payouts, set when the duel finished. */
export const claimable = (records: Owed[] | null | undefined, account: string | null | undefined): bigint =>
  (records ?? []).reduce((s, c) => (account && c.injector === account && !c.claimed ? s + BigInt(c.payout) : s), 0n);

/** `claim_chaos(duel_id)`: pays the signer everything its headlines in that finished duel are owed, in one transfer. */
export const claimCall = (contract: string, duel_id: string): Call => ({
  receiverId: contract,
  methodName: "claim_chaos",
  args: { duel_id },
  gas: GAS_CLAIM,
  deposit: "1",
});
