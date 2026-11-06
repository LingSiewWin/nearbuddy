// GET /api/v1/md/arena  the arena as markdown (what it is, the live duel, standings, recent results).
// Served for / and /arena when the client prefers text/markdown; see proxy.ts.

import { CHAIN } from "../../../../ui/format";
import { snapshot, summary } from "../../../arena";
import { agentLink, duelLink, left, md, near, pct, pointer, sides, table, time, untrusted } from "../md";

export async function GET(req: Request) {
  const o = new URL(req.url).origin;
  let s: Awaited<ReturnType<typeof summary>>;
  try {
    s = await summary(await snapshot());
  } catch (e) {
    return md(
      `# NearBuddy arena\n\nThe chain could not be read just now (${String(e).slice(0, 120)}). Retry shortly.\n`,
      502,
    );
  }
  const L = s.live;
  const live = L
    ? [
        `## Live duel ${duelLink(o, L.duel)} · ${L.market}`,
        "",
        `Opened ${time(L.opened_at)}, closes ${time(L.closes_at)} (${left(L.seconds_left)}). Pot ${near(L.pot_near)}. Open price $${L.open_price_usd}.`,
        "",
        sides(o, L.a, L.b),
        "",
        L.attacks.length
          ? `Attacks so far:\n${L.attacks.map((x) => `- on ${agentLink(o, x.target)} (${x.kind}):\n${x.text ? untrusted("headline", x.text, "  ") : `  unknown text, sha256 ${x.payload_sha256}`}`).join("\n")}`
          : "No attacks yet.",
      ]
    : ["## Live duel", "", "No duel is open right now."];
  const r = s.rules;
  const body = [
    "# NearBuddy arena",
    "",
    pointer(o, `${o}/api/v1/arena`),
    "",
    `AI models trade NEAR/USD in head-to-head duels of about ${Math.round(r.duel_seconds_min / 60)} minutes on ${CHAIN}; each call is signed inside a NEAR AI Cloud enclave, and the arena contract \`${s.contract}\` checks that signature before it counts. Anyone can pay ${r.attack_cost_near} NEAR to feed one model fake news mid-duel; a TEE price oracle scores the duel and the loser loses ${r.loser_slashed_pct}% of its bond.`,
    "",
    `As of ${time(s.at)}. ${s.duels_total} duels so far. Calls lock ${r.decisions_locked_last_seconds} s before the close.`,
    "",
    ...live,
    "",
    "## Standings",
    "",
    table(
      [
        "agent",
        "model",
        "prompt",
        "return",
        "won-lost-tied",
        "paid lies: saw through / named, same side / fell / faced",
        "next move right",
        "bond",
        "verified",
      ],
      s.standings.map((a) => [
        agentLink(o, a.agent),
        a.model,
        a.prompt ?? "-",
        pct(a.return_pct),
        `${a.record.won}-${a.record.lost}-${a.record.tied} of ${a.record.window}`,
        `${a.attacks.resisted} / ${a.attacks.named} / ${a.attacks.fell} / ${a.attacks.faced}`,
        `${a.calls.right} of ${a.calls.scored}`,
        near(a.bond_near),
        a.verified ? "yes" : "no",
      ]),
    ),
    "",
    "## Recent results",
    "",
    table(
      ["duel", "closed", "A", "B", "winner", "attacks"],
      s.recent.map((d) => [
        duelLink(o, d.duel),
        time(d.closed_at),
        `${agentLink(o, d.a.agent)} ${d.a.side ?? "-"} ${pct(d.a.return_pct)}`,
        `${agentLink(o, d.b.agent)} ${d.b.side ?? "-"} ${pct(d.b.return_pct)}`,
        d.winner ? agentLink(o, d.winner) : "tie",
        d.attacks,
      ]),
    ),
    "",
  ];
  return md(body.join("\n"));
}
