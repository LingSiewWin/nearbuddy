// Followers of an agent across deploys. Its own module, not near.ts, so route tests that stub near.ts still run
// the real fallback.
import { SOLVER_URL } from "./near";

type View = (method: "list_followers", args: { agent_pk: string }) => Promise<unknown>;

/** An agent's followers as `[follower, mandate]`. Before deploy 15 the `list_followers` view; from deploy 15
 *  (`follows` keyed per pair, not enumerable on chain) that view is gone and the solver's GET /followers answers
 *  from `get_follow`. Empty when neither answers: followers are enrichment, never a reason to fail the page. */
export async function followersOf(view: View, pk: string, fetchFn: typeof fetch = fetch): Promise<[string, unknown][]> {
  try {
    return (await view("list_followers", { agent_pk: pk })) as [string, unknown][];
  } catch {
    try {
      const r = await fetchFn(`${SOLVER_URL}/followers?pk=${encodeURIComponent(pk)}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      const j = (await r.json()) as unknown;
      return Array.isArray(j) ? (j as [string, unknown][]) : [];
    } catch {
      return [];
    }
  }
}
