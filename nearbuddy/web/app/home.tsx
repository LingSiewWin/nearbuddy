"use client";
import { NETWORK_ID } from "./network";
// Home: a stranger understands the game in ten seconds and sees one action. The heading and the button render at
// once; the live duel panel reads the duel list (/api/list), picks the duel to show and draws both agents' Traces.
import { type DuelRow, duelPath, phaseOf, SYMBOL, traceOf, useDuel, useList, usePrice, verifyHref } from "./ui/data";
import { bet, nsMs, timeAgo } from "./ui/format";
import { Button, Countdown, LinkButton, Region, StatusBar, useNow } from "./ui/kit";
import { DuelRows, isRunning } from "./ui/rows";
import { Trace } from "./ui/trace-view";
import { pickLive } from "./ui/verdict";

type Shown = { row: DuelRow; mode: "live" | "late" | "last" };

/** The duel the panel shows: the live one by the design's rule; else a running one it is too late to attack; else
 *  the last finished duel as a replay. */
function choose(rows: DuelRow[], now: number, lock: (r: DuelRow) => number): Shown | null {
  const live = pickLive(rows, now, lock);
  if (live) return { row: live, mode: "live" };
  const late = rows.filter((r) => isRunning(r, now)).sort((x, y) => nsMs(x.close_at) - nsMs(y.close_at))[0];
  if (late) return { row: late, mode: "late" };
  const last = rows.find((r) => r.resolved && !r.cancelled);
  return last ? { row: last, mode: "last" } : null;
}

function Panel({ shown, now }: { shown: Shown; now: number }) {
  const { row, mode } = shown;
  const { read, a, b } = useDuel(row.id, row.arena);
  const running = mode !== "last";
  const price = usePrice(running, now);
  const body = read.data;
  const d = body?.duel ?? null;
  const staleAt = read.stale && now ? now - read.age * 1000 : null;
  const side = (which: "a" | "b") => {
    const it = which === "a" ? d?.last_intent_a : d?.last_intent_b;
    const h = which === "a" ? a : b;
    const trace =
      body && d && h
        ? traceOf(body, which, h, now, staleAt)
        : body && d
          ? traceOf(
              body,
              which,
              { decisions: [], loadedFrom: nsMs(d.close_at), current: null, reason: null, said: [], sealed: false },
              now,
              staleAt,
            )
          : null;
    return (
      <div className="home-side">
        <p>
          {which.toUpperCase()} <span className="mono">{row[which].model}</span>
          {it && d && phaseOf(d, now) === "running" ? (
            <span className="dim">{` · betting ${bet(it.side)}`}</span>
          ) : null}
        </p>
        <Trace variant="mini" name={`${which.toUpperCase()} ${row[which].model}`} input={trace} stale={read.stale} />
      </div>
    );
  };
  return (
    <>
      <div className="hrow">
        <h2 className="t-label">
          {running ? "Live duel" : "No duel running"}
          {running ? " · ends in " : null}
        </h2>
        {running ? (
          <span className="t-num">
            <Countdown to={nsMs(row.close_at)} now={now} stale={read.stale} />
          </span>
        ) : null}
      </div>
      {running ? (
        <p className="t-num">
          <span className="t-label">{SYMBOL(d?.symbol ?? "wrap.near")}</span>{" "}
          {price.price ? price.price.toFixed(4) : "—"}
        </p>
      ) : (
        <p className="t-small dim">{`Last duel · finished ${now ? timeAgo(nsMs(row.close_at), now) : ""}`}</p>
      )}
      {read.error ? (
        <StatusBar kind="error" reason={read.error} action={{ label: "Try again", run: read.retry }}>
          Could not read from the chain.
        </StatusBar>
      ) : null}
      {read.stale ? <StatusBar kind="stale">{`Last updated ${read.age}s ago. Retrying.`}</StatusBar> : null}
      <div className="boxed home-traces">
        {side("a")}
        {side("b")}
      </div>
    </>
  );
}

export default function Home() {
  const now = useNow();
  const list = useList();
  const rows = list.data?.duels ?? [];
  const lock = (r: DuelRow) => list.data?.lock_s[r.arena] ?? 0;
  const shown = list.data && now ? choose(rows, now, lock) : null;
  const others = rows
    .filter((r) => !shown || r.id !== shown.row.id || r.arena !== shown.row.arena)
    .sort((x, y) => Number(isRunning(y, now)) - Number(isRunning(x, now)))
    .slice(0, 5);
  return (
    <div className="page home">
      <div className="home-grid">
        <div className="home-lead stack-2">
          <h1 className="t-display">Lie to an AI.</h1>
          <p>If it falls for it and loses, you get paid.</p>
        </div>

        <section className="home-live stack-2" aria-label="Live duel">
          <Region
            read={list}
            skeleton={
              <div className="boxed home-traces">
                <Trace variant="mini" name="A" input={null} />
                <Trace variant="mini" name="B" input={null} />
              </div>
            }
          >
            {() =>
              shown ? (
                <Panel key={`${shown.row.arena}:${shown.row.id}`} shown={shown} now={now} />
              ) : now ? (
                <p>{`No duels yet on ${NETWORK_ID}.`}</p>
              ) : null
            }
          </Region>
        </section>

        <div className="home-cta stack-2">
          {!list.data || shown?.mode === "live" ? (
            <LinkButton variant="attack" href={shown ? duelPath(shown.row.id, shown.row.arena, "attack=a") : "/arena"}>
              Plant a fake headline
            </LinkButton>
          ) : shown?.mode === "late" ? (
            <Button variant="attack" disabled why="No new decision can land before it ends.">
              Too late for this duel
            </Button>
          ) : shown ? (
            <>
              <LinkButton variant="primary" href={duelPath(shown.row.id, shown.row.arena)}>
                See the last duel
              </LinkButton>
              <p className="t-small dim">No duel is running right now. Nothing to attack until the next one opens.</p>
            </>
          ) : now ? (
            <LinkButton variant="primary" href="/enter">
              Enter an agent
            </LinkButton>
          ) : null}
          {shown ? (
            <p>
              <a className="proof" href={verifyHref(shown.row.id, shown.row.arena)}>
                Verify this duel
              </a>
            </p>
          ) : null}
        </div>

        <section className="home-how sect stack-2">
          <h2 className="t-label">How it works</h2>
          <ol className="how">
            <li>Two AIs bet on the NEAR price.</li>
            <li>You plant one fake headline.</li>
            <li>Its next decision is signed in a secure enclave. Nobody can fake the result.</li>
          </ol>
        </section>
      </div>

      <div className="home-below">
        <section className="sect stack-2">
          <h2 className="t-label">In the lab</h2>
          <p>A fake claim alone fooled a naive AI 96% of the time. A hardened one: 7%.</p>
          <p>
            <a href="/evidence">See the evidence →</a>
          </p>
        </section>
        <section className="sect stack-2">
          <h2 className="t-label">Other duels</h2>
          {list.data ? (
            others.length ? (
              <DuelRows rows={others} now={now} />
            ) : (
              <p className="dim">No other duels.</p>
            )
          ) : null}
        </section>
      </div>
    </div>
  );
}
