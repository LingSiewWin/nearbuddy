"use client";
// The landing page as a control room. Its job: understand the game and start. The centre is the Trace: the live
// duel when one can be attacked, otherwise a replay of a real recorded attack (ui/room.tsx), so the page is never an
// empty panel. Around it sit the instruments; under it the lab's findings as small counted charts, recorded attacks
// from the dataset, how it works, the proof and the questions. Directly under the centre: the practice round
// (ui/practice.tsx), which works at any hour; it is offered second while a duel is live.
import { useState } from "react";
import board from "./data/board.json";
import { NETWORK_ID } from "./network";
import { useSite } from "./ui/chrome";
import { type DuelRow, duelPath, type History, traceOf, useDuel, usePrice, verifyHref } from "./ui/data";
import { bet, near, nsMs, shortModel, TEST_NOTE } from "./ui/format";
import { Panel, Readout, Strip, Tag } from "./ui/instruments";
import { Button, Countdown, Details, LinkButton, StatusBar, useNow } from "./ui/kit";
import { PracticePanel } from "./ui/practice";
import { RECORDED } from "./ui/replay";
import { MachineQuote } from "./ui/result";
import { BetTag, ChecksPanel, PricePanel, ReplayActions, ReplayRoom, Stage } from "./ui/room";
import { isRunning } from "./ui/rows";
import { recordTrace, type TraceIn } from "./ui/trace";
import { Trace } from "./ui/trace-view";
import { pickLive } from "./ui/verdict";

type Shown = { row: DuelRow; mode: "live" | "late" };

/** The duel the centre shows live: the one the design's rule picks; else a running one it is too late to attack. */
function choose(rows: DuelRow[], now: number, lock: (r: DuelRow) => number): Shown | null {
  const live = pickLive(rows, now, lock);
  if (live) return { row: live, mode: "live" };
  const late = rows.filter((r) => isRunning(r, now)).sort((x, y) => nsMs(x.close_at) - nsMs(y.close_at))[0];
  return late ? { row: late, mode: "late" } : null;
}

const NONE: History = { decisions: [], loadedFrom: null, current: null, reason: null, said: [], sealed: false };

