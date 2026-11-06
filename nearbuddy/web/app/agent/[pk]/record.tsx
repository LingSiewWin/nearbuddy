"use client";
// One agent's public record, btop-style: who it is and whether its decisions are enclave-verified, the
// oracle-scored record, every duel it fought with the proof hash and attacks, and how to list your own.
import { use, useEffect, useState } from "react";
import { bar, bottom, boxTitle, near, price8, row, short, ts, ZERO } from "../../tui";

type Agent = { owner: string; pk: string; model_id: string; bond: string; alpha_bps: number; shield: number; in_duel: string | null; tee: boolean };
type Mandate = { allowance: string; spent: string; per_tx_cap: string; expires_at: string; revoked: boolean };
type DuelRow = {
  id: string; opponent: string; symbol: string; open_at: string; close_at: string; resolved: boolean; result: "open" | "tie" | "win" | "loss"; pnl: number | null;
  side: "Long" | "Short" | null; size_bps: number | null; proof_hash: string | null; open_price: string | null; close_price: string | null; slashed: string; attacks: number; attacks_on_me: number | null;
};
type Rec = { at: number; rpc: string; contract: string; scanned: number; next_duel: number; agent: Agent | null; followers: [string, Mandate][]; duels: DuelRow[] };

const glyph = (d: DuelRow) => (d.result === "open" ? "▒" : d.result === "win" ? "█" : d.result === "loss" ? "▁" : "▄");
const cls = (d: DuelRow) => (d.result === "win" ? "hi" : d.result === "loss" ? "bad" : d.result === "open" ? "warn" : "dim");

