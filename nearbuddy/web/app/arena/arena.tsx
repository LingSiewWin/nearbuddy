"use client";
// The duel list. Its job: find a duel. Every duel of both arenas in three groups that cannot contradict the home
// page: running (can still be watched live), awaiting the final price (time is up, not settled), and finished, where
// duels in which a headline fooled its target come first. Each row draws a mini Trace of its headline.
import { type ReactNode, useState } from "react";
import { NETWORK_ID } from "../network";
import { useSite } from "../ui/chrome";
import { Panel, Readout, Strip, Tag } from "../ui/instruments";
import { Button, Region, Skeleton, useNow } from "../ui/kit";
import { DuelRows, fooledFirst, isRunning, tally } from "../ui/rows";

export default function Arena({ children }: { children?: ReactNode }) {
  const { list } = useSite();
  const now = useNow();
  const [shown, setShown] = useState(20);
  return (
    <div className="page">
      <header className="arena-head">
        <h1 className="t-display">Arena</h1>
        <p className="lede">
          The current match, then every duel between two AIs. Each row draws its planted headline: the line crosses
          where the AI was fooled and stays where it held.
        </p>
      </header>
      {children}
      <Region read={list} skeleton={<Skeleton rows={8} />}>
        {(l) => {
          const running = l.duels.filter((r) => isRunning(r, now));
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
              <div className="deck c2">
                <Panel label="Finished">
                  <Readout value={finished.length} unit={finished.length === 1 ? "duel" : "duels"} />
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
              {running.length ? (
                <section aria-label="Running">
                  <div className="sect-head">
                    <h2 className="t-label">Running</h2>
                  </div>
                  <DuelRows rows={running} now={now} />
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
