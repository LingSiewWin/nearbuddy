// The stage: one match's price line against its open price, each side's call and profit at the shown price, and a
// rope whose marker leans to the side ahead. Live, the price is the exchange's last trade; in a replay, the finished
// match's candles played back. Display only either way: a match settles on the oracle's prices.
import type { Match, Side } from "../api/league";
import { points, rope, type Sample } from "../lib/stage";

const VW = 560;
const VH = 170;

/** A call's profit at price `now`, in bps, by the contract's rule (arena/src/duels.rs pnl_bps). */
const pnlAt = (s: Side, open: number | null, now: number | null): number | null =>
  s.side && s.size_bps && open && now ? ((s.side === "Long" ? 1 : -1) * (now - open) * s.size_bps) / open : null;

/** The value as it prints, to one decimal, so a rounding -0.0 is neither negative nor red. */
const shown = (x: number) => Math.round(x * 10) / 10 || 0;
const bps = (x: number) => `${shown(x) > 0 ? "+" : ""}${shown(x).toFixed(1)} bps`;

const HEAD = { live: "LIVE", closing: "CLOSED", replay: "REPLAY" } as const;

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function SideLine({ s, pnl, right }: { s: Side; pnl: number | null; right?: boolean }) {
  const call = s.side ? (
    <span className={s.side === "Long" ? "win" : "loss"}>{s.side.toUpperCase()}</span>
  ) : (
    <span className="dim">waiting for call</span>
  );
  return (
    <div style={right ? { textAlign: "right" } : undefined}>
      <div>
        <span className="hi">{s.model}</span> · {call}
      </div>
      {pnl === null ? null : <b className={shown(pnl) > 0 ? "win" : shown(pnl) < 0 ? "loss" : "tie"}>{bps(pnl)}</b>}
    </div>
  );
}

export function Stage({
  match,
  mode,
  samples,
  t0,
  t1,
  nowMs,
  priced,
  shouts,
}: {
  match: Match;
  /** live: open, priced by the exchange. closing: past its close, waiting for the oracle. replay: a finished match
   *  played back. */
  mode: "live" | "closing" | "replay";
  samples: Sample[];
  /** The time axis, in ms. */
  t0: number;
  t1: number;
  nowMs: number;
  /** False when there is no usable price: live with a stale spot, or a replay with no candles. */
  priced: boolean;
  /** When each shout landed, in ms. */
  shouts: number[];
}) {
  const open = match.open_price ? Number(match.open_price) / 1e8 : null;
  const last = samples[samples.length - 1]?.p ?? null;
  const now = priced ? last : null;
  const a = pnlAt(match.a, open, now);
  const b = pnlAt(match.b, open, now);
  const at = rope(a, b);
  const same = !!match.a.side && match.a.side === match.b.side && match.a.size_bps === match.b.size_bps;
  const { pts, baseline } = open ? points(samples, open, t0, t1, VW, VH) : { pts: [], baseline: VH / 2 };
  const tip = pts[pts.length - 1];
  const x = (ms: number) => ((ms - t0) / (t1 - t0 || 1)) * VW;
  return (
    <section id="stage" className="panel stage" aria-labelledby="stage-h">
      <h2 id="stage-h">
        {`${HEAD[mode]} #${match.id} · NEAR/USD`}
        <span>
          {mode === "replay"
            ? "finished match, played back fast"
            : mode === "closing"
              ? "closed"
              : `closes in ${clock(t1 - nowMs)}`}
        </span>
      </h2>
      <svg id="stage-line" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label="Price since the open">
        <line x1="0" y1={baseline} x2={VW} y2={baseline} stroke="var(--dim)" strokeDasharray="4 4" />
        <text x="2" y={baseline + 14}>
          {open ? `open ${open.toFixed(4)}` : "oracle price pending"}
        </text>
        {shouts
          .filter((ms) => ms >= t0 && ms <= t1)
          .map((ms) => (
            <line key={ms} x1={x(ms)} y1="6" x2={x(ms)} y2={VH - 6} stroke="var(--warn)" opacity="0.6" />
          ))}
        <polyline
          points={pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ")}
          fill="none"
          stroke="var(--fg)"
          strokeWidth="2"
        />
        {priced && tip ? <circle cx={tip[0]} cy={tip[1]} r="4" fill="var(--hi)" /> : null}
        {tip && now ? (
          <text x={Math.min(tip[0] + 8, VW - 48)} y={Math.max(12, tip[1] - 6)}>
            {now.toFixed(4)}
          </text>
        ) : null}
      </svg>
      {mode === "closing" ? (
        <p className="warn">waiting for the oracle's closing price: the result follows, usually within a few minutes</p>
      ) : priced ? null : (
        <p className="warn">{mode === "replay" ? "replay unavailable" : "price unavailable"}</p>
      )}
      <div className="sides">
        <SideLine s={match.a} pnl={a} />
        <SideLine s={match.b} pnl={b} right />
      </div>
      {at === null ? null : (
        <>
          <div id="rope" className="rope" role="img" aria-label="Which side is ahead">
            <i style={{ left: `${((1 - at) * 100).toFixed(1)}%` }} />
          </div>
          {same ? <p className="dim">same side: nothing between them</p> : null}
        </>
      )}
      {match.resolved ? (
        <p>
          {"result: "}
          <span className="hi">
            {match.winner === "Tie" ? "tie" : `${match.winner === "A" ? match.a.model : match.b.model} won`}
          </span>
          <span className="dim">{` · scored ${match.a.pnl ?? 0} and ${match.b.pnl ?? 0} bps on the oracle`}</span>
        </p>
      ) : null}
      <p className="dim">
        {mode === "replay"
          ? "exchange candles, display only; the match settled on the oracle"
          : "live price, display only; the match settles on the oracle"}
      </p>
    </section>
  );
}
