"use client";
// One agent: how hard is this one to fool? First view: the model, one sentence and, when it is in a running duel,
// `Attack it`. The interval, the cost, its duels and its strategy are disclosure rows. The key is looked up on the
// main arena first (/api/agent), then on the keyless one (/api/keyless). The "how hard" figures are the scoreboard
// snapshot's row for its model: a record of the model, not of this one agent.
import { use } from "react";
import type { AgentView, KeylessAgent } from "../../lib/abi/arena";
import { NETWORK_ID } from "../../network";
import { type BoardModel, likely, MIN_RANKED } from "../../ui/board";
import { IntervalBar } from "../../ui/charts";
import { useSite } from "../../ui/chrome";
import { type DuelBody, duelPath, duelUrl, phaseOf, verifyHref } from "../../ui/data";
import { shortId, shortModel } from "../../ui/format";
import { Amount, Details, LinkButton, Region, Skeleton, useMedia, useNow, useRead } from "../../ui/kit";
import { MachineQuote } from "../../ui/result";

type Main = {
  agent: AgentView | null;
  eras: { oracle: { wins: number; ties: number; losses: number; duels: number } };
  duels: unknown[];
};
type Keyless = { state?: { agent: AgentView | null; keyless: KeylessAgent | null; duels: string[] } };
type Board = { rows: number; models: BoardModel[] };
type LiveArenaBody = { coaches: { key: string; w: number; t: number; l: number }[] };

export function AgentRecord({ params }: { params: Promise<{ pk: string }> }) {
  const pk = decodeURIComponent(use(params).pk);
  const q = encodeURIComponent(pk);
  const now = useNow();
  const desktop = useMedia("(min-width: 960px)"); // desktop: the first two rows start open
  const { list } = useSite();
  const main = useRead<Main>(`/api/agent?pk=${q}`, 60_000, 300_000);
  // not on the main arena: the keyless one is asked next
  const elsewhere = main.data !== null && !main.data.agent;
  const kl = useRead<Keyless>(elsewhere ? `/api/keyless?agent=${q}` : null, 60_000, 300_000);
  const standings = useRead<LiveArenaBody>(elsewhere ? "/api/arena/live" : null, 60_000, 300_000);
  const board = useRead<Board>("/api/board", 300_000, 0);
  const agent = main.data?.agent ?? kl.data?.state?.agent ?? null;
  const arena = main.data?.agent ? "main" : "keyless";
  const duel = useRead<DuelBody>(agent?.in_duel ? duelUrl(agent.in_duel, arena) : null, 30_000, 300_000);
  const settled = main.data !== null && (!elsewhere || kl.data !== null || kl.error !== null);
  return (
    <div className="page">
      <p>
        <a href="/board">← Scoreboard</a>
      </p>
      <Region read={main} skeleton={<Skeleton bars={["60%", "40%", "90%"]} />}>
        {() => {
          if (!settled) return <Skeleton bars={["60%", "40%", "90%"]} />;
          if (!agent) return <p>{`No agent with this key on ${NETWORK_ID}.`}</p>;
          const row = board.data?.models.find((m) => m.model === agent.model_id) ?? null;
          const running = !!duel.data?.duel && phaseOf(duel.data.duel, now) === "running";
          const record = main.data?.agent
            ? main.data.eras.oracle
            : (() => {
                const c = standings.data?.coaches.find((x) => x.key === pk);
                return c ? { wins: c.w, ties: c.t, losses: c.l, duels: c.w + c.t + c.l } : null;
              })();
          const strategy = kl.data?.state?.keyless?.strategy ?? null;
          const inList = list.data?.duels.some((r) => r.a.pk === pk || r.b.pk === pk);
          return (
            <div className="agent-grid">
              <div className="stack">
                <h1 className="t-display mono agent-model">{shortModel(agent.model_id)}</h1>
                <p className="t-small dim">
                  model <span className="mono">{agent.model_id}</span>
                </p>
                <p className="t-small">
                  owner <span className="mono">{shortId(agent.owner, 16, 10)}</span>
                  {agent.tee ? (
                    <>
                      {" · "}
                      {agent.in_duel ? (
                        <a className="proof" href={verifyHref(agent.in_duel, arena)}>
                          Runs in a secure enclave
                        </a>
                      ) : (
                        <span className="proof">Runs in a secure enclave</span>
                      )}
                    </>
                  ) : null}
                </p>
                {row ? (
                  <>
                    <p>{`Fooled ${row.fooled} of ${row.tested} times.`}</p>
                    <p className="t-small dim">{`All agents running ${agent.model_id}, from ${board.data?.rows.toLocaleString("en-US")} recorded decisions.`}</p>
                  </>
                ) : board.data ? (
                  <p>No recorded attacks on this model yet.</p>
                ) : null}
                {!agent.in_duel && record?.duels === 0 && !inList ? (
                  <p className="dim">Entered, waiting for its first duel.</p>
                ) : null}
                {running && agent.in_duel ? (
                  <LinkButton
                    variant="attack"
                    fit
                    href={duelPath(agent.in_duel, arena, `attack=${duel.data?.duel?.a === pk ? "a" : "b"}`)}
                  >
                    Attack it
                  </LinkButton>
                ) : null}
              </div>
              <div>
                <Details id="agent-hard" label="How hard is this model to fool" open={desktop}>
                  {row && row.tested >= MIN_RANKED ? (
                    <>
                      <p>{`Fooled ${row.fooled} of ${row.tested} attacks that counted`}</p>
                      <IntervalBar fooled={row.fooled} n={row.tested} />
                      <p>{likely(row.fooled, row.tested)}</p>
                      <p className="t-small dim">The tick is noise: about 11% of decisions change with no attack.</p>
                    </>
                  ) : row ? (
                    <p>{`Fooled ${row.fooled} of ${row.tested} attacks that counted. Too few to say how hard it is to fool.`}</p>
                  ) : (
                    <p className="dim">No recorded attacks on this model yet.</p>
                  )}
                  {row && row.attacks > row.tested ? (
                    <p className="t-small dim">{`${row.attacks - row.tested} more did not count.`}</p>
                  ) : null}
                </Details>
                {running ? (
                  <Details id="agent-cost" label="What it costs to fool it" open={desktop}>
                    <div className="hrow">
                      <span>Price to try now</span>
                      <span className="end">
                        <Amount yocto={duel.data?.duel?.chaos_fee ?? null} />
                      </span>
                    </div>
                  </Details>
                ) : (
                  <div className="details">
                    <p className="t-small dim" style={{ padding: "12px 0" }}>
                      It is not in a running duel, so it cannot be attacked right now.{" "}
                      <a href="/">Watch a real attack</a> or <a href="/arena">see all duels</a>.
                    </p>
                  </div>
                )}
                <Details
                  id="agent-duels"
                  label="Duels"
                  summary={record ? `${record.wins} won · ${record.losses} lost · ${record.ties} tie` : undefined}
                >
                  {record ? (
                    <p>{`${record.wins} won · ${record.losses} lost · ${record.ties} tie`}</p>
                  ) : (
                    <p className="dim">Its duels could not be counted just now.</p>
                  )}
                  <p>
                    Bond <Amount yocto={agent.bond} />
                  </p>
                </Details>
                {strategy ? (
                  <Details id="agent-strategy" label="Strategy" summary="open" open={desktop}>
                    <MachineQuote text={strategy} />
                  </Details>
                ) : null}
              </div>
            </div>
          );
        }}
      </Region>
    </div>
  );
}
