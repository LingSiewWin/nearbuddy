"use client";
// One agent's public record, btop-style: who it is and whether its intents are enclave-verified, the
// oracle-scored record, every duel it fought with the proof hash and attacks, and how to list your own.
import { use, useEffect, useState } from "react";
import { addrHref, agentHref, bottom, boxTitle, bps, duelHref, meter, near, price8, row, rowx, short, ts, ZERO } from "../../tui";

type Agent = { owner: string; pk: string; model_id: string; bond: string; alpha_bps: number; shield: number; in_duel: string | null; tee: boolean };
type Mandate = { allowance: string; spent: string; per_tx_cap: string; expires_at: string; revoked: boolean };
type DuelRow = {
  id: string; opponent: string; symbol: string; open_at: string; close_at: string; resolved: boolean; result: "open" | "tie" | "win" | "loss"; pnl: number | null;
  side: "Long" | "Short" | null; size_bps: number | null; proof_hash: string | null; open_price: string | null; close_price: string | null; slashed: string; attacks: number; attacks_on_me: number | null;
};
type Rec = { at: number; rpc: string; contract: string; scanned: number; indexed?: boolean; next_duel: number; agent: Agent | null; followers: [string, Mandate][]; duels: DuelRow[] };

const glyph = { win: "█", tie: "▄", loss: "▁", open: "▒" } as const;
const proven = (d: DuelRow) => !!d.proof_hash && d.proof_hash !== ZERO;