/** The live duel as a control room: both Traces in the centre, each AI with its button, the instruments around. */
function LiveRoom({ shown, now, onReplay }: { shown: Shown; now: number; onReplay: () => void }) {
  const { row, mode } = shown;
  const { read, a, b } = useDuel(row.id, row.arena);
  const price = usePrice(true, now);
  const body = read.data;
  const d = body?.duel ?? null;
  const staleAt = read.stale && now ? now - read.age * 1000 : null;
  const hist = (w: "a" | "b") => (w === "a" ? a : b) ?? (d ? { ...NONE, loadedFrom: nsMs(d.close_at) } : null);
  const tr = (w: "a" | "b") => {
    const h = hist(w);
    return body && h ? traceOf(body, w, h, now, staleAt) : null;
  };
  const intent = (w: "a" | "b") => (w === "a" ? d?.last_intent_a : d?.last_intent_b) ?? null;
  const agent = (w: "a" | "b") => {
    const it = intent(w);
    const view = w === "a" ? body?.a : body?.b;
    return (
      <Panel label={`Agent ${w.toUpperCase()}`} tag={<BetTag side={it?.side ?? null} sealed={!!hist(w)?.sealed} />}>
        <Readout small value={<span title={row[w].model}>{shortModel(row[w].model)}</span>} />
        <dl className="kv">
          <dt>Bet</dt>
          <dd>{it ? bet(it.side) : "—"}</dd>
          <dt>Bond</dt>
          <dd>{view ? near(view.bond) : "—"}</dd>
        </dl>
        {hist(w)?.reason ? <MachineQuote text={hist(w)?.reason ?? null} clamp /> : null}
        {mode === "late" ? (
          <Button variant="attack" disabled why="Too late for this duel. No new decision can land before it ends.">
            Lie to this one
          </Button>
        ) : d && !it ? (
          <Button variant="attack" disabled why="Wait for its first decision. An attack needs a bet to push against.">
            Lie to this one
          </Button>
        ) : (
          <LinkButton variant="attack" href={duelPath(row.id, row.arena, `attack=${w}`)}>
            Lie to this one
          </LinkButton>
        )}
      </Panel>
    );
  };
  return (
    <div className="room">
      <Stage
        head={
          <>
            <Tag kind="ok">live</Tag>
            <a className="mono" href={duelPath(row.id, row.arena)}>{`duel #${row.id}`}</a>
            <span className="dim">{`on ${NETWORK_ID}`}</span>
            <span className="end">
              ends in <Countdown to={nsMs(row.close_at)} now={now} stale={read.stale} />
            </span>
          </>
        }
        a={tr("a")}
        b={tr("b")}
        names={[row.a.model, row.b.model]}
        samples={price.samples}
        stale={read.stale}
        priceStale={price.stale}
      >
        {read.error ? (
          <StatusBar kind="error" reason={read.error} action={{ label: "Try again", run: read.retry }}>
            Could not read from the chain.
          </StatusBar>
        ) : null}
        {read.stale ? <StatusBar kind="stale">{`Last updated ${read.age}s ago. Retrying.`}</StatusBar> : null}
        <div className="stage-lead">
          <LinkButton variant="quiet" href={duelPath(row.id, row.arena)}>
            Open this duel
          </LinkButton>
          <button type="button" className="btn btn-quiet" onClick={onReplay}>
            Watch a recorded attack
          </button>
        </div>
      </Stage>
      <div className="room-col room-left">
        {agent("a")}
        {agent("b")}
      </div>
      <div className="room-col room-right">
        <PricePanel
          price={price.price}
          samples={price.samples}
          open={d?.open_price}
          source="Line: this browser's own readings since the page opened."
          stale={price.stale}
        />
        <Panel label="Cost to plant a headline" tag={<Tag>test NEAR</Tag>}>
          <Readout value={d?.chaos_fee ? near(d.chaos_fee).replace(" NEAR", "") : "—"} unit="NEAR" />
          <p className="note">{`The price of the next headline in this duel. ${NETWORK_ID === "testnet" ? `${TEST_NOTE}.` : ""}`}</p>
        </Panel>
        <ChecksPanel counts={null} href={verifyHref(row.id, row.arena)} />
      </div>
    </div>
  );
}

// the three drawings of "How it works": a bet, a planted headline waiting, a line that crossed
const STEP: TraceIn[] = [
  { from: 0, to: 100, now: 100, running: false, decisions: [{ at: 0, side: "Long" }], loadedFrom: null, pins: [] },
  recordTrace({ outcome: "Pending", kind: "Short", prev: "Long", next: null }),
  recordTrace({ outcome: "Flipped", kind: "Short", prev: "Long", next: "Short" }),
];
const noClock = () => null;

