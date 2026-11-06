// GET /api/arena  the raw snapshot the terminal view renders: config, leaderboard, the last 3 duels in full,
// followers per agent, counts over the scanned duels, and the optional solver enrichment. Followers are
// read here (not in the shared snapshot) and cached for the same 20 s.
import { proven as hasProof } from "../../cells";
import { type Mandate, snapshot, ZERO } from "../arena";
import { ARENA, json, jsonBody, viewOn } from "../near";

const view = viewOn(ARENA);
let followers: { at: number; v: Record<string, [string, Mandate][]> } | null = null;

async function followersOf(pks: string[]) {
  if (followers && Date.now() - followers.at < 20_000) return followers.v;
  const v = Object.fromEntries(
    await Promise.all(pks.map(async (pk) => [pk, await view("list_followers", { agent_pk: pk })])),
  ) as Record<string, [string, Mandate][]>;
  followers = { at: Date.now(), v };
  return v;
}

export async function GET() {
  try {
    const s = await snapshot();
    const proven = (i: { proof_hash?: string } | null) => hasProof(i, ZERO);
    const stats = {
      scanned: s.duels.length,
      verified_decisions: s.duels.reduce(
        (n, d) => n + Number(proven(d.last_intent_a)) + Number(proven(d.last_intent_b)),
        0,
      ),
      attacks: s.duels.reduce((n, d) => n + (d.resolved ? (d.outcome?.injections ?? 0) : d.injections.length), 0),
    };
    const f = await followersOf(s.leaderboard.map((a) => a.pk)).catch(() => followers?.v ?? {});
    return json(jsonBody({ ...s, duels: s.duels.slice(0, 3), stats, followers: f }));
  } catch (e) {
    return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
  }
}
