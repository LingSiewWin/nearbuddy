"use client";
// The arena record, btop-style: what it is in two lines, the numbers, the ranked standings of the models that
// fight (test fixtures and the red team's own agents left out), and the last three duels with every decision's
// proof. One vocabulary: "enclave-verified" for an intent signed inside a NEAR AI TEE, "attack" for a paid
// prompt injection.
import { useEffect, useState } from "react";
import {
  type CommitConfig,
  commitWord,
  isStubModel,
  kindCell,
  type Pair,
  pairCells,
  pairingWord,
  proven,
  shownPairs,
} from "../cells";
import type { EraSplit } from "../eras";
import type { AgentView as Agent } from "../lib/abi/arena"; // passed through unchanged by the API route
import {
  addrHref,
  agentHref,
  bottom,
  boxTitle,
  bps,
  type Cell,
  countdown,
  duelHref,
  getJson,
  legend,
  NET,
  NETWORK_ID,
  near,
  price8,
  REPO,
  rowx,
  rule,
  short,
  ts,
  txHref,
  ZERO,
} from "../tui";

type Intent = {
  agent_pk: string;
  duel_id: string;
  side: "Long" | "Short";
  size_bps: number;
  nonce: string;
  expires_at: string;
  proof_hash: string;
};
type Injection = { kind: string; payload_hash: string; target: string; block: string };
type Outcome = {
  open_price: string;
  close_price: string;
  pnl_a: number;
  pnl_b: number;
  winner: string | null;
  slashed: string;
  injections?: number;
};
type Duel = {
  id: string;
  a: string;
  b: string;
  symbol: string;
  open_at: string;
  close_at: string;
  pool: string;
  injections: Injection[];
  resolved: boolean;
  last_intent_a: Intent | null;
  last_intent_b: Intent | null;
  outcome?: Outcome | null;
  open_price?: string | null;
  /** Deploy 17: the duel's chaos records (the newest three duels carry them). */
  chaos?: { outcome: string }[] | null;
};
type Snap = {
  at: number;
  rpc: string;
  contract: string;
  config: { next_duel: string; slash_bps: number; min_chaos_deposit: string } & CommitConfig;
  leaderboard: Agent[];
  duels: (Duel | null)[];
  stats: { scanned: number; verified_decisions: number; attacks: number; pairs?: Pair[] };
  // absent: lifetime only. `complete` false: some oracle-era duel is unread, so the split is not shown
  eras?: {
    from: number;
    complete?: boolean;
    unread?: number;
    operator_duels: number;
    oracle_duels: number;
    by_agent: EraSplit;
  };
  solver: null | {
    intents: (Intent & { tx: string })[];
    pending: Record<string, { kind: string; payload: string }[]>;
  };
};

const symbol = (s: string) => (s === "wrap.near" ? "NEAR/USD" : s);
/** Test fixtures (stub models) and the red team's own agents: not contenders, so not on a public board. */
const fixture = (a: Agent | undefined) => !!a && (isStubModel(a.model_id) || a.model_id.startsWith("redteam/"));
const pnlc = (n: number) => (n > 0 ? "win" : n < 0 ? "loss" : "tie");
const head = `${"#".padStart(2)}  ${"model".padEnd(32)}  ${"alpha".padStart(9)}  ${"shield".padStart(6)}  ${"bond NEAR".padStart(9)}  ${"verified".padEnd(8)}  status`;

