"use client";
// One duel, btop-style: the two sides and their tier, the oracle prices and the scored outcome, the
// attacks thrown at each side, and the three things a reader can check without trusting this page.
import { use, useEffect, useState } from "react";
import {
  type ChainEvent,
  type CommitConfig,
  commitCells,
  proven as hasProof,
  kindCell,
  type Opened,
  pairingCells,
  revealCell,
  timelineCells,
  type Verify,
  verifyLineCells,
  verifySummary,
} from "../../cells";
import { NO_OUTCOME, noOutcome } from "../../eras";
import type { AgentView as Agent, Chaos } from "../../lib/abi/arena"; // passed through unchanged by the API route
import { attacksOf } from "../../term/model";
import {
  addrHref,
  agentHref,
  blockHref,
  bottom,
  boxTitle,
  bps,
  getJson,
  legend,
  meter,
  NET,
  near,
  price8,
  row,
  rowx,
  short,
  ts,
  ZERO,
} from "../../tui";

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
  open_at?: string | null; // absent in some older record shapes
  close_at: string;
  pool: string;
  injections: Injection[];
  resolved: boolean;
  last_intent_a: Intent | null;
  last_intent_b: Intent | null;
  outcome?: Outcome | null;
  open_price?: string | null;
  /** Deploy 17: every planted headline with its arm, outcome and payout (get_chaos). */
  chaos?: Chaos[] | null;
};
/** GET /api/events: the duel's open tx and commit/intent events from FastNEAR's window of the newest arena txs. */
type Events = {
  at: number;
  window: number;
  oldest_ms: number | null;
  opened: Opened | null;
  events?: ChainEvent[];
};
type Rec = {
  at: number;
  rpc: string;
  contract: string;
  oracle: string;
  config?: CommitConfig | null;
  no_reveal?: [boolean, boolean] | null;
  duel: Duel | null;
  a: Agent | null;
  b: Agent | null;
};

const symbol = (s: string) => (s === "wrap.near" ? "NEAR/USD" : s);
/** open_at in ms, or null when the record lacks it or holds no ns integer (BigInt would throw). */
const openMs = (d: { open_at?: string | null }) =>
  d.open_at && /^\d+$/.test(d.open_at) ? Number(BigInt(d.open_at) / 1_000_000n) : null;
const when = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(0, 19).replace("T", " ");
const proven = (i: Intent | null) => hasProof(i, ZERO);
const pnlc = (n: number) => (n > 0 ? "win" : n < 0 ? "loss" : "tie");
const OUTCOME: Record<Chaos["outcome"], [string, string]> = {
  Pending: ["pending", "open"],
  Flipped: ["FLIPPED", "loss"],
  Held: ["HELD", "win"],
  NoTrial: ["not counted", "dim"],
  Expired: ["expired", "dim"],
};

