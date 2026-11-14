// The ticker and the two leaderboards. A rank is never shown without its game count and its error: rows within error
// of their group's first row share its rank, and a row with too few games is listed unranked.
import type { LiveArenaBody, Match } from "../../api/arena-live";
import type { Row } from "../../lib/standings";

const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
/** `+4.0 ±4.2 bps`, or the mean alone with the reason no error is shown. */
const score = (r: Row) => (r.se === null ? `${signed(r.mean)} bps` : `${signed(r.mean)} ±${r.se.toFixed(1)} bps`);
const ranked = (rows: Row[]) => rows.filter((r) => !r.thin);

const resultOf = (m: Match) => (m.winner === "Tie" ? "tie" : m.winner === "A" ? m.a.model : m.b.model);

export function Ticker({ arena }: { arena: LiveArenaBody }) {
  const rows = ranked(arena.models);
  const parts = [
    rows.length
      ? `MODELS  ${rows.map((r) => `${r.group} ${r.label} ${score(r)} (${r.n})`).join("  ·  ")}`
      : "MODELS  no model has enough games to rank yet",
    arena.last ? `last #${arena.last.id} ${resultOf(arena.last)}` : "",
    arena.live ? `live #${arena.live.id} ${arena.live.a.model} vs ${arena.live.b.model}` : "",
  ].filter(Boolean);
  return (
    <div id="ticker" className="panel ticker" role="marquee" aria-label="LiveArenaBody ticker">
      <span className="run">{parts.join("   ·   ")}</span>
    </div>
  );
}

function Board({
  id,
  title,
  rows,
  empty,
  href,
}: {
  id: string;
  title: string;
  rows: Row[];
  /** What the board says with no row. */
  empty: string;
  href?: (r: Row) => string;
}) {
  const top = rows.filter((r) => r.group === 1).length;
  return (
    <div id={id}>
      <table>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">{title}</th>
            <th scope="col">per match</th>
            <th scope="col">games</th>
            <th scope="col">W-T-L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.thin ? "thin" : undefined}>
              <td className="num">{r.thin ? "-" : r.group}</td>
              <td className={r.thin ? "who" : "who hi"} title={r.label}>
                {href ? <a href={href(r)}>{r.label}</a> : r.label}
              </td>
              <td>{score(r)}</td>
              <td>{`${r.n} games`}</td>
              <td>{r.thin ? "not enough games" : `${r.w}-${r.t}-${r.l}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <p className="dim">{empty}</p> : null}
      {top > 1 ? <p className="dim">{`the first ${top} rows are within error of the leader`}</p> : null}
    </div>
  );
}

export function Boards({ arena }: { arena: LiveArenaBody }) {
  return (
    <section id="boards" className="panel boards" aria-labelledby="boards-h">
      <h2 id="boards-h">
        LEADERBOARDS <span>mean profit per match ± standard error</span>
      </h2>
      <div className="cols">
        <Board id="board-models" title="MODELS" rows={arena.models} empty="no match between two different models yet" />
        <Board
          id="board-coaches"
          title="COACHES"
          rows={arena.coaches}
          empty="no finished match yet"
          href={(r) => `/agent/${encodeURIComponent(r.key)}`}
        />
      </div>
    </section>
  );
}
