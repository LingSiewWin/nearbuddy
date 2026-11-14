"use client";
// The duel list. Its job: find a duel. Every duel of both arenas in three groups that cannot contradict the home
// page: running (can still be watched live), awaiting the final price (time is up, not settled), and finished, where
// duels in which a headline fooled its target come first. Each row draws a mini Trace of its headline.
import { useState } from "react";
import { NETWORK_ID } from "../network";
import { useSite } from "../ui/chrome";
import { Panel, Readout, Strip, Tag } from "../ui/instruments";
import { Button, LinkButton, Region, Skeleton, useNow } from "../ui/kit";
import { RECORDED } from "../ui/replay";
import { DuelRows, fooledFirst, isRunning, tally } from "../ui/rows";

export default function Arena() {
  const { list } = useSite();
  const now = useNow();
  const [shown, setShown] = useState(20);
  return (
    <div className="page">
      <header className="page-head">
        <h1 className="t-display">Duels</h1>
        <Tag>{NETWORK_ID}</Tag>
        <p className="lede">
          Every recent duel between two AIs. A row's small Trace is its planted headline: the line crosses and turns red
          where the AI was fooled, and stays where it held.
        </p>
      </header>
      <Region read={list} skeleton={<Skeleton rows={8} />}>
        {(l) => {
          const running = l.duels.filter((r) => isRunning(r, now));
          const awaiting = l.duels.filter((r) => !r.resolved && !isRunning(r, now));
          const finished = fooledFirst(l.duels.filter((r) => r.resolved));
          const sum = l.duels.reduce(
            (s, r) => {
              const t = tally(r);
              return { fooled: s.fooled + t.fooled, held: s.held + t.held };
            },
            { fooled: 0, held: 0 },
          );
          return (
            <>
              <div className="deck c4">
                <Panel
                  label="Running"
                  tag={<Tag kind={running.length ? "ok" : "idle"}>{running.length ? "live" : "none"}</Tag>}
                >
                  <Readout value={running.length} unit={running.length === 1 ? "duel" : "duels"} />
                </Panel>
                <Panel label="Awaiting final price" tag={awaiting.length ? <Tag kind="live">closed</Tag> : undefined}>
                  <Readout value={awaiting.length} unit="closed, not settled" />
                </Panel>
                <Panel label="Finished">
                  <Readout value={finished.length} unit={`of the newest ${l.duels.length} listed`} />
                </Panel>
                <Panel label="Headlines in these duels" tag={<Tag>by the project</Tag>}>
                  <Readout value={sum.fooled} unit={`fooled of ${sum.fooled + sum.held} that reached a decision`} />
                  <Strip
                    n={sum.fooled}
                    of={sum.fooled + sum.held}
                    kind="alert"
                    label={`Fooled ${sum.fooled} of ${sum.fooled + sum.held}; held ${sum.held}`}
                  />
                </Panel>
              </div>
              <section aria-label="Running">
                <div className="sect-head">
                  <h2 className="t-label">Running</h2>
                </div>
                {running.length ? (
                  <DuelRows rows={running} now={now} />
                ) : (
                  <div className="empty">
                    <p>No duel is running right now, so there is nothing to lie to at the moment.</p>
                    <div className="stage-lead">
                      <LinkButton variant="primary" href="/">
                        Watch a real attack
                      </LinkButton>
                      <LinkButton variant="quiet" href={`/duel/${RECORDED.id}`}>
                        Open the recorded duel
                      </LinkButton>
                    </div>
                  </div>
                )}
              </section>
              {awaiting.length ? (
                <section aria-label="Awaiting final price">
                  <div className="sect-head">
                    <h2 className="t-label">Awaiting final price</h2>
                    <span className="dim">Time is up. Nothing can be planted; the result follows the oracle.</span>
                  </div>
                  <DuelRows rows={awaiting} now={now} />
                </section>
              ) : null}
              <section aria-label="Finished">
                <div className="sect-head">
                  <h2 className="t-label">Finished</h2>
                  <span className="dim">Duels where a headline fooled an AI first, then newest first.</span>
                </div>
                {finished.length ? (
                  <>
                    <DuelRows rows={finished.slice(0, shown)} now={now} />
                    {finished.length > shown ? (
                      <Button variant="quiet" onClick={() => setShown(shown + 20)}>
                        {`Show ${Math.min(20, finished.length - shown)} more`}
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <p>{`No duel has finished yet on ${NETWORK_ID}.`}</p>
                )}
              </section>
            </>
          );
        }}
      </Region>
    </div>
  );
}