export function DuelRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [r, setR] = useState<Rec | null>(null);
  const [ev, setEv] = useState<Events | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      // the tx index is optional enrichment: a FastNEAR outage leaves the contract view intact
      getJson<Events>(`/api/events?duel=${encodeURIComponent(id)}`)
        .then((j) => alive && setEv(j))
        .catch(() => {});
      try {
        const j = await getJson<Rec>(`/api/duel?id=${encodeURIComponent(id)}`);
        if (alive) {
          setR(j);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const t = setInterval(tick, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  // the verifier runs once the duel is resolved, never on an open one; a failed or degraded check retries a few times
  const [vf, setVf] = useState<Verify | null>(null);
  const [vErr, setVErr] = useState<string | null>(null);
  const [showLines, setShowLines] = useState(false);
  const resolved = !!r?.duel?.resolved;
  useEffect(() => {
    if (!resolved) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = async (left: number) => {
      try {
        const j = await getJson<Verify>(`/api/verify?duel=${encodeURIComponent(id)}`);
        if (!alive) return;
        setVf(j);
        setVErr(null);
        if (j.degraded && left) timer = setTimeout(() => go(left - 1), 65_000); // the route keeps it 60 s
      } catch (e) {
        if (!alive) return;
        setVErr(e instanceof Error ? e.message : String(e));
        if (left) timer = setTimeout(() => go(left - 1), 20_000);
      }
    };
    go(3);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, resolved]);

  const d = r?.duel ?? null;
  const o = d?.outcome ?? null;
  const contract = r?.contract ?? NET.arena;
  const oracle = r?.oracle ?? NET.oracle;
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const unscored = !!d && noOutcome(d); // a pre-migration duel closed without an outcome
  const state = !d
    ? null
    : d.resolved
      ? unscored
        ? { t: NO_OUTCOME, c: "dim" }
        : { t: "resolved", c: "tie" }
      : BigInt(d.close_at) < nowNs
        ? { t: "CLOSED, awaiting oracle", c: "open" }
        : { t: "LIVE", c: "open" };
  const name = (pk: string) => (pk === d?.a ? r?.a : pk === d?.b ? r?.b : null)?.model_id ?? short(pk, 8);
  const tag = (pk: string) => (pk === d?.a ? "A" : pk === d?.b ? "B" : "?");

  const sideRow = (t: "A" | "B", pk: string, ag: Agent | null, it: Intent | null) =>
    rowx(
      t,
      [
        { t: (ag?.model_id ?? short(pk, 12)).slice(0, 30).padEnd(30), href: agentHref(pk), title: pk },
        "  ",
        ag
          ? ag.tee
            ? { t: "ENCLAVE-VERIFIED", c: "ok" }
            : { t: "UNVERIFIED TIER ", c: "unv" }
          : { t: "not registered  ", c: "dim" },
        "  ",
        it
          ? {
              t: `${it.side.padEnd(5)} ${(it.size_bps / 100).toFixed(0).padStart(3)}%  ${proven(it) ? `proof ${short(it.proof_hash, 10)}` : "no proof"}`,
              c: proven(it) ? "ok" : "unv",
              title: proven(it)
                ? `sha256(request_hash||response_hash) ${it.proof_hash}  nonce ${it.nonce}; full hash in box 4`
                : "proof_hash is 32 zero bytes: the intent carries no enclave signature",
            }
          : { t: "no intent yet", c: "dim" },
      ],
      "hi",
    );
  const proofRow = (t: "A" | "B", it: Intent | null) =>
    rowx(
      `${t} proof`,
      proven(it)
        ? [
            { t: it!.proof_hash, c: "ok" },
            { t: `  nonce ${it!.nonce}`, c: "dim" },
          ]
        : [{ t: it ? "none: 32 zero bytes, unverified tier" : "no intent", c: "dim" }],
    );

  const pa = o?.pnl_a ?? 0;
  const pb = o?.pnl_b ?? 0;
  const injections = d?.injections ?? [];
  const records = d?.chaos ?? [];
  const attacks = d ? attacksOf(d) : 0;

  return (
    <>
      <pre className="wrap">
        <a href="/arena" className="dim">
          ← arena
        </a>
        {"  "}
        <span className="hi">NEARBUDDY DUEL #{id}</span>
        {d ? (
          <>
            {" "}
            <span className="dim">· {symbol(d.symbol)} ·</span> <span className={state!.c}>{state!.t}</span>{" "}
            <span className="dim">
              · {openMs(d) != null ? when(d.open_at!) : "-"} → {ts(d.close_at)} UTC · pool {near(d.pool)} NEAR
            </span>
          </>
        ) : null}
        {"\n"}
        <span className="dim">
          {r
            ? `snapshot ${new Date(r.at).toISOString()}  contract ${r.contract}  rpc ${r.rpc}`
            : err
              ? `error: ${err}`
              : "connecting"}
        </span>
        <span className="cursor" />
      </pre>
      <pre>
        {boxTitle(1, "sides", "who fought, their tier, their last intent")}
        {"\n"}
        {d ? (
          <>
            {sideRow("A", d.a, r?.a ?? null, d.last_intent_a)}
            {"\n"}
            {sideRow("B", d.b, r?.b ?? null, d.last_intent_b)}
            {"\n"}
            {rowx("commit-reveal", commitCells(r?.config))}
            {"\n"}
            {rowx("pairing", pairingCells(ev?.opened, r?.config))}
            {"\n"}
            {r?.config?.commit_reveal || r?.no_reveal ? (
              <>
                {rowx("reveal", [
                  "A ",
                  revealCell(r.no_reveal, 0, !!d.last_intent_a, d.resolved),
                  "   B ",
                  revealCell(r.no_reveal, 1, !!d.last_intent_b, d.resolved),
                ])}
                {"\n"}
                {ev
                  ? (["A", "B"] as const).map((t) => (
                      <span key={t}>
                        {rowx(`${t} commit`, timelineCells(ev.events, t === "A" ? d.a : d.b, d.resolved))}
                        {"\n"}
                      </span>
                    ))
                  : null}
                {ev?.oldest_ms != null && openMs(d) != null && openMs(d)! < ev.oldest_ms ? (
                  <>
                    {rowx("", [
                      {
                        t: `opened before the scanned tx window (from ${new Date(ev.oldest_ms).toISOString().slice(11, 19)} UTC): earlier events not shown`,
                        c: "dim",
                      },
                    ])}
                    {"\n"}
                  </>
                ) : null}
              </>
            ) : null}
          </>
        ) : (
          <>
            {rowx("", [{ t: r ? "no such duel on this contract" : "loading", c: "dim" }])}
            {"\n"}
          </>
        )}
        {legend(
          `ENCLAVE-VERIFIED = intents signed inside a NEAR AI TEE · size = % of bond risked · proof = sha256 of the model call${r?.config?.commit_reveal ? " · no reveal = forfeit + no_reveal_bps of bond to the opponent (both: tie, to the protocol)" : ""}`,
        )}
        {"\n"}
        {bottom()}
        {"\n\n"}

        {boxTitle(2, "prices", `oracle ${oracle}`)}
        {"\n"}
        {rowx(
          "open",
          d?.open_price || o
            ? [
                `${price8(o?.open_price ?? d?.open_price)} USD`,
                { t: "   snapshotted by the Outlayer TEE oracle right after open", c: "dim" },
              ]
            : [{ t: unscored ? "none recorded" : "pending oracle callback", c: "dim" }],
        )}
        {"\n"}
        {rowx(
          "close",
          o
            ? [
                `${price8(o.close_price)} USD`,
                { t: `   fetched by the oracle at resolve, after ${d ? ts(d.close_at) : "-"}`, c: "dim" },
              ]
            : unscored
              ? [{ t: `${NO_OUTCOME}: a pre-migration duel, never scored`, c: "dim" }]
              : [{ t: d ? `pending: anyone can resolve after ${ts(d.close_at)} UTC` : "-", c: "dim" }],
        )}
        {"\n"}
        {rowx(
          "pnl",
          o
            ? [
                ...meter(
                  [
                    [Math.abs(pa), pnlc(pa)],
                    [Math.abs(pb), pnlc(pb)],
                  ],
                  Math.abs(pa) + Math.abs(pb),
                ),
                "  A ",
                { t: `${bps(pa)} bps`, c: pnlc(pa) },
                "   B ",
                { t: `${bps(pb)} bps`, c: pnlc(pb) },
                { t: "   bar: |pnl A| vs |pnl B|", c: "dim" },
              ]
            : [
                ...meter([], 0),
                { t: unscored ? "  not scored" : "  scored at resolve: side × size × price move", c: "dim" },
              ],
        )}
        {"\n"}
        {rowx(
          "winner",
          o
            ? o.winner
              ? [
                  { t: `${tag(o.winner)} ${name(o.winner)}`, href: agentHref(o.winner), c: "win", title: o.winner },
                  { t: "   pool paid to the winner", c: "dim" },
                ]
              : [{ t: "tie, pool split", c: "tie" }]
            : [{ t: unscored ? NO_OUTCOME : "undecided", c: "dim" }],
        )}
        {"\n"}
        {rowx(
          "slashed",
          o
            ? BigInt(o.slashed) > 0n
              ? [
                  { t: `${near(o.slashed)} NEAR`, c: "loss" },
                  { t: "   taken from the loser's bond into the pool", c: "dim" },
                ]
              : [{ t: o.winner ? "0 NEAR" : "0 NEAR   a tie slashes nobody", c: "dim" }]
            : [{ t: unscored ? NO_OUTCOME : "decided at resolve", c: "dim" }],
        )}
        {"\n"}
        {legend(
          "pnl = side × size × price move, 1 bps = 0.01 % · slashed = the loser's share of bond (slash_bps) moved to the pool",
        )}
        {"\n"}
        {bottom()}
        {"\n\n"}

        {boxTitle(3, "attacks", "paid prompt injections at a side, recorded on-chain")}
        {"\n"}
        {records.length
          ? records.map((c, k) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: get_chaos order, append-only
              <span key={k}>
                {rowx(`#${k} ${tag(c.target)}`, [
                  { t: `${(c.kind === "Placebo" ? "placebo" : c.kind.toUpperCase()).padEnd(7)} `, c: "dim" },
                  { t: `${c.arm.toLowerCase().padEnd(6)} `, c: "dim" },
                  { t: OUTCOME[c.outcome][0].padEnd(12), c: OUTCOME[c.outcome][1] },
                  // payouts are set when the duel finishes: before that, "0.000 out" would read as a loss
                  BigInt(c.stake) > 0n
                    ? d?.resolved
                      ? { t: `${near(c.stake)} in → ${near(c.payout)} out  `, c: "ok", title: `paid to ${c.injector}` }
                      : { t: `${near(c.stake)} in, settles at close  `, c: "dim", title: `staked by ${c.injector}` }
                    : "",
                  { t: `"${c.headline}"`, c: "warn", title: `${c.headline} · by ${c.injector}` },
                ])}
                {"\n"}
              </span>
            ))
          : d?.resolved
            ? rowx("attacks", [
                `${attacks} during the duel`,
                {
                  t: attacks ? "   planted before deploy 17: only the count stays on chain" : "",
                  c: "dim",
                },
              ])
            : injections.length
              ? injections.map((j, k) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: on-chain order, append-only
                  <span key={k}>
                    {rowx(k ? "" : "attacks", [
                      kindCell(j.kind),
                      " → ",
                      {
                        t: `${tag(j.target)} ${name(j.target)}`.slice(0, 30),
                        href: agentHref(j.target),
                        title: j.target,
                      },
                      " ".repeat(Math.max(2, 32 - `${tag(j.target)} ${name(j.target)}`.length)),
                      "sha256 ",
                      { t: short(j.payload_hash, 12), title: j.payload_hash },
                      "  block ",
                      { t: j.block, href: blockHref(j.block), c: "dim" },
                    ])}
                    {"\n"}
                  </span>
                ))
              : rowx("attacks", [{ t: d ? "0 so far: the inject pane on / plants one" : "loading", c: "dim" }])}
        {records.length || (!d?.resolved && injections.length) ? "" : "\n"}
        {legend(
          records.length
            ? "attack = anyone pays chaos_fee to plant one headline at one side mid-duel · FLIPPED = the side's next proved call moved to the lie's side · in → out = stake and what claim_chaos pays"
            : "attack = anyone pays a deposit to send one prompt to one side mid-duel · sha256 = hash of that prompt",
        )}
        {"\n"}
        {bottom()}
        {"\n\n"}

        {boxTitle(4, "how to verify", "without trusting this page")}
        {"\n"}
        {row("1 intent", "proof_hash = sha256(request_hash || response_hash) of the NEAR AI Cloud completion;")}
        {"\n"}
        {row("", "the contract checked the enclave's ed25519 signature before storing it:")}
        {"\n"}
        {proofRow("A", d?.last_intent_a ?? null)}
        {"\n"}
        {proofRow("B", d?.last_intent_b ?? null)}
        {"\n"}
        {rowx("2 oracle", [
          "prices come by oracle_on_call from ",
          { t: oracle, href: addrHref(oracle), title: "open on nearblocks" },
          " (Outlayer TEE), not an operator;",
        ])}
        {"\n"}
        {rowx("", [
          "the callback tx is in the contract's transactions on ",
          { t: "nearblocks", href: addrHref(contract) },
        ])}
        {"\n"}
        {rowx("3 contract", [
          { t: contract, href: addrHref(contract), title: "open on nearblocks" },
          `   get_duel {"duel_id":"${id}"} on any RPC returns this record`,
        ])}
        {"\n"}
        {rowx(
          "4 verified",
          !d
            ? [{ t: "-", c: "dim" }]
            : !d.resolved
              ? [
                  { t: "open", c: "open" },
                  { t: "   checked once the duel resolves", c: "dim" },
                ]
              : vf
                ? verifySummary(vf, showLines, () => setShowLines(!showLines))
                : [
                    {
                      t: vErr
                        ? `verifier unavailable: ${vErr}`
                        : "checking: the first look reads the duel's txs, ~20 s",
                      c: "dim",
                    },
                  ],
        )}
        {"\n"}
        {showLines
          ? (vf?.lines ?? []).map((l, k) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the verifier's lines in its own order
              <span key={k}>
                {rowx("", verifyLineCells(l))}
                {"\n"}
              </span>
            ))
          : null}
        {rowx("reproduce", [
          { t: vf?.command ?? `bun run verify-duel ${id}`, c: "hi" },
          { t: "   from nearbuddy/ in a checkout; public sources only, sends nothing", c: "dim" },
        ])}
        {"\n"}
        {bottom()}
      </pre>
    </>
  );
}
