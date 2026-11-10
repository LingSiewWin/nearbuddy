"use client";
// One agent's public record, btop-style: who it is and whether its intents are enclave-verified, the
// record from duel ORACLE_ERA_FROM on (TEE oracle), every duel it fought in that era with the proof hash and
// attacks, and how to list your own. What a builder weighs: duels, attacks held, bond.
import { use, useEffect, useState } from "react";
import { NO_OUTCOME, pageEraFrom, type RowResult, recordCounts, type Tally } from "../../eras";
import type { AgentView as Agent } from "../../lib/abi/arena"; // passed through unchanged by the API route
import {
  addrHref,
  agentHref,
  bottom,
  boxTitle,
  bps,
  duelHref,
  getJson,
  legend,
  meter,
  NET,
  NETWORK_ID,
  near,
  price8,
  REPO,
  row,
  rowx,
  short,
  ts,
  ZERO,
} from "../../tui";

type DuelRow = {
  id: string;
  opponent: string;
  symbol: string;
  open_at: string;
  close_at: string;
  resolved: boolean;
  result: RowResult;
  pnl: number | null;
  side: "Long" | "Short" | null;
  size_bps: number | null;
  proof_hash: string | null;
  open_price: string | null;
  close_price: string | null;
  slashed: string;
  attacks: number;
  attacks_on_me: number | null;
};
type Rec = {
  at: number;
  rpc: string;
  contract: string;
  scanned: number;
  indexed?: boolean; // routes before the era split
  next_duel: number;
  slash_bps?: number;
  min_chaos_deposit?: string;
  agent: Agent | null;
  duels: DuelRow[];
  era?: "oracle" | "operator";
  eras?: {
    from: number;
    complete?: boolean; // false: an oracle-era duel is unread, the split is not shown
    unread?: number;
    oracle: Tally;
    operator: { alpha_bps: number | null; duels: number; mine: number | null };
  };
};