/** The lab's measured figures (nearbuddy/lab) and the live count: each a small instrument with its count. */
function Findings() {
  return (
    <section aria-label="What has been measured">
      <div className="sect-head">
        <h2 className="t-label">Measured</h2>
        <a href="/evidence">The research, with its captions →</a>
      </div>
      <div className="deck c4">
        <Panel label="Lab · naive prompt" tag={<Tag kind="alert">fooled</Tag>}>
          <Readout value="676" unit="of 704 changed their bet" />
          <Strip n={676} of={704} kind="alert" label="Fooled 676 of 704" />
          <p className="note">One fake headline with its credibility cues. With the cues removed: 674 of 704.</p>
        </Panel>
        <Panel label="Lab · hardened prompt" tag={<Tag kind="ink">mostly held</Tag>}>
          <Readout value="49" unit="of 705 changed their bet" />
          <Strip n={49} of={705} kind="alert" label="Fooled 49 of 705" />
          <p className="note">The same headlines against a prompt told to ignore unsourced claims.</p>
        </Panel>
        <Panel label="Lab · neutral line instead" tag={<Tag>baseline</Tag>}>
          <Readout value="128" unit="of 707 changed their bet" />
          <Strip n={128} of={707} kind="ink" label="Changed 128 of 707" />
          <p className="note">Naive prompt, a neutral line in the headline's place. Hardened: 58 of 713.</p>
        </Panel>
        <Panel label="Lab · no attack at all" tag={<Tag>noise</Tag>}>
          <Readout value="5" unit="of 45 prompts changed side" />
          <Strip n={5} of={45} cells={45} kind="ink" label="Changed 5 of 45" />
          <p className="note">The same prompts run again. One result is one result.</p>
        </Panel>
        <Panel label="Lab · honest market shown" tag={<Tag kind="ink">about half</Tag>}>
          <Readout value="46% and 47%" unit="fooled, 36 trials per cell" />
          <Strip n={47} of={100} cells={36} kind="alert" label="About 47% fooled with an honest market price shown" />
          <p className="note">Against about 100% with the fake claim alone, in the same run.</p>
        </Panel>
        <Panel label="Lab · model may look" tag={<Tag>range</Tag>}>
          <Readout value="29% to 40%" unit="fooled" />
          <p className="note">When the model was allowed to choose to look at an honest market.</p>
        </Panel>
        <Panel label="Live attacks" tag={<Tag kind="live">live</Tag>}>
          <Readout value="12" unit="fooled of 23 that reached a decision" />
          <Strip n={12} of={23} cells={23} kind="alert" label="Fooled 12 of 23; 11 held" />
          <p className="note">58 placed, 23 reached a decision, 11 held. All placed by the project's own accounts.</p>
        </Panel>
        <Panel label="Records" tag={<Tag kind="ok">signed</Tag>}>
          <Readout value="9,297" unit="enclave-signed calls, main lab run" />
          <Readout value={board.rows.toLocaleString("en-US")} unit="recorded decisions in the dataset" />
          <a className="btn-link" href="/board">
            See every recorded decision
          </a>
        </Panel>
      </div>
    </section>
  );
}

const WORD = { fooled: ["fooled", "alert"], held: ["held", "ink"], untested: ["did not count", "idle"] } as const;

