// Duel reads shared by /api/arena and /api/agent. A resolved duel never changes, so it is read once per
// process and kept; open duels are read every time.
import { ARENA, viewOn } from "./near";

const view = viewOn(ARENA);
const resolved = new Map<string, unknown>(); // ponytail: one process, ~1 KB a duel; evicts oldest past 2000

/** `get_duel`, plus `no_reveal` from `get_no_reveal` once resolved when `noReveal` (deploy 14 on). */
export async function readDuel<T extends { resolved: boolean }>(id: string, noReveal = false): Promise<T | null> {
  const hit = resolved.get(id);
  if (hit) return hit as T;
  const d = (await view("get_duel", { duel_id: id })) as (T & { no_reveal?: unknown }) | null;
  if (d?.resolved) {
    if (noReveal) d.no_reveal = await view("get_no_reveal", { duel_id: id }).catch(() => null);
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
