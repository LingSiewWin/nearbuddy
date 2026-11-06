// What a follower did and what was done for it, read from FastNEAR tx bodies: its own calls (follow, unfollow,
// deposit, request_withdraw, withdraw, withdraw_token) and the solver's settle_follow batches for it. Every entry
// comes from an arena receipt whose own outcome succeeded (arenaCalls); a tx whose receipt panicked counts for
// nothing, whatever the tx-level status says. Pure, server side (lib/verify pulls in node:crypto).
import type { FollowerActivity, SettledFill } from "../cells";
import { arenaCalls, type Tx } from "./verify";

/** The follower's own successful arena calls, oldest first. A withdrawal counts when on_withdraw returned true (the
 *  NEAR left), a token withdrawal when on_withdraw_token did (the transfer on intents_account went through). */
export function followerActivity(txs: Tx[], arena: string, account: string): FollowerActivity[] {
  const out: FollowerActivity[] = [];
  for (const c of arenaCalls(txs, arena)) {
    if (!c.ok) continue;
    const a = c.args as Record<string, unknown>;
    const base = { tx: c.tx, at_ms: c.at_ms };
    const own = c.predecessor === account;
    if (own && (c.method === "follow" || c.method === "unfollow"))
      out.push({ ...base, kind: c.method, agent_pk: String(a.agent_pk) });
    else if (own && c.method === "deposit") out.push({ ...base, kind: "deposit", amount: String(c.deposit) });
    else if (own && c.method === "request_withdraw")
      out.push({ ...base, kind: "request_withdraw", amount: String(a.amount) });
    else if (c.method === "on_withdraw" && a.who === account && c.value === true)
      out.push({ ...base, kind: "withdraw", amount: String(a.pay) });
    else if (c.method === "on_withdraw_token" && a.follower === account && c.value === true)
      out.push({ ...base, kind: "withdraw_token", amount: String(a.amount), token: String(a.token_id) });
  }
  return out.sort((x, y) => x.at_ms - y.at_ms);
}

/** Agents the follower followed, in first-follow order (unfollowed ones too: their mandate may still settle). */
export const followedAgents = (activity: FollowerActivity[]) => [
  ...new Set(activity.flatMap((x) => (x.kind === "follow" && x.agent_pk ? [x.agent_pk] : []))),
];

type Report = { settled?: number; rejected?: [number, string][] };
type FillArg = {
  intent_nonce: string;
  token: string;
  amount_in: string;
  amount_out: string;
  swap_tx: string;
};

/** Every fill settled in these txs, for any follower: the fills of a successful on_settle_follow receipt whose
 *  returned report does not reject them. A batch that settles nothing panics, so it never appears here. */
export function settledFills(txs: Tx[], arena: string): SettledFill[] {
  return arenaCalls(txs, arena).flatMap((c) => {
    if (!c.ok || c.method !== "on_settle_follow") return [];
    const a = c.args as { agent_pk?: string; follower?: string; solver?: string; fills?: FillArg[] };
    const report = c.value as Report | null;
    if (!a.follower || !Array.isArray(a.fills) || !report?.settled) return [];
    const rejected = new Set((report.rejected ?? []).map(([i]) => i));
    return a.fills.flatMap((f, i) =>
      rejected.has(i)
        ? []
        : [
            {
              tx: c.tx,
              at_ms: c.at_ms,
              follower: a.follower!,
              agent_pk: String(a.agent_pk),
              solver: String(a.solver ?? ""),
              intent_nonce: String(f.intent_nonce),
              token: f.token,
              amount_in: String(f.amount_in),
              amount_out: String(f.amount_out),
              swap_tx: f.swap_tx,
            },
          ],
    );
  });
}
