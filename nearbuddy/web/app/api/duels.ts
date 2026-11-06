// Duel reads shared by /api/arena and /api/agent. A resolved duel never changes, so it is read once per
// process and kept; open duels are read every time. A failed read is never cached: it is retried next build.
import { ARENA, viewOn } from "./near";

const view = viewOn(ARENA);
const resolved = new Map<string, unknown>(); // ponytail: one process, ~1 KB a duel; evicts oldest past 2000

/** `get_duel`, plus `no_reveal` from `get_no_reveal` once resolved when `noReveal` (deploy 14 on).
 *  Null when the duel does not exist or `get_duel` failed. A resolved duel whose `get_no_reveal` failed comes back
 *  uncached with `no_reveal` undefined, so a caller can tell an unread forfeit from "no forfeit" ([false, false]). */
export async function readDuel<T extends { resolved: boolean }>(id: string, noReveal = false): Promise<T | null> {
  const hit = resolved.get(id) as (T & { no_reveal?: unknown }) | undefined;
  // a duel kept before the contract had commit-reveal lacks no_reveal: re-read it rather than serve it as unread
  if (hit && (!noReveal || hit.no_reveal !== undefined)) return hit;
  let d: (T & { no_reveal?: unknown }) | null;
  try {
    d = (await view("get_duel", { duel_id: id })) as (T & { no_reveal?: unknown }) | null;
  } catch {
    return null;
  }
  if (d?.resolved) {
    if (noReveal) {
      const nr = await view("get_no_reveal", { duel_id: id }).catch(() => undefined);
      if (nr === undefined) return d; // not cached: a failed read must not pin "no forfeit" for the process
      d.no_reveal = nr;
    }
    resolved.set(id, d);
    if (resolved.size > 2000) resolved.delete(resolved.keys().next().value as string);
  }
  return d;
}

/** Views in small chunks so a rate-limited RPC sees a trickle, not a burst. */
export async function chunked<T>(items: string[], size: number, f: (id: string) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(f))));
  return out;
}