export default function Arena() {
  const [s, setS] = useState<Snap | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const j = await getJson<Snap>("/api/arena");
        if (alive) {
          setS(j);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(String(e instanceof Error ? e.message : e));
      }
    };
    tick();
    const id = setInterval(tick, 15_000); // the route caches 20 s; polling faster only returns the same body
    const clock = setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => {
      alive = false;
      clearInterval(id);
      clearInterval(clock);
    };
  }, []);

  const lb = s?.leaderboard ?? [];
  const eras = s?.eras;
  // the split ranks only when complete (an unread duel would shift alpha) and when there is an operator era at all
  const split = !!eras && eras.complete !== false && eras.from > 0;
  const byEra = split;
  // default: alpha and rank from the oracle era; the contract's leaderboard order is the lifetime order
  const alphaOf = (a: Agent) => (byEra ? (eras?.by_agent[a.pk]?.oracle.alpha_bps ?? a.alpha_bps) : a.alpha_bps);
  const ranked = byEra ? [...lb].sort((x, y) => alphaOf(y) - alphaOf(x) || y.shield - x.shield) : lb;
  const shown = ranked.filter((a) => !fixture(a));
  const eraTitle = (a: Agent) => {
    const e = split ? eras?.by_agent[a.pk] : undefined;
    return e
      ? `duels ${eras?.from}+ ${bps(e.oracle.alpha_bps)} bps · operator era ${bps(e.operator_alpha_bps)} bps · lifetime ${bps(a.alpha_bps)} bps`
      : `lifetime ${bps(a.alpha_bps)} bps`;
  };
  const duels = (s?.duels ?? []).filter((d): d is Duel => !!d);
  const live = duels.find((d) => !d.resolved && countdown(d.close_at, now));
  const txOf = new Map((s?.solver?.intents ?? []).map((i) => [`${i.agent_pk}:${i.nonce}`, i.tx]));
  const agent = (pk: string) => lb.find((x) => x.pk === pk);
  // the newest running pairs, pair 1 = started first; [] unless 2+. Fixture pairs are left out like their agents
  const pairs = shownPairs(s?.stats.pairs, (pk) => fixture(agent(pk)));
  /** Model name without its org: "z-ai/glm-5.3-flash" → "glm-5.3-flash". */
  const model = (pk: string) => agent(pk)?.model_id.split("/").pop() ?? short(pk, 8);
  const who = (pk: string): Cell[] => {
    const m = (agent(pk)?.model_id ?? "unregistered").slice(0, 26);
    return [
      { t: m, href: agentHref(pk), title: pk },
      " ".repeat(27 - m.length),
      { t: short(pk, 6), href: agentHref(pk), title: pk, c: "dim" },
    ];
  };
  const proof = (i: Intent | null): Cell =>
    !i
      ? { t: "no intent yet", c: "dim" }
      : !proven(i, ZERO)
        ? {
            t: "no proof (unverified tier)",
            c: "unv",
            title: "proof_hash is 32 zero bytes: the intent carries no enclave signature",
          }
        : {
            t: `enclave-verified ${short(i.proof_hash, 12)}`,
            c: "ok",
            href: txOf.get(`${i.agent_pk}:${i.nonce}`) ? txHref(txOf.get(`${i.agent_pk}:${i.nonce}`)!) : undefined,
            title: `nonce ${i.nonce} · sha256(req||res) ${i.proof_hash}${txOf.has(`${i.agent_pk}:${i.nonce}`) ? " · opens the post_intent tx" : ""}`,
          };
  const side = (t: "A" | "B", pk: string, i: Intent | null) =>
    rowx(
      t,
      [...who(pk), "  ", i ? `${i.side.padEnd(5)} ${(i.size_bps / 100).toFixed(0).padStart(3)}%  ` : "", proof(i)],
      "hi",
    );
  const state = (d: Duel): Cell =>
    d.resolved
      ? { t: "resolved", c: "tie" }
      : countdown(d.close_at, now)
        ? { t: `LIVE, closes in ${countdown(d.close_at, now)}`, c: "open" }
        : { t: "closed, awaiting resolve", c: "open" };

  return (
    <>
      <pre className="wrap">
        <span className="hi">NEARBUDDY ARENA</span>{" "}
        <span className="dim">· AI models duel on live prices, get attacked, get slashed · NEAR {NETWORK_ID}</span>
        {"\n"}
        <span className="dim">
          how it works: a model decides inside a NEAR AI Cloud enclave → the contract checks the enclave signature on
          every intent → a TEE price oracle scores open and close, anyone can resolve → loser slashed, winner paid,
          survivors gain shield · anyone can plant a fake headline at a side mid-duel: <a href="/">fool the AI</a>
        </span>
        {"\n"}
        {s ? (
          <>
            <span className="hi">{s.config.next_duel} duels</span>
            <span className="dim"> · last {s.stats.scanned}: </span>
            <span className="ok">{s.stats.verified_decisions} verified decisions</span>
            <span className="dim">, </span>
            <span className="warn">{s.stats.attacks} attacks</span>
            <span className="dim"> · commit-reveal </span>
            <span
              className={s.config.commit_reveal ? "ok" : "dim"}
              title={s.config.commit_reveal ? "calls hidden until reveal" : "intents are posted in the clear"}
            >
              {commitWord(s.config)}
            </span>
            {pairingWord(s.config) ? (
              <>
                <span className="dim"> · pairing: </span>
                <span
                  className={s.config.require_consent ? "ok" : "dim"}
                  title={
                    s.config.require_consent
                      ? "both agents sign every pairing (open_duel_consented)"
                      : "the owner may pair agents without their signatures"
                  }
                >
                  {pairingWord(s.config)}
                </span>
              </>
            ) : null}
            <span className="dim">
              {" "}
              · next close {live ? <span className="open">in {countdown(live.close_at, now)}</span> : "none open"}
            </span>
            {"\n"}
          </>
        ) : null}
        <span className="dim">
          {s
            ? `snapshot ${new Date(s.at).toISOString()}  contract ${s.contract}  rpc ${s.rpc}`
            : err
              ? `error: ${err}`
              : "connecting"}
        </span>
        <span className="cursor" />
      </pre>
      <pre>
        {boxTitle(
          1,
          "standings",
          byEra ? `ranked by alpha from duel ${eras.from} on, then shield` : "ranked by lifetime alpha, then shield",
        )}
        {"\n"}
        {rowx("agent", [{ t: head, c: "dim" }], "dim")}
        {"\n"}
        {shown.map((a, i) => (
          <span key={a.pk}>
            {rowx(
              { t: short(a.pk, 8), href: agentHref(a.pk), title: a.pk },
              [
                `${String(i + 1).padStart(2)}  ${a.model_id.slice(0, 32).padEnd(32)}  `,
                {
                  t: `${bps(alphaOf(a))} bps`.padStart(9),
                  c: pnlc(alphaOf(a)),
                  title: eraTitle(a),
                },
                `  ${String(a.shield).padStart(6)}  ${near(a.bond).padStart(9)}  `,
                a.tee ? { t: "enclave ", c: "ok" } : { t: "no      ", c: "unv" },
                "  ",
                a.in_duel !== null
                  ? { t: `in duel #${a.in_duel}`, href: duelHref(a.in_duel), c: "open" }
                  : { t: "idle", c: "dim" },
              ],
              "hi",
            )}
            {"\n"}
          </span>
        ))}
        {!shown.length ? (
          <>
            {rowx("", [{ t: s ? "no agents registered" : "loading", c: "dim" }])}
            {"\n"}
          </>
        ) : null}
        {legend(
          `alpha = pnl summed over ${byEra ? `duels ${eras.from}+, scored by the TEE oracle` : "every scored duel"}, 1 bps = 0.01 % · shield = attacks held in won duels · bond = NEAR at stake`,
        )}
        {"\n"}
        {bottom()}
        {"\n\n"}

        {boxTitle(2, "duels", "last 3 · newest first")}
        {"\n"}
        {pairs.map((p, i) => (
          <span key={`${p.a}|${p.b}`}>
            {rowx({ t: `pair ${i + 1}`, c: "dim" }, pairCells(p, model, s?.stats.scanned))}
            {"\n"}
          </span>
        ))}
        {duels.map((d) => {
          const o = d.outcome;
          const inj = d.injections;
          const payload = (pk: string) => s?.solver?.pending?.[pk]?.[0]?.payload;
          return (
            <span key={d.id}>
              {rule([
                { t: `#${d.id}`, href: duelHref(d.id) },
                ` ${symbol(d.symbol)} · `,
                state(d),
                ` · ${ts(d.open_at)} → ${ts(d.close_at)} UTC · pool ${near(d.pool)} NEAR`,
              ])}
              {"\n"}
              {rowx(
                "price",
                o
                  ? [
                      `${price8(o.open_price)} → ${price8(o.close_price)} USD`,
                      { t: "   open and close from the TEE oracle", c: "dim" },
                    ]
                  : d.open_price
                    ? [
                        `${price8(d.open_price)} USD at open`,
                        { t: "   from the TEE oracle; close fetched at resolve", c: "dim" },
                      ]
                    : [{ t: "open price pending the oracle callback", c: "dim" }],
              )}
              {"\n"}
              {o ? (
                <>
                  {rowx("result", [
                    "A ",
                    { t: `${bps(o.pnl_a)} bps`, c: pnlc(o.pnl_a) },
                    "  B ",
                    { t: `${bps(o.pnl_b)} bps`, c: pnlc(o.pnl_b) },
                    "  ",
                    ...(o.winner
                      ? ([
                          {
                            t: `winner ${o.winner === d.a ? "A" : "B"} ${(agent(o.winner)?.model_id ?? short(o.winner, 8)).slice(0, 26)}`,
                            href: agentHref(o.winner),
                            c: "win",
                          },
                          `, loser slashed ${near(o.slashed)} NEAR`,
                        ] as Cell[])
                      : [{ t: "tie, pool split", c: "tie" } as Cell]),
                  ])}
                  {"\n"}
                </>
              ) : null}
              {side("A", d.a, d.last_intent_a)}
              {"\n"}
              {side("B", d.b, d.last_intent_b)}
              {"\n"}
              {d.resolved ? (
                <>
                  {rowx("attacks", [
                    `${Math.max(d.chaos?.length ?? 0, o?.injections ?? 0)} during the duel`,
                    d.chaos?.length
                      ? {
                          t: `   ${d.chaos.filter((c) => c.outcome === "Flipped").length} flipped, ${d.chaos.filter((c) => c.outcome === "Held").length} held · every headline on the duel page`,
                          c: "dim",
                        }
                      : o?.injections
                        ? { t: "   planted before deploy 17: only the count stays on chain", c: "dim" }
                        : "",
                  ])}
                  {"\n"}
                </>
              ) : inj.length ? (
                inj.map((j, k) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: on-chain order, append-only
                  <span key={k}>
                    {rowx(k ? "" : "attacks", [
                      kindCell(j.kind),
                      " → ",
                      {
                        t: `${j.target === d.a ? "A" : "B"} ${(agent(j.target)?.model_id ?? short(j.target, 8)).slice(0, 24)}`,
                        href: agentHref(j.target),
                        title: j.target,
                      },
                      "  sha256 ",
                      { t: short(j.payload_hash, 10), title: j.payload_hash },
                      { t: `  block ${j.block}`, c: "dim" },
                      payload(j.target)
                        ? { t: `  "${payload(j.target)!.slice(0, 30)}"`, c: "warn", title: payload(j.target) }
                        : "",
                    ])}
                    {"\n"}
                  </span>
                ))
              ) : (
                <>
                  {rowx("attacks", [{ t: "none yet", c: "dim" }])}
                  {"\n"}
                </>
              )}
            </span>
          );
        })}
        {!duels.length ? (
          <>
            {rowx("", [{ t: s ? "no duels yet" : "loading", c: "dim" }])}
            {"\n"}
          </>
        ) : null}
        {legend(
          "intent = the model's position · enclave-verified = signed in a NEAR AI TEE, checked on chain · attack = paid prompt injection",
        )}
        {"\n"}
        {bottom()}
      </pre>
      <pre className="wrap">
        <span className="dim">
          contract{" "}
          <a href={addrHref(s?.contract ?? NET.arena)} target="_blank" rel="noreferrer">
            {s?.contract ?? NET.arena}
          </a>{" "}
          · oracle{" "}
          <a href={addrHref(NET.oracle)} target="_blank" rel="noreferrer">
            {NET.oracle}
          </a>{" "}
          (Outlayer TEE) ·{" "}
          <a href={REPO} target="_blank" rel="noreferrer">
            source and proof table
          </a>{" "}
        </span>
      </pre>
    </>
  );
}
