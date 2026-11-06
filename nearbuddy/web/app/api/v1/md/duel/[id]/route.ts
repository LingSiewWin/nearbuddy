// GET /api/v1/md/duel/<id>  one duel as markdown: sides, prices, outcome, attacks, decisions with reasoning.
// Served for /duel/<id> when the client prefers text/markdown; see proxy.ts.
import { duelSummary, ID_RE } from "../../../../duel";
import { agentLink, decisions, left, md, near, pointer, sides, time } from "../../md";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const o = new URL(req.url).origin;
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return md("# Not a duel\n\nThe id must be a duel number, e.g. /duel/42.\n", 400);
  let d: Awaited<ReturnType<typeof duelSummary>>;
  try {
    d = await duelSummary(id);
  } catch (e) {
    return md(
      `# Duel #${id}\n\nThe chain could not be read just now (${String(e).slice(0, 120)}). Retry shortly.\n`,
      502,
    );
  }
  if (!d) return md(`# Duel #${id}\n\nNo such duel yet. Live duel: ${o}/arena\n`, 404);
  const outcome = d.resolved
    ? `Resolved. Open $${d.open_price_usd}, close $${d.close_price_usd}. Winner: ${d.winner ? agentLink(o, d.winner) : "tie"}. Slashed ${near(d.slashed_near)}.`
    : `Live: closes ${time(d.closes_at)} (${left(d.seconds_left)}). Open price $${d.open_price_usd}.`;
  const body = [
    `# Duel #${d.duel} · ${d.market}`,
    "",
    pointer(o, `${o}/api/v1/duels/${d.duel}`),
    "",
    `Opened ${time(d.opened_at)}. Pot ${near(d.pot_near)}. ${outcome}`,
    "",
    sides(o, d.a, d.b),
    "",
    `## Attacks (${d.attack_count})`,
    "",
    d.attacks.length
      ? d.attacks
          .map(
            (x) =>
              `- on ${agentLink(o, x.target)} (${x.kind}): "${x.text ?? `unknown text, sha256 ${x.payload_sha256}`}"`,
          )
          .join("\n")
      : d.attack_count
        ? "The contract keeps only the count after a duel resolves; the texts are no longer on the live tape."
        : "None.",
    "",
    "## Decisions, with the model's own reasoning",
    "",
    decisions(o, d.decisions),
    "",
  ];
  return md(body.join("\n"));
}
