// GET /api/v1/md/agent/<pk>  one agent as markdown: identity, record, attacks met, duels, followers and its
// latest decisions with reasoning. Served for /agent/<pk> when the client prefers text/markdown; see proxy.ts.

import { promptName } from "../../../../../ui/format";
import { agentSummary, parsePk } from "../../../../agent";
import { agentLink, decisions, duelLink, md, near, pct, pointer, table, time } from "../../md";

export async function GET(req: Request, ctx: { params: Promise<{ pk: string }> }) {
  const o = new URL(req.url).origin;
  const pk = parsePk((await ctx.params).pk);
  if (!pk)
    return md("# Not an agent key\n\nThe key must be 32 bytes of base64, URL-encoded (+ / = appear in it).\n", 400);
  let a: Awaited<ReturnType<typeof agentSummary>>;
  try {
    a = await agentSummary(pk);
  } catch (e) {
    return md(
      `# Agent ${pk}\n\nThe chain could not be read just now (${String(e).slice(0, 120)}). Retry shortly.\n`,
      502,
    );
  }
  if (!a) return md(`# Agent ${pk}\n\nNo agent is registered with that key. Standings: ${o}/arena\n`, 404);
  const body = [
    `# Agent ${a.agent.slice(0, 8)}… · ${a.model}`,
    "",
    pointer(o, `${o}/api/v1/agents/${encodeURIComponent(a.agent)}`),
    "",
    `- Key: \`${a.agent}\``,
    `- Owner: ${a.owner}; prompt: ${a.prompt ? `${promptName(a.prompt)} (${a.prompt})` : "unknown"}; enclave-verified: ${a.verified ? "yes" : "no"}`,
    `- Return: ${pct(a.record.return_pct)} over its last ${a.record.window} resolved duels, ${pct(a.return_pct)} since it joined; bond: ${near(a.bond_near)}; ${a.in_duel == null ? "not in a duel" : `in duel ${duelLink(o, a.in_duel)}`}`,
    `- Record: won ${a.record.won}, lost ${a.record.lost}, tied ${a.record.tied} of its last ${a.record.window} resolved duels`,
    `- Paid lies: faced ${a.attacks.faced}; saw through ${a.attacks.resisted}, named but took its side ${a.attacks.named}, fell for ${a.attacks.fell}, ignored ${a.attacks.unmoved}`,
    `- Called the next price move right: ${a.calls.right} of ${a.calls.scored} (a coin flip is 50%)`,
    "",
    "## Duels",
    "",
    a.duels.length
      ? table(
          ["duel", "closes", "opponent", "call", "size", "return", "result", "attacks"],
          a.duels.map((d) => [
            duelLink(o, d.duel),
            time(d.closed_at),
            agentLink(o, d.opponent),
            d.side ?? "-",
            d.size_pct == null ? "-" : `${d.size_pct}%`,
            pct(d.return_pct),
            d.result,
            d.attacks,
          ]),
        )
      : "None yet.",
    "",
    "## Followers",
    "",
    a.followers.length
      ? table(
          ["account", "per-fill cap", "spent", "allowance", "revoked", "expires"],
          a.followers.map((f) => [
            f.account,
            near(f.cap_near),
            near(f.spent_near),
            near(f.allowance_near),
            f.revoked ? "yes" : "no",
            time(f.expires_at),
          ]),
        )
      : a.followers_complete
        ? "None."
        : "None of the house accounts.",
    ...(a.followers_complete
      ? []
      : ["", "This contract version has no follower list; only the house accounts were checked."]),
    "",
    "## Latest decisions, with the model's own reasoning",
    "",
    decisions(o, a.decisions),
    "",
  ];
  return md(body.join("\n"));
}
