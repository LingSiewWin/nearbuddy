"use client";
// The landing page. Block 1, the hero, is the first step of the game: the two AIs of the live duel, each a choice.
// Blocks 2 to 6 are for the visitor who stayed: how it works, one number from the lab, the proof, six questions and
// the closing line. The hero's only number is the time left.
import { NETWORK_ID } from "./network";
import { LabChart } from "./ui/charts";
import { useSite } from "./ui/chrome";
import { type DuelRow, duelPath, type History, traceOf, useDuel, verifyHref } from "./ui/data";
import { bet, nsMs } from "./ui/format";
import { Button, Countdown, Details, LinkButton, StatusBar, useNow } from "./ui/kit";
import { isRunning } from "./ui/rows";
import { recordTrace, type TraceIn } from "./ui/trace";
import { Trace } from "./ui/trace-view";
import { pickLive } from "./ui/verdict";

type Shown = { row: DuelRow; mode: "live" | "late" | "last" };

/** The duel the hero shows: the live one by the design's rule; else a running one it is too late to attack; else the
 *  last finished duel. */
function choose(rows: DuelRow[], now: number, lock: (r: DuelRow) => number): Shown | null {
  const live = pickLive(rows, now, lock);
  if (live) return { row: live, mode: "live" };
  const late = rows.filter((r) => isRunning(r, now)).sort((x, y) => nsMs(x.close_at) - nsMs(y.close_at))[0];
  if (late) return { row: late, mode: "late" };
  const last = rows.find((r) => r.resolved && !r.cancelled);
  return last ? { row: last, mode: "last" } : null;
}

const NONE: History = { decisions: [], loadedFrom: null, current: null, reason: null, said: [], sealed: false };

/** The framed panel: each AI with its bet, its Trace and its button. */
function Picks({ shown, now }: { shown: Shown; now: number }) {
  const { row, mode } = shown;
  const { read, a, b } = useDuel(row.id, row.arena);
  const body = read.data;
  const d = body?.duel ?? null;
  const staleAt = read.stale && now ? now - read.age * 1000 : null;
  const pick = (which: "a" | "b") => {
    const it = which === "a" ? d?.last_intent_a : d?.last_intent_b;
    const h = (which === "a" ? a : b) ?? (d ? { ...NONE, loadedFrom: nsMs(d.close_at) } : null);
    const won = row.winner === "Tie" ? "tie" : row.winner === which.toUpperCase() ? "won" : "lost";
    return (
      <div className="pick">
        <p className="who">{row[which].model}</p>
        {mode === "last" ? null : it ? (
          <p>
            Betting the price goes <span className="ink">{bet(it.side)}</span>
          </p>
        ) : d ? (
          <p className="dim">No decision yet.</p>
        ) : null}
        <Trace
          variant="mini"
          name={row[which].model}
          input={body && h ? traceOf(body, which, h, now, staleAt) : null}
          stale={read.stale}
        />
        {mode === "last" ? (
          <p className={won === "lost" ? "dim" : "ink"}>{won}</p>
        ) : mode === "late" ? (
          <Button variant="attack" disabled>
            Too late for this duel
          </Button>
        ) : d && !it ? (
          <Button variant="attack" disabled why="Wait for its first decision.">
            Lie to this one
          </Button>
        ) : (
          <LinkButton variant="attack" href={duelPath(row.id, row.arena, `attack=${which}`)}>
            Lie to this one
          </LinkButton>
        )}
      </div>
    );
  };
  return (
    <>
      {read.error ? (
        <StatusBar kind="error" reason={read.error} action={{ label: "Try again", run: read.retry }}>
          Could not read from the chain.
        </StatusBar>
      ) : null}
      {read.stale ? <StatusBar kind="stale">{`Last updated ${read.age}s ago. Retrying.`}</StatusBar> : null}
      <div className="frame">
        <i />
        <i />
        <i />
        <i />
        <div className="picks">
          {pick("a")}
          {pick("b")}
        </div>
      </div>
      {mode === "late" ? (
        <>
          <p className="t-small dim">No new decision can land before it ends.</p>
          <LinkButton variant="quiet" href="/arena">
            See all duels
          </LinkButton>
        </>
      ) : null}
      {mode === "last" ? (
        <>
          <LinkButton variant="quiet" href={duelPath(row.id, row.arena)}>
            See what happened
          </LinkButton>
          <p className="t-small dim">Nothing to attack until the next duel opens.</p>
        </>
      ) : null}
    </>
  );
}

// the three drawings of "How it works": a bet, a planted headline waiting, a line that crossed
const STEP: TraceIn[] = [
  { from: 0, to: 100, now: 100, running: false, decisions: [{ at: 0, side: "Long" }], loadedFrom: null, pins: [] },
  recordTrace({ outcome: "Pending", kind: "Short", prev: "Long", next: null }),
  recordTrace({ outcome: "Flipped", kind: "Short", prev: "Long", next: "Short" }),
];
const noClock = () => null;