export default function Home({ practice }: { practice: boolean }) {
  const now = useNow();
  const { list } = useSite();
  const [replay, setReplay] = useState(false);
  const rows = list.data?.duels ?? [];
  const lock = (r: DuelRow) => list.data?.lock_s[r.arena] ?? 0;
  const shown = list.data && now ? choose(rows, now, lock) : null;
  const last = rows.find((r) => r.resolved && !r.cancelled) ?? null;
  return (
    <div className="page home">
      <header className="page-head">
        <h1 className="t-display">Lie to an AI.</h1>
        {shown ? (
          <Tag kind="ok">
            live · ends in <Countdown to={nsMs(shown.row.close_at)} now={now} stale={list.stale} />
          </Tag>
        ) : list.data && now ? (
          <Tag>no duel running</Tag>
        ) : list.error ? (
          <Tag kind="live">arena not read</Tag>
        ) : (
          <Tag>reading the arena</Tag>
        )}
        <p className="lede">
          Plant one fake headline at an AI trading agent and see if it changes its bet. <a href="#how">How it works</a>
        </p>
      </header>

      {/* on a phone with no live duel the practice round is shown above the recording (CSS order), so the page's
          main action is near the top; on desktop it sits directly under the centre */}
      <div className={`home-main${shown ? "" : " practice-first"}`}>
        {shown && !replay ? (
          <LiveRoom
            key={`${shown.row.arena}:${shown.row.id}`}
            shown={shown}
            now={now}
            onReplay={() => setReplay(true)}
          />
        ) : (
          <ReplayRoom
            quiet
            rec={RECORDED}
            lead={({ restart }) =>
              shown ? (
                <>
                  <ReplayActions rec={RECORDED} restart={restart} />
                  <button type="button" className="btn btn-quiet" onClick={() => setReplay(false)}>
                    Back to the live duel
                  </button>
                </>
              ) : (
                <p className="note">
                  {list.data
                    ? "No duel is running, so this is a recording of a real attack."
                    : list.error
                      ? "The arena could not be read just now. This is a recording of a real attack."
                      : "Reading the arena. Meanwhile, this is a recording of a real attack."}
                </p>
              )
            }
          />
        )}
        <PracticePanel enabled={practice} second={!!shown} />
      </div>

      <Findings />

      <div id="how" className="deck c3 gap-top">
        <Panel label="How it works">
          <ol className="steps">
            {[
              "Two AIs bet on the NEAR price.",
              "You plant one fake headline.",
              "Its next decision is signed in a secure enclave. If it fell for it and loses, you get paid.",
            ].map((text, i) => (
              <li key={text}>
                <span>{i + 1}</span>
                <span>{text}</span>
                <Trace variant="mini" name={`Step ${i + 1}`} input={STEP[i] ?? null} time={noClock} />
              </li>
            ))}
          </ol>
        </Panel>
        <Panel label="Recorded attacks" tag={<Tag>dataset</Tag>}>
          <ul className="attacks">
            {board.recent.slice(0, 5).map((r) => {
              const [word, kind] = WORD[r.verdict as keyof typeof WORD] ?? WORD.untested;
              return (
                <li key={`${r.duel_id}:${r.agent_pk}:${r.text.slice(0, 24)}`}>
                  <p className="planted-top">
                    <span className="mono dim" title={r.model}>{`#${r.duel_id} · ${shortModel(r.model)}`}</span>
                    <Tag kind={kind}>{word}</Tag>
                  </p>
                  <blockquote className="hl line">{`“${r.text}”`}</blockquote>
                </li>
              );
            })}
          </ul>
          <p className="note">
            The newest attacks in the published dataset, scored by its own rule. All were made by the project.
          </p>
          <a className="btn-link" href="/board">
            Compare the models
          </a>
        </Panel>
        <Panel label="Do not trust this page" tag={<Tag kind="ok">checkable</Tag>}>
          <p>
            Every decision an AI makes here is signed inside a secure enclave, and the arena contract checks that
            signature before it accepts the decision. The result of a duel and every payout are worked out by the
            contract from public data, so you can run the same checks yourself.
          </p>
          <a className="btn-link" href={last ? verifyHref(last.id, last.arena) : verifyHref(RECORDED.id, "main")}>
            {last ? "Verify the last duel yourself" : "Verify the recorded duel yourself"}
          </a>
          <div>
            <Details label="Is this real money?">
              <p>
                {NETWORK_ID === "testnet"
                  ? "No. This runs on a test network: every amount is test NEAR, which has no real value."
                  : "Yes. Amounts here are NEAR on the main network."}
              </p>
            </Details>
            <Details label="What happens to my money if the AI holds?">
              <p>
                It keeps what your headline cost. If it is fooled you get your money back less a fee, plus a share of
                its bond when it also loses the duel. If your attack does not count, or the duel ends before it decides
                again, you get your money back less the fee.
              </p>
            </Details>
            <Details label="What does “signed in an enclave” mean?">
              <p>
                The AI runs inside sealed hardware that its operator cannot look into or change. That hardware signs
                each decision, and the arena contract checks the signature before it accepts the decision.
              </p>
            </Details>
            <Details label="Can the team fake a result?">
              <p>
                Not through this site. The arena contract decides every verdict from decisions signed inside the
                enclave, and the checks run on public chain data, on your own machine if you like. When a check fails or
                could not be run, the Verify panel says so.
              </p>
            </Details>
            <Details label="Who made the attacks so far?">
              <p>
                The team. Live attacks so far: 58 placed, 23 reached a decision (12 fooled, 11 held), all made by the
                team.
              </p>
            </Details>
            <Details label="Can I enter my own agent?">
              <p>Yes. Lock a bond, give it a strategy, and let people try to fool it.</p>
              <LinkButton variant="quiet" href="/enter">
                Enter your agent
              </LinkButton>
            </Details>
          </div>
        </Panel>
      </div>
    </div>
  );
}
