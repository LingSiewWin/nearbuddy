"use client";
import { useEffect, useState } from "react";

type Intent = { agent_pk: string; duel_id: string; side: "Long" | "Short"; size_bps: number; nonce: string; expires_at: string; proof_hash: string };
type Agent = { owner: string; pk: string; model_id: string; bond: string; alpha_bps: number; shield: number; in_duel: string | null };
type Injection = { kind: string; payload_hash: string; target: string; block: string };
type Duel = { id: string; a: string; b: string; symbol: string; open_at: string; close_at: string; pool: string; injections: Injection[]; resolved: boolean; last_intent_a: Intent | null; last_intent_b: Intent | null };
type Mandate = { allowance: string; spent: string; per_tx_cap: string; allowed_tokens: string[]; expires_at: string; revoked: boolean };
type Snap = {
  at: number; rpc: string; contract: string; config: { next_duel: string; slash_bps: number; min_chaos_deposit: string };
  leaderboard: Agent[]; duels: (Duel | null)[]; followers: Record<string, [string, Mandate][]>;
  solver: null | { intents: (Intent & { tx: string; quotes: { follower: string; amount: string; quote?: { quote: { amountOutFormatted: string } } }[] })[]; pending: Record<string, { kind: string; payload: string }[]>; fills: { follower: string; tx: string; report: { settled: number; rejected: [number, string][] } }[] };
};

const NEAR = 10n ** 24n;
const near = (y: string | null | undefined, d = 3) => {
  if (!y) return "-";
  const v = BigInt(y); const f = ((v % NEAR) * 10n ** BigInt(d)) / NEAR;
  return `${v / NEAR}.${f.toString().padStart(d, "0")}`;
};
const short = (s: string | null | undefined, n = 10) => (s ? `${s.slice(0, n)}…` : "-");
const ZERO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const W = 100;
const row = (k: string, v: string) => `│ ${k.padEnd(16)} ${v.padEnd(W - 20).slice(0, W - 20)} │`;
const top = (t: string) => `┌─ ${t} ${"─".repeat(Math.max(0, W - t.length - 5))}┐`;
const bottom = () => `└${"─".repeat(W - 2)}┘`;
const ts = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(11, 19);

export default function Arena() {
  const [s, setS] = useState<Snap | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const j = (await (await fetch("/api/arena", { cache: "no-store" })).json()) as Snap; if (alive) setS(j); } catch { /* keep last */ }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  const name = (pk: string) => { const a = s?.leaderboard.find((x) => x.pk === pk); return a ? `${a.model_id} ${short(pk, 6)}` : short(pk); };
  const intentLine = (i: Intent | null, tag: string) => i
    ? `${tag} ${i.side.padEnd(5)} ${(i.size_bps / 100).toFixed(0).padStart(3)}%  nonce ${i.nonce}  proof ${i.proof_hash === ZERO ? "stub (no TEE)" : short(i.proof_hash, 12)}`
    : `${tag} (no intent)`;
  return (
    <pre>
      <span className="hi">NEARBUDDY ARENA</span> <span className="dim">· models duel on live prices, get attacked, get slashed, get followed · NEAR testnet</span>{"\n"}
      <span className="dim">{s ? `snapshot ${new Date(s.at).toISOString()}  contract ${s.contract}  rpc ${s.rpc}` : "connecting"}</span><span className="cursor" />{"\n\n"}
      {top("STANDINGS")}{"\n"}
      {row("", "model                                 alpha bps   shield   bond NEAR   status")}{"\n"}
      {(s?.leaderboard ?? []).map((a) => row(short(a.pk, 8), `${a.model_id.padEnd(36)}  ${String(a.alpha_bps).padStart(8)}   ${String(a.shield).padStart(6)}   ${near(a.bond).padStart(9)}   ${a.in_duel !== null ? `in duel ${a.in_duel}` : "idle"}`)).join("\n")}{"\n"}
      {bottom()}{"\n\n"}
      {(s?.duels ?? []).filter(Boolean).slice(0, 3).map((d) => d && (
        <span key={d.id}>
          {top(`DUEL ${d.id}  ${d.symbol}  ${d.resolved ? "resolved" : "LIVE"}  ${ts(d.open_at)} → ${ts(d.close_at)}  pool ${near(d.pool)} NEAR`)}{"\n"}
          {row("A", name(d.a))}{"\n"}{row("", intentLine(d.last_intent_a, "  "))}{"\n"}
          {row("B", name(d.b))}{"\n"}{row("", intentLine(d.last_intent_b, "  "))}{"\n"}
          {d.injections.length ? d.injections.map((j, k) => row(k ? "" : "chaos", `${j.kind} @${name(j.target)}  sha256 ${short(j.payload_hash, 12)}  block ${j.block}${s?.solver?.pending?.[j.target]?.[0] ? `  "${s.solver.pending[j.target][0].payload.slice(0, 40)}"` : ""}`)).join("\n") : row("chaos", "none")}{"\n"}
          {bottom()}{"\n\n"}
        </span>
      ))}
      {top("FOLLOWERS (mandates, not funds)")}{"\n"}
      {Object.entries(s?.followers ?? {}).flatMap(([pk, list]) => list.map(([who, m]) => row(short(pk, 8), `${who.padEnd(28)} cap ${near(m.per_tx_cap)}  spent ${near(m.spent)}/${near(m.allowance)} NEAR  ${m.allowed_tokens.join(",") || "any token"}  ${m.revoked ? "REVOKED" : `until ${new Date(Number(BigInt(m.expires_at) / 1_000_000n)).toISOString().slice(0, 10)}`}`))).join("\n") || row("", "none yet: pnpm arena-demo")}{"\n"}
      {bottom()}{"\n\n"}
      {top("SOLVER (1Click dry quotes and settled fills; optional, local)")}{"\n"}
      {s?.solver ? [
        ...s.solver.intents.slice(-5).map((i) => row("intent", `${i.side} ${short(i.agent_pk, 6)} nonce ${i.nonce}  tx ${short(i.tx, 10)}  quotes ${i.quotes.map((q) => `${q.follower}: ${near(q.amount)} wNEAR→${q.quote?.quote.amountOutFormatted ?? "?"} USDC`).join("; ") || "no followers"}`)),
        ...s.solver.fills.slice(-5).map((f) => row("settle", `${f.follower}  settled ${f.report.settled}  rejected ${f.report.rejected.map((r) => r[1]).join(", ") || "none"}  tx ${short(f.tx, 10)}`)),
      ].join("\n") || row("", "no activity yet") : row("", "solver offline: page runs on RPC alone")}{"\n"}
      {bottom()}{"\n\n"}
      <span className="dim">how it works: model → decision (TEE-signed on NEAR AI Cloud) → signed intent on chain → followers quoted via NEAR Intents inside their mandate → oracle resolves → loser slashed, winner paid, survivors gain shield</span>
    </pre>
  );
}
