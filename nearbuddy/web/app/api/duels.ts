// Duel reads shared by /api/arena and /api/agent. A resolved duel never changes, so it is read once per
// process and kept; open duels are read every time. A failed read is never cached: it is retried next build.
import type { Chaos, Duel } from "../lib/abi/arena";
import { arenaView } from "./near";

/** A `get_duel` result, plus `no_reveal` (`get_no_reveal`) once resolved and read. */
export type ReadDuel = Duel & { no_reveal?: [boolean, boolean] };

const resolved = new Map<string, ReadDuel>(); // ponytail: one process, ~1 KB a duel; evicts oldest past 2000

/** `get_duel`, plus `no_reveal` from `get_no_reveal` once resolved when `noReveal` (deploy 14 on).
 *  Null when the duel does not exist or `get_duel` failed. A resolved duel whose `get_no_reveal` failed comes back
 *  uncached with `no_reveal` undefined, so a caller can tell an unread forfeit from "no forfeit" ([false, false]). */
export async function readDuel(id: string, noReveal = false): Promise<ReadDuel | null> {
  const hit = resolved.get(id);
  // a duel kept before the contract had commit-reveal lacks no_reveal: re-read it rather than serve it as unread
  if (hit && (!noReveal || hit.no_reveal !== undefined)) return hit;
  let d: ReadDuel | null;
  try {
    d = await arenaView("get_duel", { duel_id: id });
  } catch {
    return null;
  }
  if (d?.resolved) {
    if (noReveal) {
      const nr = await arenaView("get_no_reveal", { duel_id: id }).catch(() => undefined);
      if (nr === undefined) return d; // not cached: a failed read must not pin "no forfeit" for the process
      d.no_reveal = nr;
    }
    resolved.set(id, d);
    if (resolved.size > 2000) resolved.delete(resolved.keys().next().value as string);
  }
  return d;
}

/** The duels /api/arena lists: the newest `show` scanned, plus every older one still unresolved, newest first. The
 *  solver staggers closes, so the duel closing next is often not among the newest few. */
export const shownDuels = <D extends { resolved: boolean }>(scanned: (D | null)[], show: number): (D | null)[] =>
  scanned.filter((d, i) => i < show || (d !== null && !d.resolved));

/** Deploy 17's view of one duel's attacks: every `get_chaos` record (headline, arm, outcome, payout) and the price of
 *  the next one. Records change after a duel resolves (claims), so they are never memoised. */
export type ChaosView = { chaos: Chaos[]; chaos_fee: string };
export async function chaosOf(id: string): Promise<ChaosView> {
  const [chaos, chaos_fee] = await Promise.all([
    arenaView("get_chaos", { duel_id: id }),
    arenaView("chaos_fee", { duel_id: id }),
  ]);
  return { chaos, chaos_fee };
}

/** Views in small chunks so a rate-limited RPC sees a trickle, not a burst. */
export async function chunked<T>(items: string[], size: number, f: (id: string) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(f))));
  return out;
}