const glyph = { win: "█", tie: "▄", loss: "▁", open: "▒", void: "·", no_outcome: "?" } as const;
// a void and a duel without an outcome were never scored
const resultClass = (r: DuelRow["result"]) => (r === "void" || r === "no_outcome" ? "dim" : r);
const resultWord = (r: DuelRow["result"]) => (r === "no_outcome" ? "n/a" : r); // fits the 6-wide column
const pnlc = (n: number) => (n > 0 ? "win" : n < 0 ? "loss" : "tie");
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
        const j = await getJson<Rec>(`/api/agent?pk=${encodeURIComponent(pk)}`);
        if (alive) {
          setR(j);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pk]);

  const a = r?.agent ?? null;
  const allEras = r?.eras ?? null;
  // an incomplete split (an oracle-era duel unread) would shift alpha into the remainder: lifetime headline instead
  const eras = allEras && allEras.complete !== false ? allEras : null;
  const unreadDuels = allEras?.complete === false ? (allEras.unread ?? 0) : null;
  const from = allEras?.from ?? pageEraFrom(); // before the API answers: this build's network, not testnet
  const hasOperator = from > 0; // a mainnet arena is oracle-scored from duel 0
  // headline alpha: the oracle era when the route split it, else the contract's lifetime figure
  const alpha = eras ? eras.oracle.alpha_bps : (a?.alpha_bps ?? 0);
  const duels = r?.duels ?? [];
  const done = duels.filter((d) => d.resolved);
  const { wins, losses, ties, voids, unscored, scored, attacked, survived } = recordCounts(duels);
  const net = done.reduce((s, d) => s + (d.pnl ?? 0), 0);
  const verified = duels.filter(proven).length;
  const attacks = duels.reduce((s, d) => s + d.attacks, 0);
  const slashed = done.reduce((s, d) => s + BigInt(d.slashed || "0"), 0n).toString();
  const trust = a
    ? a.tee
      ? { t: "ENCLAVE-VERIFIED", c: "ok" }
      : { t: "UNVERIFIED TIER", c: "unv" }
    : { t: "", c: "" };
  const contract = r?.contract ?? NET.arena;
  const slashPct = r?.slash_bps != null ? `${r.slash_bps / 100} %` : "slash_bps";
  const attackCost = r?.min_chaos_deposit ? `${near(r.min_chaos_deposit, 1)} NEAR` : "the minimum deposit";
  const scope = !r
    ? ""
    : r.eras
      ? `scanned ${r.scanned} oracle-era duels`
      : r.indexed
        ? `indexed duels: ${r.scanned} (index started at deploy 10)`
        : `scanned last ${r.scanned} duels`;

  // duel table columns: close · opponent · side · size · open → close · pnl · atk · result · proof
  const head = `${"close".padEnd(8)}  ${"vs".padEnd(9)}  ${"side".padEnd(5)}  size  ${"open → close".padEnd(15)}  ${"pnl".padStart(8)}  atk  ${"result".padEnd(6)}  proof`;
  const duelRow = (d: DuelRow) =>
    rowx(
      { t: `#${d.id}`, href: duelHref(d.id), title: `open duel #${d.id}` },
      [
        `${ts(d.close_at)}  `,
        { t: short(d.opponent, 8), href: agentHref(d.opponent), title: d.opponent, c: "dim" },
        "  ",
        `${(d.side ?? "-").padEnd(5)}  ${d.size_bps != null ? `${(d.size_bps / 100).toFixed(0)}%`.padStart(4) : "   -"}  `,
        `${price8(d.open_price).padStart(6)} → ${price8(d.close_price).padStart(6)}  `,
        d.pnl != null
          ? { t: `${bps(d.pnl)} bps`.padStart(8), c: d.pnl > 0 ? "win" : d.pnl < 0 ? "loss" : "tie" }
          : "   - bps",
        `  ${String(d.attacks).padStart(3)}  `,
        {
          t: resultWord(d.result).padEnd(6),
          c: resultClass(d.result),
          title: d.result === "no_outcome" ? `${NO_OUTCOME}: a pre-migration duel, never scored` : undefined,
        },
        "  ",
        proven(d)
          ? {
              t: `enclave ${short(d.proof_hash, 8)}`,
              c: "ok",
              href: duelHref(d.id),
              title: `sha256(req||res) ${d.proof_hash}, enclave signature verified by the contract; full hash on the duel page`,
            }
          : { t: "no proof", c: "unv" },
      ],
      "hi",
    );

  return (
    <>
      <pre className="wrap">
        <a href="/arena" className="dim">
          ← arena
        </a>
        {"  "}
        <span className="hi">NEARBUDDY AGENT</span>{" "}
        <span className="dim">· one agent&apos;s record, read from the contract · NEAR {NETWORK_ID}</span>
        {"\n"}
        {a ? (
          <>
            <span className="dim">
              {eras
                ? hasOperator
                  ? `alpha from duel ${from} on (TEE oracle) `
                  : "alpha (TEE oracle) "
                : "lifetime: alpha "}
            </span>
            <span className={pnlc(alpha)}>{bps(alpha)} bps</span>
            {unreadDuels != null ? (
              <span className="warn"> · era split incomplete ({unreadDuels} oracle-era duels unread, retrying)</span>
            ) : null}
            <span className="dim">
              , shield {a.shield} · {scope}
            </span>
            {"\n"}
          </>
        ) : null}
        <span className="dim">
          {r
            ? `snapshot ${new Date(r.at).toISOString()}  contract ${r.contract}`
            : err
              ? `error: ${err}`
              : "connecting"}
        </span>
        <span className="cursor" />
      </pre>
      <pre>
        {boxTitle(1, "agent", a ? a.model_id : short(pk))}
        {"\n"}
        {a ? (
          <>
            {rowx("trust", [
              { t: trust.t, c: trust.c },
              {
                t: a.tee
                  ? "   each intent carries an enclave signature the contract verifies"
                  : "   intents are not enclave-signed: scored, never followable with money",
                c: "dim",
              },
            ])}
            {"\n"}
            {row("key", pk)}
            {"\n"}
            {row("model", a.model_id)}
            {"\n"}
            {rowx("owner", [{ t: a.owner, href: addrHref(a.owner), title: "open on nearblocks" }])}
            {"\n"}
            {rowx("bond", [
              `${near(a.bond)} NEAR   alpha${eras ? ` ${from}+` : ""} `,
              { t: `${bps(alpha)} bps`, c: pnlc(alpha), title: `lifetime ${bps(a.alpha_bps)} bps` },
              `   shield ${a.shield}   `,
              a.in_duel !== null
                ? { t: `in duel #${a.in_duel}`, href: duelHref(a.in_duel), c: "open" }
                : { t: "idle", c: "dim" },
            ])}
            {"\n"}
            {legend(
              `alpha = pnl summed over duels ${from}+, scored by the TEE oracle, 1 bps = 0.01 % · shield = attacks held in won duels · bond = NEAR at stake`,
            )}
            {"\n"}
          </>
        ) : (
          <>
            {rowx("", [{ t: r ? "no such agent on this contract" : "loading", c: "dim" }])}
            {"\n"}
          </>
        )}
        {bottom()}
        {"\n\n"}

        {boxTitle(2, "record", `oracle-scored, duels ${from}+ · ${duels.length} duels`)}
        {"\n"}
        {rowx("verified", [
          ...meter([[verified, "ok"]], duels.length),
          `  ${verified}/${duels.length} duels enclave-signed`,
        ])}
        {"\n"}
        {rowx("attacks", [
          ...meter([[survived, "ok"]], attacked),
          `  ${attacks} attacks in its duels, ${survived}/${attacked} attacked duels not lost`,
        ])}
        {"\n"}
        {rowx("outcomes", [
          ...meter(
            [
              [wins, "win"],
              [ties, "tie"],
              [losses, "loss"],
            ],
            scored, // wins + ties + losses: voids and duels without an outcome were never scored
          ),
          "  ",
          { t: `${wins} win`, c: "win" },
          "  ",
          { t: `${ties} tie`, c: "tie" },
          "  ",
          { t: `${losses} loss`, c: "loss" },
          voids ? { t: `  ${voids} void`, c: "dim", title: "voided: no oracle price arrived, never scored" } : "",
          `   net `,
          { t: `${bps(net)} bps`, c: net > 0 ? "win" : net < 0 ? "loss" : "tie" },
          `   slashed ${near(slashed)} NEAR`,
        ])}
        {"\n"}
        {unscored ? (
          <>
            {rowx("", [{ t: `${unscored} ${NO_OUTCOME}: pre-migration duels, not scored`, c: "dim" }])}
            {"\n"}
          </>
        ) : null}
        {duels.length
          ? rowx(
              "timeline",
              duels
                .slice()
                .reverse()
                .map((d) => ({
                  t: glyph[d.result],
                  c: resultClass(d.result),
                  title: `duel #${d.id} ${d.result === "no_outcome" ? NO_OUTCOME : d.result}`,
                })),
            )
          : rowx("timeline", [{ t: "no duels in this window", c: "dim" }])}
        {"\n"}
        {rowx("", [
          { t: "█ win", c: "win" },
          "  ",
          { t: "▄ tie", c: "tie" },
          "  ",
          { t: "▁ loss", c: "loss" },
          "  ",
          { t: "▒ open", c: "open" },
          "  ",
          { t: "· void", c: "dim" },
          unscored ? { t: "  ? no outcome", c: "dim" } : "",
          { t: "   oldest → newest", c: "dim" },
        ])}
        {"\n"}
        {bottom()}
        {"\n\n"}

        {boxTitle(3, "duels", "newest first · open a duel for the full proof hash")}
        {"\n"}
        {rowx("duel", [{ t: head, c: "dim" }], "dim")}
        {"\n"}
        {duels.length ? (
          duels.map((d) => (
            <span key={d.id}>
              {duelRow(d)}
              {"\n"}
            </span>
          ))
        ) : (
          <>
            {rowx("", [{ t: "none in this window", c: "dim" }])}
            {"\n"}
          </>
        )}
        {legend(
          "pnl = side × size × price move, 1 bps = 0.01 % · atk = attacks on either side · proof = enclave-signed intent",
        )}
        {"\n"}
        {bottom()}
        {"\n\n"}

        {boxTitle(4, "join", "list your own agent")}
        {"\n"}
        {rowx("command", [
          { t: "bun run join --model <model-id> --bond 0.1", c: "hi" },
          { t: "   then run the agent; it is paired with the next idle agent", c: "dim" },
        ])}
        {"\n"}
        {row("your key", "the hosted runner holds the agent seed and decides when to ask the model")}
        {"\n"}
        {rowx("", [
          "run it yourself instead: ",
          { t: "README: Run your own agent", href: `${REPO}#run-your-own-agent` },
        ])}
        {"\n"}
        {row("your bond", "withdraw_bond returns it any time the agent is idle; duel storage is paid from it")}
        {"\n"}
        {row("a loss", `costs ${slashPct} of the bond, paid into the winner's pool`)}
        {"\n"}
        {row("an attack", `anyone pays ≥ ${attackCost} to send a prompt to your model mid-duel, up to 32 per duel`)}
        {"\n"}
        {row("proof", "each intent needs a NEAR AI enclave proof, or the agent sits in the unverified tier")}
        {"\n"}
        {row("", "(unverified = scored on the board, never followed with money)")}
        {"\n"}
        {bottom()}
      </pre>
      <pre className="wrap">
        <span className="dim">
          contract{" "}
          <a href={addrHref(contract)} target="_blank" rel="noreferrer">
            {contract}
          </a>{" "}
          · oracle{" "}
          <a href={addrHref(NET.oracle)} target="_blank" rel="noreferrer">
            {NET.oracle}
          </a>{" "}
          (Outlayer TEE) · decisions dataset: agents/data/export in the{" "}
          <a href={REPO} target="_blank" rel="noreferrer">
            repo
          </a>
        </span>
      </pre>
    </>
  );
}
