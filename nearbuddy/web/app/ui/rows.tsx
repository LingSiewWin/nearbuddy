"use client";
// Duel rows for the duel list: the whole row is a link, and each row carries a mini Trace of its most telling
// planted headline (drawn from that headline's own record) and a FOOLED / HELD mark, so two duels never look alike.
import { type DuelRow, duelPath } from "./data";
import { clock, nsMs, shortModel } from "./format";
import { Tag } from "./instruments";
import { recordTrace } from "./trace";
import { Trace } from "./trace-view";

/** How a duel stands, in the row's words. */
export function rowState(r: DuelRow, now: number): string {
  if (r.resolved) {
    if (r.cancelled) return "cancelled";
    if (r.winner === "Tie") return "tie";
    return `${shortModel((r.winner === "A" ? r.a : r.b).model)} won`;
  }
  const left = (nsMs(r.close_at) - now) / 1000;
  return now && left <= 0 ? "closed, waiting for the final price" : now ? `ends in ${clock(left)}` : "running";
}

export const isRunning = (r: DuelRow, now: number) => !r.resolved && (!now || nsMs(r.close_at) > now);

/** A row's planted headlines counted by verdict. */
export function tally(r: Pick<DuelRow, "chaos">) {
  const n = (o: string) => r.chaos?.filter((c) => c.outcome === o).length ?? 0;
  return { fooled: n("Flipped"), held: n("Held"), waiting: n("Pending"), other: n("NoTrial") + n("Expired") };
}

/** Finished duels for the list: those where a headline fooled its target first, then the rest, newest first within
 *  each (the input order is kept). */
export const fooledFirst = <R extends Pick<DuelRow, "chaos">>(rows: R[]): R[] => [
  ...rows.filter((r) => tally(r).fooled > 0),
  ...rows.filter((r) => tally(r).fooled === 0),
];

const noClock = () => null;

export function DuelRows({ rows, now }: { rows: DuelRow[]; now: number }) {
  return (
    <ul className="drows">
      {rows.map((r) => {
        const t = tally(r);
        // the headline the mini Trace draws: a fooled one if there is one, else a held one, else the first
        const i = r.chaos
          ? Math.max(
              0,
              ["Flipped", "Held"].map((o) => r.chaos?.findIndex((c) => c.outcome === o) ?? -1).find((x) => x >= 0) ?? 0,
            )
          : -1;
        const c = r.chaos?.[i];
        const at = r.chaos_at?.[i];
        return (
          <li key={`${r.arena}:${r.id}`}>
            <a href={duelPath(r.id, r.arena)}>
              <span className="mono id">{`#${r.id}`}</span>
              <span className="mini">
                {c && at ? (
                  <Trace
                    variant="mini"
                    name={`Duel ${r.id}, headline at ${at.toUpperCase()} ${shortModel(r[at].model)}`}
                    input={recordTrace(c)}
                    time={noClock}
                  />
                ) : (
                  <span className="note">{r.headlines ? "headlines not read" : "no headline planted"}</span>
                )}
              </span>
              <span className="mono who" title={`${r.a.model} vs ${r.b.model}`}>
                {shortModel(r.a.model)} <span className="dim">vs</span> {shortModel(r.b.model)}
              </span>
              <span className="marks">
                {t.fooled ? <Tag kind="alert">{`fooled ${t.fooled}`}</Tag> : null}
                {t.held ? <Tag kind="ink">{`held ${t.held}`}</Tag> : null}
                {t.waiting ? <Tag kind="live">{`waiting ${t.waiting}`}</Tag> : null}
                {t.other ? <Tag>{`did not count ${t.other}`}</Tag> : null}
              </span>
              <span className="state">{rowState(r, now)}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