export default function Home() {
  const now = useNow();
  const { list } = useSite();
  const rows = list.data?.duels ?? [];
  const lock = (r: DuelRow) => list.data?.lock_s[r.arena] ?? 0;
  const shown = list.data && now ? choose(rows, now, lock) : null;
  const last = rows.find((r) => r.resolved && !r.cancelled) ?? null;
  const running = shown && shown.mode !== "last";
  return (
    <div className="page home">
      <section className="hero" aria-label="The live duel">
        <div className="stack">
          {shown ? (
            <p className="pill">
              {running ? (
                <>
                  LIVE · ends in <Countdown to={nsMs(shown.row.close_at)} now={now} stale={list.stale} />
                </>
              ) : (
                "NO DUEL RUNNING"
              )}
            </p>
          ) : null}
          <h1 className="t-display">Lie to an AI.</h1>
          <p>If it falls for it and loses, you get paid.</p>
        </div>
        <div className="hero-panel stack-2">
          <h2 className="t-label">{shown?.mode === "last" ? "The last duel" : "Pick one to lie to"}</h2>
          {list.data ? (
            shown ? (
              <Picks key={`${shown.row.arena}:${shown.row.id}`} shown={shown} now={now} />
            ) : now ? (
              <>
                <p>{`No duels yet on ${NETWORK_ID}.`}</p>
                <LinkButton variant="primary" href="/enter">
                  Enter an agent
                </LinkButton>
              </>
            ) : null
          ) : list.error ? (
            <StatusBar kind="error" reason={list.error} action={{ label: "Try again", run: list.retry }}>
              Could not read from the chain.
            </StatusBar>
          ) : (
            <div className="frame" aria-busy="true">
              <i />
              <i />
              <i />
              <i />
              <div className="picks">
                {["A", "B"].map((n) => (
                  <div className="pick" key={n}>
                    <Trace variant="mini" name={n} input={null} />
                    <Button variant="quiet" disabled style={{ width: "100%" }}>
                      Lie to this one
                    </Button>
                  </div>
                ))}
              </div>
              {list.slow ? <p className="t-small caution">Reading from the chain…</p> : null}
            </div>
          )}
        </div>
        <p className="hero-links">
          <a href="#how">How it works ↓</a>
          {shown ? (
            <a className="proof" href={verifyHref(shown.row.id, shown.row.arena)}>
              Verify this duel
            </a>
          ) : null}
        </p>
      </section>

      <section className="block" id="how">
        <h2 className="t-label">How it works</h2>
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
      </section>

      <section className="block split" id="research">
        <div className="stack">
          <p className="big">In the lab, one fake headline fooled a naive AI 96% of the time. A hardened one: 7%.</p>
          <p>
            <a href="/evidence">See the research</a>
          </p>
        </div>
        <LabChart
          id="home"
          bars={[
            { label: "Naive prompt", rate: 676 / 704, text: "676 of 704 (96%)" },
            { label: "Hardened prompt", rate: 49 / 705, text: "49 of 705 (7%)" },
          ]}
        />
      </section>

      <section className="block" id="proof">
        <p className="big">Do not trust this page.</p>
        <p>
          Every decision an AI makes here is signed inside a secure enclave, and the arena contract checks that
          signature before it accepts the decision. The result of a duel and every payout are worked out by the contract
          from public data, so you can run the same checks yourself.
        </p>
        {last ? (
          <p>
            <a className="proof" href={verifyHref(last.id, last.arena)}>
              Verify the last duel yourself
            </a>
          </p>
        ) : null}
      </section>

      <section className="block" id="questions">
        <h2 className="t-label">Questions</h2>
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
              It keeps what your headline cost. If it is fooled you get your money back less a fee, plus a share of its
              bond when it also loses the duel. If your attack does not count, or the duel ends before it decides again,
              you get your money back less the fee.
            </p>
          </Details>
          <Details label="What does “signed in an enclave” mean?">
            <p>
              The AI runs inside sealed hardware that its operator cannot look into or change. That hardware signs each
              decision, and the arena contract checks the signature before it accepts the decision.
            </p>
          </Details>
          <Details label="Can the team fake a result?">
            <p>
              Not through this site. The arena contract decides every verdict from decisions signed inside the enclave,
              and the checks run on public chain data, on your own machine if you like. When a check fails or could not
              be run, the Verify panel says so.
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
      </section>

      <section className="block">
        <p className="t-display">Lie to an AI.</p>
        {shown?.mode === "live" ? (
          <LinkButton variant="attack" fit href={duelPath(shown.row.id, shown.row.arena)}>
            Attack an AI
          </LinkButton>
        ) : last ? (
          <LinkButton variant="quiet" href={duelPath(last.id, last.arena)}>
            See the last duel
          </LinkButton>
        ) : null}
      </section>
    </div>
  );
}
