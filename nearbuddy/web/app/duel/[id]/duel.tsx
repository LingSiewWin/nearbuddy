"use client";
// One duel, btop-style: the two sides and their tier, the oracle prices and the scored outcome, the
// attacks thrown at each side, and the three things a reader can check without trusting this page.
import { use, useEffect, useState } from "react";
import { type CommitConfig, commitCells, proven as hasProof, revealCell } from "../../cells";
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
  near,
  price8,
  row,
  rowx,
  short,
  ts,
  ZERO,
} from "../../tui";

type Agent = {
  owner: string;
  pk: string;
  model_id: string;
  bond: string;
  alpha_bps: number;
  shield: number;
  in_duel: string | null;
  tee: boolean;
};
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
const when = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(0, 19).replace("T", " ");
const proven = (i: Intent | null) => hasProof(i, ZERO);
const pnlc = (n: number) => (n > 0 ? "win" : n < 0 ? "loss" : "tie");

export function DuelRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [r, setR] = useState<Rec | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
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

  const d = r?.duel ?? null;
  const o = d?.outcome ?? null;
  const contract = r?.contract ?? "arena.nearbuddy-solver.testnet";
  const oracle = r?.oracle ?? "price-oracle.testnet";
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const state = !d
    ? null
    : d.resolved
      ? { t: "resolved", c: "tie" }
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
              · {when(d.open_at)} → {ts(d.close_at)} UTC · pool {near(d.pool)} NEAR
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
            {r?.config?.commit_reveal || r?.no_reveal ? (
              <>
                {rowx("reveal", [
                  "A ",
                  revealCell(r.no_reveal?.[0], !!d.last_intent_a, d.resolved),
                  "   B ",
                  revealCell(r.no_reveal?.[1], !!d.last_intent_b, d.resolved),
                ])}
                {"\n"}
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
          `ENCLAVE-VERIFIED = intents signed inside a NEAR AI TEE · size = % of bond risked · proof = sha256 of the model call${r?.config?.commit_reveal ? " · no-reveal slashed = committed a hidden call, never revealed it" : ""}`,
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
            : [{ t: "pending oracle callback", c: "dim" }],
        )}
        {"\n"}
        {rowx(
          "close",
          o
            ? [
                `${price8(o.close_price)} USD`,
                { t: `   fetched by the oracle at resolve, after ${d ? ts(d.close_at) : "-"}`, c: "dim" },
              ]
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
            : [...meter([], 0), { t: "  scored at resolve: side × size × price move", c: "dim" }],
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
            : [{ t: "undecided", c: "dim" }],
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
              : [{ t: "none", c: "dim" }]
            : [{ t: "-", c: "dim" }],
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
        {d?.resolved
          ? rowx("attacks", [
              `${o?.injections ?? 0} during the duel`,
              { t: "   payloads leave contract storage at resolve; only the count survives", c: "dim" },
            ])
          : injections.length
            ? injections.map((j, k) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: on-chain order, append-only
                <span key={k}>
                  {rowx(k ? "" : "attacks", [
                    j.kind.padEnd(14),
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
            : rowx("attacks", [{ t: "none yet", c: "dim" }])}
        {d?.resolved || !injections.length ? "\n" : ""}
        {legend(
          "attack = anyone pays a deposit to send one prompt to one side mid-duel · sha256 = hash of that prompt",
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
        {bottom()}
      </pre>
    </>
  );
}
