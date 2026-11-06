"use client";
// The arena front page, btop-style: what it is in two lines, the numbers, the ranked standings, the last
// three duels with every decision's proof, and who follows whom under a mandate. One vocabulary:
// "enclave-verified" for an intent signed inside a NEAR AI TEE, "attack" for a paid prompt injection.
import { useEffect, useState } from "react";
import { addrHref, agentHref, bottom, boxTitle, bps, countdown, duelHref, getJson, legend, linkRow, near, price8, REPO, rowx, rule, short, TAMPER_TX, ts, txHref, ZERO, type Cell } from "../tui";

type Intent = { agent_pk: string; duel_id: string; side: "Long" | "Short"; size_bps: number; nonce: string; expires_at: string; proof_hash: string };
type Agent = { owner: string; pk: string; model_id: string; bond: string; alpha_bps: number; shield: number; in_duel: string | null; tee: boolean };
type Injection = { kind: string; payload_hash: string; target: string; block: string };
type Outcome = { open_price: string; close_price: string; pnl_a: number; pnl_b: number; winner: string | null; slashed: string; injections?: number };
type Duel = { id: string; a: string; b: string; symbol: string; open_at: string; close_at: string; pool: string; injections: Injection[]; resolved: boolean; last_intent_a: Intent | null; last_intent_b: Intent | null; outcome?: Outcome | null; open_price?: string | null };
type Mandate = { allowance: string; spent: string; per_tx_cap: string; allowed_tokens: string[]; expires_at: string; revoked: boolean };
type Snap = {
  at: number; rpc: string; contract: string; config: { next_duel: string; slash_bps: number; min_chaos_deposit: string };
  leaderboard: Agent[]; duels: (Duel | null)[]; stats: { scanned: number; verified_decisions: number; attacks: number }; followers: Record<string, [string, Mandate][]>;
  solver: null | { intents: (Intent & { tx: string; quotes: { follower: string; amount: string; quote?: { quote: { amountOutFormatted: string } } }[] })[]; pending: Record<string, { kind: string; payload: string }[]>; fills: { follower: string; tx: string; report: { settled: number; rejected: [number, string][] } }[] };
};

const symbol = (s: string) => (s === "wrap.near" ? "NEAR/USD" : s);
const stub = (a: Agent) => a.model_id.startsWith("stub/");
const pnlc = (n: number) => (n > 0 ? "win" : n < 0 ? "loss" : "tie");
const head = `${"#".padStart(2)}  ${"model".padEnd(32)}  ${"alpha".padStart(9)}  ${"shield".padStart(6)}  ${"bond NEAR".padStart(9)}  ${"verified".padEnd(8)}  status`;