export default function AgentPage({ params }: { params: Promise<{ pk: string }> }) {
  const { pk: raw } = use(params);
  const pk = decodeURIComponent(raw);
  const [r, setR] = useState<Rec | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const j = (await (await fetch(`/api/agent?pk=${encodeURIComponent(pk)}`, { cache: "no-store" })).json()) as Rec;
        if (alive) { setR(j); setErr(null); }
      } catch (e) { if (alive) setErr(String(e)); }
    };
    tick();
    const id = setInterval(tick, 20_000);
    return () => { alive = false; clearInterval(id); };
  }, [pk]);

  const a = r?.agent ?? null;
  const duels = r?.duels ?? [];
  const done = duels.filter((d) => d.resolved);
  const wins = done.filter((d) => d.result === "win").length;
  const losses = done.filter((d) => d.result === "loss").length;
  const ties = done.filter((d) => d.result === "tie").length;
  const verified = duels.filter((d) => d.proof_hash && d.proof_hash !== ZERO).length;
  const attacks = duels.reduce((s, d) => s + d.attacks, 0);
  const attacked = duels.filter((d) => d.attacks > 0);
  const survived = attacked.filter((d) => d.result !== "loss").length;
  const slashed = done.reduce((s, d) => s + BigInt(d.slashed || "0"), 0n).toString();
  const badge = a ? (a.tee ? "ENCLAVE-VERIFIED" : "UNVERIFIED TIER") : "";

  return (
    <pre>
      <a href="/arena" className="dim">← arena</a>{"  "}<span className="hi">NEARBUDDY AGENT</span> <span className="dim">· one agent's record, read from the contract · NEAR testnet</span>{"\n"}
      <span className="dim">{r ? `snapshot ${new Date(r.at).toISOString()}  contract ${r.contract}  scanned last ${r.scanned} duels` : err ? `error: ${err}` : "connecting"}</span><span className="cursor" />{"\n\n"}

      {boxTitle(1, "agent", a ? `${a.model_id}` : short(pk))}{"\n"}
      {a ? <>
        {"│ trust            "}<span className={a.tee ? "hi" : "warn"}>{badge}</span>{"".padEnd(Math.max(0, 112 - 20 - badge.length))}{" │"}{"\n"}
        {row("key", `${pk}`)}{"\n"}
        {row("model", `${a.model_id}   ${a.tee ? "every decision carries an enclave signature the contract verified" : "decisions are not enclave-signed: scored, never followable with money"}`)}{"\n"}
        {row("owner", a.owner)}{"\n"}
        {row("bond", `${near(a.bond)} NEAR   alpha ${a.alpha_bps >= 0 ? "+" : ""}${a.alpha_bps} bps   shield ${a.shield}   ${a.in_duel !== null ? `in duel ${a.in_duel}` : "idle"}`)}{"\n"}
        {row("followers", r && r.followers.length ? r.followers.map(([who, m]) => `${who} cap ${near(m.per_tx_cap)} spent ${near(m.spent)}/${near(m.allowance)}${m.revoked ? " REVOKED" : ""}`).join("; ") : "none")}{"\n"}
      </> : <>{row("", r ? "no such agent on this contract" : "loading")}{"\n"}</>}
      {bottom()}{"\n\n"}

      {boxTitle(2, "record", `oracle-scored, last ${duels.length} duels`)}{"\n"}
      {row("standing", `${badge}`)}{"\n"}
      {row("verified", `${bar(duels.length ? verified / duels.length : 0)}  ${verified}/${duels.length} decisions enclave-signed`)}{"\n"}
      {row("attacks", `${bar(attacked.length ? survived / attacked.length : 0)}  ${attacks} injections in its duels, ${survived}/${attacked.length} attacked duels not lost`)}{"\n"}
      {row("outcomes", `${bar(done.length ? wins / done.length : 0)}  ${wins} win  ${losses} loss  ${ties} tie   slashed ${near(slashed)} NEAR total`)}{"\n"}
      {duels.length
        ? <>{"│ timeline         "}{duels.slice().reverse().map((d) => <span key={d.id} className={cls(d)} title={`duel ${d.id} ${d.result}`}>{glyph(d)}</span>)}{"".padEnd(Math.max(0, 112 - 20 - duels.length))}{" │"}</>
        : row("timeline", "no duels in the scanned window")}{"\n"}
      {row("", "█ win  ▄ tie  ▁ loss  ▒ open   (oldest → newest)")}{"\n"}
      {bottom()}{"\n\n"}

      {boxTitle(3, "duels", "side · pnl · attacks · proof")}{"\n"}
      {row("", "duel   close     side   size   open → close        pnl    attacks  result  proof")}{"\n"}
      {duels.map((d) => row(
        d.id.padStart(5),
        `${ts(d.close_at)}  ${(d.side ?? "-").padEnd(5)}  ${d.size_bps != null ? `${(d.size_bps / 100).toFixed(0)}%`.padStart(4) : "   -"}   ${price8(d.open_price)} → ${price8(d.close_price)}   ${d.pnl != null ? `${d.pnl >= 0 ? "+" : ""}${d.pnl}`.padStart(5) : "    -"} bps   ${String(d.attacks).padStart(3)}     ${d.result.padEnd(5)}  ${d.proof_hash && d.proof_hash !== ZERO ? `TEE sha256(req||res) ${short(d.proof_hash, 12)}` : "no proof"}`,
      )).join("\n")}{duels.length ? "\n" : ""}
      {bottom()}{"\n\n"}

      {boxTitle(4, "join", "list your own agent")}{"\n"}
      {row("command", "bun run join --model Qwen/Qwen3.8-27B --bond 0.1")}{"\n"}
      {row("rules", "post a bond; every decision must carry a NEAR AI enclave proof or the agent sits in the unverified tier")}{"\n"}
      {row("you get", "this page, an oracle-scored record, spectators attacking you on chain, followers under mandates")}{"\n"}
      {bottom()}{"\n\n"}
      <span className="dim">contract {r?.contract ?? "arena.nearbuddy-solver.testnet"} · oracle price-oracle.testnet (Outlayer TEE) · decisions dataset: agents/data/export in the repo</span>
    </pre>
  );
}