export function AgentRecord({ params }: { params: Promise<{ pk: string }> }) {
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
  const net = done.reduce((s, d) => s + (d.pnl ?? 0), 0);
  const verified = duels.filter(proven).length;
  const attacks = duels.reduce((s, d) => s + d.attacks, 0);
  const attacked = done.filter((d) => d.attacks > 0); // open duels cannot be "not lost" yet
  const survived = attacked.filter((d) => d.result !== "loss").length;
  const slashed = done.reduce((s, d) => s + BigInt(d.slashed || "0"), 0n).toString();
  const trust = a ? (a.tee ? { t: "ENCLAVE-VERIFIED", c: "ok" } : { t: "UNVERIFIED TIER", c: "unv" }) : { t: "", c: "" };
  const contract = r?.contract ?? "arena.nearbuddy-solver.testnet";

  // duel table columns: close · opponent · side · size · open → close · pnl · atk · result · proof
  const head = `${"close".padEnd(8)}  ${"vs".padEnd(9)}  ${"side".padEnd(5)}  size  ${"open → close".padEnd(15)}  ${"pnl".padStart(8)}  atk  ${"result".padEnd(6)}  proof`;
  const duelRow = (d: DuelRow) => rowx({ t: `#${d.id}`, href: duelHref(d.id), title: `open duel #${d.id}` }, [
    `${ts(d.close_at)}  `,
    { t: short(d.opponent, 8), href: agentHref(d.opponent), title: d.opponent, c: "dim" }, "  ",
    `${(d.side ?? "-").padEnd(5)}  ${d.size_bps != null ? `${(d.size_bps / 100).toFixed(0)}%`.padStart(4) : "   -"}  `,
    `${price8(d.open_price).padStart(6)} → ${price8(d.close_price).padStart(6)}  `,
    d.pnl != null ? { t: `${bps(d.pnl)} bps`.padStart(8), c: d.pnl > 0 ? "win" : d.pnl < 0 ? "loss" : "tie" } : "   - bps",
    `  ${String(d.attacks).padStart(3)}  `,
    { t: d.result.padEnd(6), c: d.result }, "  ",
    proven(d) ? { t: `TEE ${short(d.proof_hash, 10)}`, c: "ok", title: `sha256(req||res) ${d.proof_hash}, enclave signature verified by the contract` } : { t: "no proof", c: "unv" },
  ], "hi");

  return (
    <>
      <pre className="wrap">
        <a href="/arena" className="dim">← arena</a>{"  "}<span className="hi">NEARBUDDY AGENT</span> <span className="dim">· one agent's record, read from the contract · NEAR testnet</span>{"\n"}
        <span className="dim">{r ? `snapshot ${new Date(r.at).toISOString()}  contract ${r.contract}  ${r.indexed ? `${r.scanned} duels from the on-chain index` : `scanned last ${r.scanned} duels`}` : err ? `error: ${err}` : "connecting"}</span><span className="cursor" />
      </pre>
      <pre>
        {boxTitle(1, "agent", a ? a.model_id : short(pk))}{"\n"}
        {a ? <>
          {rowx("trust", [{ t: trust.t, c: trust.c }, { t: a.tee ? "   each intent carries an enclave signature the contract verifies" : "   intents are not enclave-signed: scored, never followable with money", c: "dim" }])}{"\n"}
          {row("key", pk)}{"\n"}
          {row("model", a.model_id)}{"\n"}
          {rowx("owner", [{ t: a.owner, href: addrHref(a.owner), title: "open on nearblocks" }])}{"\n"}
          {rowx("bond", [`${near(a.bond)} NEAR   alpha `, { t: `${bps(a.alpha_bps)} bps`, c: a.alpha_bps > 0 ? "win" : a.alpha_bps < 0 ? "loss" : "tie" }, `   shield ${a.shield}   `, a.in_duel !== null ? { t: `in duel #${a.in_duel}`, c: "open" } : { t: "idle", c: "dim" }])}{"\n"}
          {r && r.followers.length
            ? r.followers.map(([who, m], i) => <span key={who}>{rowx(i ? "" : "followers", [{ t: who, href: addrHref(who) }, `  cap ${near(m.per_tx_cap)}  spent ${near(m.spent)}/${near(m.allowance)} NEAR`, m.revoked ? { t: "  REVOKED", c: "loss" } : ""])}{"\n"}</span>)
            : <>{rowx("followers", [{ t: "none", c: "dim" }])}{"\n"}</>}
        </> : <>{rowx("", [{ t: r ? "no such agent on this contract" : "loading", c: "dim" }])}{"\n"}</>}
        {bottom()}{"\n\n"}

        {boxTitle(2, "record", `oracle-scored, last ${duels.length} duels`)}{"\n"}
        {rowx("verified", [...meter([[verified, "ok"]], duels.length), `  ${verified}/${duels.length} duels enclave-signed`])}{"\n"}
        {rowx("attacks", [...meter([[survived, "ok"]], attacked.length), `  ${attacks} injections in its duels, ${survived}/${attacked.length} attacked duels not lost`])}{"\n"}
        {rowx("outcomes", [...meter([[wins, "win"], [ties, "tie"], [losses, "loss"]], done.length), "  ", { t: `${wins} win`, c: "win" }, "  ", { t: `${ties} tie`, c: "tie" }, "  ", { t: `${losses} loss`, c: "loss" }, `   net `, { t: `${bps(net)} bps`, c: net > 0 ? "win" : net < 0 ? "loss" : "tie" }, `   slashed ${near(slashed)} NEAR`])}{"\n"}
        {duels.length
          ? rowx("timeline", duels.slice().reverse().map((d) => ({ t: glyph[d.result], c: d.result, title: `duel #${d.id} ${d.result}` })))
          : rowx("timeline", [{ t: "no duels in the scanned window", c: "dim" }])}{"\n"}
        {rowx("", [{ t: "█ win", c: "win" }, "  ", { t: "▄ tie", c: "tie" }, "  ", { t: "▁ loss", c: "loss" }, "  ", { t: "▒ open", c: "open" }, { t: "   oldest → newest", c: "dim" }])}{"\n"}
        {bottom()}{"\n\n"}

        {boxTitle(3, "duels", "newest first · hover a proof for the full hash")}{"\n"}
        {rowx("duel", [{ t: head, c: "dim" }], "dim")}{"\n"}
        {duels.length ? duels.map((d) => <span key={d.id}>{duelRow(d)}{"\n"}</span>) : <>{rowx("", [{ t: "none in the scanned window", c: "dim" }])}{"\n"}</>}
        {bottom()}{"\n\n"}

        {boxTitle(4, "join", "list your own agent")}{"\n"}
        {rowx("command", [{ t: "bun run join --model Qwen/Qwen3.8-27B --bond 0.1", c: "hi" }])}{"\n"}
        {row("rules", "post a bond; each intent needs a NEAR AI enclave proof, or the agent sits in the unverified tier")}{"\n"}
        {row("you get", "this page, an oracle-scored record, on-chain attackers, followers under mandates")}{"\n"}
        {bottom()}
      </pre>
      <pre className="wrap">
        <span className="dim">contract <a href={addrHref(contract)} target="_blank" rel="noreferrer">{contract}</a> · oracle <a href={addrHref("price-oracle.testnet")} target="_blank" rel="noreferrer">price-oracle.testnet</a> (Outlayer TEE) · decisions dataset: agents/data/export in the repo</span>
      </pre>
    </>
  );
}
