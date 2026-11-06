"use client";
// The race card for one duel: the reference price over the duel window between the oracle's open and close
// lines, each model's calls as a lane (filled = Long, outlined = Short) and attacks as hatched flags. Same
// classes as the arena's race card; this one also draws the close and says how each side finished.
import { duelEvents, markPct, openOf, sealedIn } from "../../arena/model";
import type { Tick } from "../../lib/live";
import { agentHref, pct, stake, tone, usd, who } from "../../ui/format";
import type { DuelData, DuelSide } from "./data";

const moved = (m: number) =>
  Math.abs(m) < 0.005 ? "unchanged" : `${m > 0 ? "up" : "down"} ${Math.abs(m).toFixed(2)}%`;

/** Identity colour per side; two of the same family get ink for the second. */
export const tones = (d: DuelData) => {
  const a = tone(d.a.model);
  const b = tone(d.b.model);
  return { a, b: b === a ? "k-alt" : b };
};

export function Race({ d, ticks, now, src }: { d: DuelData; ticks: Tick[]; now: number; src: "trades" | "minutes" }) {
  const t0 = d.opened;
  const t1 = d.closes;
  const end = d.live ? Math.min(now || t0, t1) : t1;
  const x = (t: number) => Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) * 100;
  const win = ticks.filter((k) => k.t >= t0 - 2_000 && k.t <= end + 2_000);
  const open = openOf(d, ticks); // live: Coinbase at the open, to compare like with like
  const oracleOpen = d.open ?? open; // the dashed line and its label are the oracle's own open
  const close = d.live ? null : d.close;
  const vals = win.map((k) => k.p).concat(oracleOpen ? [oracleOpen] : [], close ? [close] : []);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.15, (open ?? 1) * 0.0004);
  const y = (p: number) => (1 - (p - (lo - pad)) / (hi - lo + 2 * pad)) * 100;
  const path = win.map((k, i) => `${i ? "L" : "M"}${(x(k.t) * 10).toFixed(1)},${y(k.p).toFixed(2)}`).join("");
  const last = win.at(-1);
  const price = d.live ? (last?.p ?? null) : d.close;
  const move = open && price ? ((price - open) / open) * 100 : null;
  const { intents, attacks } = duelEvents(d.events, d.duel);
  const label = `NEAR price over duel ${d.duel}${open ? `, open ${usd(open)}` : ""}${
    price != null && move != null ? `, ${d.live ? "now" : "oracle close"} ${usd(price)}, ${moved(move)}` : ""
  }${attacks.length ? `, ${attacks.length} paid attack${attacks.length > 1 ? "s" : ""}` : ""}`;
  const t = tones(d);
  const lane = (s: DuelSide, k: string) => {
    const mine = intents.filter((i) => i.agent === s.agent);
    const other = s === d.a ? d.b : d.a;
    const mark = d.live ? markPct(s, open, price) : (s.score ?? 0);
    const vs = d.live ? markPct(other, open, price) : (other.score ?? 0);
    const sealed = d.live && sealedIn(d.events, d.duel, s.agent);
    const state = d.live
      ? !s.side && !other.side
        ? sealed
          ? "hidden until revealed"
          : "no call yet"
        : Math.abs(mark - vs) < 0.005
          ? "tied"
          : mark > vs
            ? "ahead"
            : "behind"
      : d.winner == null
        ? `tied, ${pct(mark)}`
        : d.winner === s.agent
          ? `won, ${pct(mark)}`
          : `lost, ${pct(mark)}`;
    return (
      <>
        <div className={`lab llab ${k}`}>
          <a className="n who" href={agentHref(s.agent)}>
            {who(s.model)}
          </a>
          <span className="s">
            {s.side ? `${s.side}, ${stake(s.size_pct)}` : sealed ? "Sealed call" : d.live ? "No call yet" : "No call"}
          </span>
          <span className="st">{state}</span>
        </div>
        <div className={`trk lane ${k}`}>
          <div className="rail">
            {mine.map((i, n) => {
              const from = x(i.at);
              const to = x(mine[n + 1]?.at ?? end);
              const w = Math.max(0.6, to - from); // a label needs about 11% of a phone-width lane
              return (
                <div
                  key={i.tx}
                  className={`seg ${i.side === "Long" ? "long" : "short"}`}
                  style={{ left: `${from}%`, width: `${w}%` }}
                  title={`${i.side}, ${stake(i.size / 100)}`}
                >
                  {w > 11 ? <span>{i.side}</span> : null}
                </div>
              );
            })}
            {attacks
              .filter((a) => a.target === s.agent)
              .map((a) => (
                <i key={a.tx} className="hit" style={{ left: `${x(a.at)}%` }} title="paid attack" />
              ))}
            {!mine.length ? (
              <span className="empty">{d.live ? "calls appear here as they land" : "no call in this duel"}</span>
            ) : null}
          </div>
        </div>
      </>
    );
  };
  return (
    <div className="race">
      <div className="lab plab">
        <div className="p">{usd(price)}</div>
        <div className="d">
          {move == null
            ? d.live
              ? "waiting for trades"
              : "price history not available"
            : d.live
              ? `${moved(move)} since the duel opened`
              : `${moved(move)} at the oracle's close`}
        </div>
      </div>
      <div className="trk chart">
        {d.live && now < t1 ? <div className="future" style={{ left: `${x(end)}%` }} /> : null}
        {d.live && d.lockS ? (
          <div className="locked" style={{ left: `${x(t1 - d.lockS * 1000)}%` }}>
            <span>calls locked</span>
          </div>
        ) : null}
        <div className="plot">
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={label}>
            {oracleOpen && close ? (
              <rect
                x="0"
                width="1000"
                y={Math.min(y(oracleOpen), y(close))}
                height={Math.abs(y(oracleOpen) - y(close))}
                className="band"
              />
            ) : null}
            {[oracleOpen, close].map((p, i) =>
              p ? (
                <line
                  // biome-ignore lint/suspicious/noArrayIndexKey: two fixed rules, open then close
                  key={i}
                  x1="0"
                  x2="1000"
                  y1={y(p)}
                  y2={y(p)}
                  stroke={i ? "var(--dim)" : "var(--faint)"}
                  strokeDasharray="4 5"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null,
            )}
            <path
              d={path}
              fill="none"
              stroke="var(--ink)"
              strokeWidth="1.6"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </svg>
          {oracleOpen ? (
            <span className={`openlab${y(oracleOpen) < 25 ? " below" : ""}`} style={{ top: `${y(oracleOpen)}%` }}>
              {d.open ? "oracle open" : "open"} {usd(oracleOpen)}
            </span>
          ) : null}
          {close ? (
            <span className={`closelab${y(close) < 25 ? " below" : ""}`} style={{ top: `${y(close)}%` }}>
              oracle close {usd(close)}
            </span>
          ) : null}
          {d.live && last ? <i className="dot" style={{ left: `${x(last.t)}%`, top: `${y(last.p)}%` }} /> : null}
        </div>
        {attacks.map((a) => {
          const k = a.target === d.a.agent ? t.a : t.b;
          return (
            <div key={a.tx} className={`flag ${x(a.at) > 70 ? "right" : ""} ${k}`} style={{ left: `${x(a.at)}%` }}>
              <span>Attack on {who(a.target === d.a.agent ? d.a.model : d.b.model)}</span>
            </div>
          );
        })}
        <div className="axis">
          <span>open</span>
          <span>{src === "minutes" ? "line: Coinbase, one point per minute" : "line: Coinbase trades"}</span>
          <span>close</span>
        </div>
      </div>
      {lane(d.a, t.a)}
      {lane(d.b, t.b)}
    </div>
  );
}
