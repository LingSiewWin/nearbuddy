"use client";
// The duel list: every duel of both arenas, running first, then finished, newest first, 20 at a time.
import { useState } from "react";
import { NETWORK_ID } from "../network";
import { useSite } from "../ui/chrome";
import { Button, Region, Skeleton, useNow } from "../ui/kit";
import { DuelRows } from "../ui/rows";

export default function Arena() {
  const { list } = useSite();
  const now = useNow();
  const [shown, setShown] = useState(20);
  return (
    <div className="page stack-5">
      <h1 className="t-display">Duels</h1>
      <Region read={list} skeleton={<Skeleton rows={6} />}>
        {(l) => {
          // a duel past its close and not settled yet is not finished: it stays in the first section
          const running = l.duels.filter((r) => !r.resolved);
          const finished = l.duels.filter((r) => r.resolved);
          return (
            <div className="stack-5">
              <section className="stack-2">
                <h2 className="t-label">Running</h2>
                {running.length ? <DuelRows rows={running} now={now} wide /> : <p>No duel is running right now.</p>}
              </section>
              <section className="stack-2">
                <h2 className="t-label">Finished</h2>
                {finished.length ? (
                  <>
                    <DuelRows rows={finished.slice(0, shown)} now={now} wide />
                    {finished.length > shown ? (
                      <Button variant="quiet" onClick={() => setShown(shown + 20)}>
                        Show more
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <p>{`No duel has finished yet on ${NETWORK_ID}.`}</p>
                )}
              </section>
            </div>
          );
        }}
      </Region>
    </div>
  );
}
