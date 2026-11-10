// The keyless arena (deploy 18) as the API routes read it: which contract (lib/enter.ts keylessArena), the models
// pinned on it, the keyless agents an account owns and one agent's state. Server only (the public RPC through ./near's
// provider).
import type { ArenaViews } from "../lib/abi/arena";
import { type AgentState, keylessArena } from "../lib/enter";
import { NETWORK_ID } from "../network";
import { provider } from "./near";

export const KEYLESS_ARENA = keylessArena(NETWORK_ID);

/** A view of the keyless arena, typed from abi/arena.json like ./near's arenaView. */
export const keylessView = <M extends keyof ArenaViews>(method: M, args: ArenaViews[M]["args"]) => {
  if (!KEYLESS_ARENA) throw new Error(`no keyless arena on ${NETWORK_ID}`);
  return provider.callFunction({ contractId: KEYLESS_ARENA, method, args }) as Promise<ArenaViews[M]["result"]>;
};

export type Pinned = { model_id: string; signer: string };
/** `StorageKey::KeylessSigners` (arena/src/state.rs, 27th variant): the borsh prefix of the signer -> model map. */
const SIGNERS_PREFIX = "\x1a";
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
let pinnedCache: { at: number; list: Pinned[] } | null = null;

/** Every model a keyless agent can use: the contract has no list view, so this reads the `pin_model_signer` map's
 *  raw state (key: prefix, u32 length, the 32-byte signer; value: borsh String) and keeps a pair only when
 *  `get_model_signer` answers the same model. Cached 60 s.
 *  ponytail: view_state over one prefix; RPCs refuse it past their state-size limit, so a `pinned_models` view when
 *  the contract grows. */
export async function pinnedModels(): Promise<Pinned[]> {
  if (pinnedCache && Date.now() - pinnedCache.at < 60_000) return pinnedCache.list;
  if (!KEYLESS_ARENA) return [];
  const st = await provider.viewContractState({ contractId: KEYLESS_ARENA, prefix: SIGNERS_PREFIX });
  const raw = st.values.map(({ key, value }) => {
    const k = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    const v = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return { signer: b64(k.slice(5, 37)), model_id: new TextDecoder().decode(v.slice(4)) };
  });
  const checked = await Promise.all(
    raw.map(async (p) => ((await keylessView("get_model_signer", { signer: p.signer })) === p.model_id ? p : null)),
  );
  const list = checked.filter((p): p is Pinned => !!p).sort((a, b) => a.model_id.localeCompare(b.model_id));
  pinnedCache = { at: Date.now(), list };
  return list;
}

const keylessKind = new Map<string, boolean>();
/** The keyless agents `owner` registered, oldest first by the leaderboard's order: every agent, then `get_keyless`
 *  for the ones not seen before (a key never changes kind).
 *  ponytail: pages the whole leaderboard per call; an owner index when the arena has thousands of agents. */
export async function ownedKeyless(owner: string): Promise<string[]> {
  const mine: string[] = [];
  for (let from = 0; ; from += 100) {
    const page = await keylessView("leaderboard", { from, limit: 100 });
    mine.push(...page.filter((a) => a.owner === owner).map((a) => a.pk));
    if (page.length < 100) break;
  }
  for (const pk of mine)
    if (!keylessKind.has(pk)) keylessKind.set(pk, (await keylessView("get_keyless", { agent: pk })) !== null);
  return mine.filter((pk) => keylessKind.get(pk));
}

/** One keyless agent's state: its record, its open duel and slot, and its duels. */
export async function agentState(pk: string): Promise<AgentState> {
  const [agent, keyless, duels] = await Promise.all([
    keylessView("get_agent", { agent_pk: pk }),
    keylessView("get_keyless", { agent: pk }),
    keylessView("agent_duels", { agent_pk: pk, from: 0, limit: 50 }).catch(() => [] as string[]),
  ]);
  const id = agent?.in_duel ?? null;
  const [duel, slot] = id
    ? await Promise.all([keylessView("get_duel", { duel_id: id }), keylessView("get_slot", { duel_id: id, agent: pk })])
    : [null, null];
  const chaos = id && slot?.heads ? await keylessView("get_chaos", { duel_id: id }) : null;
  return { agent, keyless, duel, slot, chaos, duels };
}