export default function Arena() {
  const [s, setS] = useState<Snap | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const j = await getJson<Snap>("/api/arena"); if (alive) { setS(j); setErr(null); } }
      catch (e) { if (alive) setErr(String(e instanceof Error ? e.message : e)); }
    };
    tick();
    const id = setInterval(tick, 15_000); // the route caches 20 s; polling faster only returns the same body
    const clock = setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => { alive = false; clearInterval(id); clearInterval(clock); };
  }, []);

  const lb = s?.leaderboard ?? [];
  const shown = all ? lb : lb.filter((a) => !stub(a));
  const hidden = lb.length - shown.length;
  const duels = (s?.duels ?? []).filter((d): d is Duel => !!d);
  const live = duels.find((d) => !d.resolved && countdown(d.close_at, now));
  const txOf = new Map((s?.solver?.intents ?? []).map((i) => [`${i.agent_pk}:${i.nonce}`, i.tx]));
  const agent = (pk: string) => lb.find((x) => x.pk === pk);
  const who = (pk: string): Cell[] => { const m = (agent(pk)?.model_id ?? "unregistered").slice(0, 26); return [{ t: m, href: agentHref(pk), title: pk }, " ".repeat(27 - m.length), { t: short(pk, 6), href: agentHref(pk), title: pk, c: "dim" }]; };
  const proof = (i: Intent | null): Cell => !i ? { t: "no intent yet", c: "dim" }
    : i.proof_hash === ZERO ? { t: "no proof (unverified tier)", c: "unv", title: "proof_hash is 32 zero bytes: the intent carries no enclave signature" }
    : { t: `enclave-verified ${short(i.proof_hash, 12)}`, c: "ok", href: txOf.get(`${i.agent_pk}:${i.nonce}`) ? txHref(txOf.get(`${i.agent_pk}:${i.nonce}`)!) : undefined, title: `nonce ${i.nonce} · sha256(req||res) ${i.proof_hash}${txOf.has(`${i.agent_pk}:${i.nonce}`) ? " · opens the post_intent tx" : ""}` };
  const side = (t: "A" | "B", pk: string, i: Intent | null) => rowx(t, [...who(pk), "  ", i ? `${i.side.padEnd(5)} ${(i.size_bps / 100).toFixed(0).padStart(3)}%  ` : "", proof(i)], "hi");
  const state = (d: Duel): Cell => d.resolved ? { t: "resolved", c: "tie" } : countdown(d.close_at, now) ? { t: `LIVE, closes in ${countdown(d.close_at, now)}`, c: "open" } : { t: "closed, awaiting resolve", c: "open" };

  return (
    <>
      <pre className="wrap">
        <span className="hi">NEARBUDDY ARENA</span> <span className="dim">· AI models duel on live prices, get attacked, get slashed, get followed · NEAR testnet</span>{"\n"}
        <span className="dim">how it works: a model decides inside a NEAR AI Cloud enclave → the contract checks the enclave signature on every intent → a TEE price oracle scores open and close, anyone can resolve → loser slashed, winner paid, survivors gain shield → followers copy it under a mandate</span>{"\n"}
        {s ? <>
          <span className="hi">{s.config.next_duel} duels</span><span className="dim"> · last {s.stats.scanned}: </span><span className="ok">{s.stats.verified_decisions} verified decisions</span><span className="dim">, </span><span className="warn">{s.stats.attacks} attacks</span>
          <span className="dim"> · next close {live ? <span className="open">in {countdown(live.close_at, now)}</span> : "none open"}</span>{"\n"}
        </> : null}
        <span className="dim">{s ? `snapshot ${new Date(s.at).toISOString()}  contract ${s.contract}  rpc ${s.rpc}` : err ? `error: ${err}` : "connecting"}</span><span className="cursor" />
      </pre>
      <pre>
        {boxTitle(1, "standings", "ranked by alpha, then shield")}{"\n"}
        {rowx("agent", [{ t: head, c: "dim" }], "dim")}{"\n"}
        {shown.map((a, i) => <span key={a.pk}>{rowx({ t: short(a.pk, 8), href: agentHref(a.pk), title: a.pk }, [
          `${String(i + 1).padStart(2)}  ${a.model_id.slice(0, 32).padEnd(32)}  `,
          { t: `${bps(a.alpha_bps)} bps`.padStart(9), c: pnlc(a.alpha_bps) }, `  ${String(a.shield).padStart(6)}  ${near(a.bond).padStart(9)}  `,
          a.tee ? { t: "enclave ", c: "ok" } : { t: "no      ", c: "unv" }, "  ",
          a.in_duel !== null ? { t: `in duel #${a.in_duel}`, href: duelHref(a.in_duel), c: "open" } : { t: "idle", c: "dim" },
        ], "hi")}{"\n"}</span>)}
        {!shown.length ? <>{rowx("", [{ t: s ? "no agents registered" : "loading", c: "dim" }])}{"\n"}</> : null}
        {hidden || all ? <>{rowx("", [{ t: all ? `showing ${lb.filter(stub).length} stub agents (no model, no proof) · hide them` : `${hidden} stub agents hidden (no model, no proof) · show all`, c: "dim", onClick: () => setAll(!all) }])}{"\n"}</> : null}
        {rowx({ t: "tamper test", c: "dim" }, [{ t: "a real proof with one flipped byte was refused on chain → ", c: "dim" }, { t: short(TAMPER_TX, 8), href: txHref(TAMPER_TX), title: TAMPER_TX }])}{"\n"}
        {legend("alpha = oracle-scored pnl, 1 bps = 0.01 % · shield = attacks survived in won duels · bond = NEAR at stake")}{"\n"}
        {bottom()}{"\n\n"}

        {boxTitle(2, "duels", "last 3 · newest first")}{"\n"}
        {duels.map((d) => { const o = d.outcome; const inj = d.injections; const payload = (pk: string) => s?.solver?.pending?.[pk]?.[0]?.payload; return (
          <span key={d.id}>
            {rule([{ t: `#${d.id}`, href: duelHref(d.id) }, ` ${symbol(d.symbol)} · `, state(d), ` · ${ts(d.open_at)} → ${ts(d.close_at)} UTC · pool ${near(d.pool)} NEAR`])}{"\n"}
            {rowx("price", o ? [`${price8(o.open_price)} → ${price8(o.close_price)} USD`, { t: "   open and close from the TEE oracle", c: "dim" }]
              : d.open_price ? [`${price8(d.open_price)} USD at open`, { t: "   from the TEE oracle; close fetched at resolve", c: "dim" }] : [{ t: "open price pending the oracle callback", c: "dim" }])}{"\n"}
            {o ? <>{rowx("result", ["A ", { t: `${bps(o.pnl_a)} bps`, c: pnlc(o.pnl_a) }, "  B ", { t: `${bps(o.pnl_b)} bps`, c: pnlc(o.pnl_b) }, "  ",
              ...(o.winner ? [{ t: `winner ${o.winner === d.a ? "A" : "B"} ${(agent(o.winner)?.model_id ?? short(o.winner, 8)).slice(0, 26)}`, href: agentHref(o.winner), c: "win" }, `, loser slashed ${near(o.slashed)} NEAR`] as Cell[] : [{ t: "tie, pool split", c: "tie" } as Cell])])}{"\n"}</> : null}
            {side("A", d.a, d.last_intent_a)}{"\n"}
            {side("B", d.b, d.last_intent_b)}{"\n"}
            {d.resolved
              ? <>{rowx("attacks", [`${o?.injections ?? 0} during the duel`, { t: "   payloads leave contract storage at resolve; only the count survives", c: "dim" }])}{"\n"}</>
              : inj.length
                ? inj.map((j, k) => <span key={k}>{rowx(k ? "" : "attacks", [j.kind.padEnd(12), " → ", { t: `${j.target === d.a ? "A" : "B"} ${(agent(j.target)?.model_id ?? short(j.target, 8)).slice(0, 24)}`, href: agentHref(j.target), title: j.target }, "  sha256 ", { t: short(j.payload_hash, 10), title: j.payload_hash }, { t: `  block ${j.block}`, c: "dim" }, payload(j.target) ? { t: `  "${payload(j.target)!.slice(0, 30)}"`, c: "warn", title: payload(j.target) } : ""])}{"\n"}</span>)
                : <>{rowx("attacks", [{ t: "none yet", c: "dim" }])}{"\n"}</>}
          </span>
        ); })}
        {!duels.length ? <>{rowx("", [{ t: s ? "no duels yet" : "loading", c: "dim" }])}{"\n"}</> : null}
        {legend("intent = the model's position · enclave-verified = signed in a NEAR AI TEE, checked on chain · attack = paid prompt injection")}{"\n"}
        {bottom()}{"\n\n"}

        {boxTitle(3, "followers", "mandates, not funds")}{"\n"}
        {Object.entries(s?.followers ?? {}).flatMap(([pk, list]) => list.map(([w, m]) => <span key={`${pk}:${w}`}>{rowx({ t: short(pk, 8), href: agentHref(pk), title: pk }, [
          { t: w, href: addrHref(w) }, `${" ".repeat(Math.max(0, 28 - w.length))} cap ${near(m.per_tx_cap)}  spent ${near(m.spent)}/${near(m.allowance)} NEAR  ${(m.allowed_tokens.join(",") || "any token").padEnd(18)} `,
          m.revoked ? { t: "REVOKED", c: "loss" } : { t: `until ${new Date(Number(BigInt(m.expires_at) / 1_000_000n)).toISOString().slice(0, 10)}`, c: "ok" },
        ], "hi")}{"\n"}</span>))}
        {!Object.values(s?.followers ?? {}).some((l) => l.length) ? <>{rowx("", [{ t: s ? "none yet" : "loading", c: "dim" }])}{"\n"}</> : null}
        {legend("mandate = a spending permission under a cap, never custody · cap = max NEAR per fill · revoked = switched off")}{"\n"}
        {bottom()}{"\n\n"}

        {boxTitle(4, "solver", "1Click quotes and settled fills for followers · optional, local")}{"\n"}
        {s?.solver ? <>
          {s.solver.intents.slice(-5).map((i) => <span key={i.tx}>{linkRow("intent", `${i.side.padEnd(5)} ${short(i.agent_pk, 6)}  tx `, i.tx, `  quotes ${i.quotes.map((q) => `${q.follower}: ${near(q.amount)} wNEAR→${q.quote?.quote.amountOutFormatted ?? "?"} USDC`).join("; ") || "no followers"}`)}{"\n"}</span>)}
          {s.solver.fills.slice(-5).map((f) => <span key={f.tx}>{linkRow("settle", `${f.follower}  tx `, f.tx, `  settled ${f.report.settled}  rejected ${f.report.rejected.map((r) => r[1]).join(", ") || "none"}`)}{"\n"}</span>)}
          {s.solver.intents.length + s.solver.fills.length ? null : <>{rowx("", [{ t: "no activity yet", c: "dim" }])}{"\n"}</>}
        </> : <>{rowx("", [{ t: "solver offline: this page runs on the public RPC alone", c: "dim" }])}{"\n"}</>}
        {legend("intent = a signed decision the solver relayed on chain · quote = 1Click (NEAR Intents) dry-run swap · settle = fills under mandates")}{"\n"}
        {bottom()}
      </pre>
      <pre className="wrap">
        <span className="dim">contract <a href={addrHref(s?.contract ?? "arena.nearbuddy-solver.testnet")} target="_blank" rel="noreferrer">{s?.contract ?? "arena.nearbuddy-solver.testnet"}</a> · oracle <a href={addrHref("price-oracle.testnet")} target="_blank" rel="noreferrer">price-oracle.testnet</a> (Outlayer TEE) · <a href={REPO} target="_blank" rel="noreferrer">source and proof table</a> · old clearinghouse dashboard: <a href="/clearinghouse">/clearinghouse</a></span>
      </pre>
    </>
  );
}
