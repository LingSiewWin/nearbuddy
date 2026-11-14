"use client";
// The control room: the Trace drawn large as the central object (Stage), the instrument panels around it, and the
// replay that keeps it alive when no duel is running (ReplayRoom plays app/data/replay.json through ui/replay.ts).
// Every value in a panel is read from the duel's records or the recording; a panel with nothing to show says so.
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { Sample } from "../lib/stage";
import { duelPath, verifyHref } from "./data";
import { bet, clock, near, nsMs, price8, type Side, shortModel, utcTime } from "./format";
import { Panel, Readout, Sparkline, Strip, Tag } from "./instruments";
import { Details, LinkButton } from "./kit";
import { answeredAt, checkCounts, frameAt, HOLD_MS, PLAY_MS, type ReplayRecord, timeline } from "./replay";
import { Headline } from "./result";
import type { PinMark, TraceIn } from "./trace";
import { PriceLine, TimeAxis, Trace, WhatHappened } from "./trace-view";
import { sentence, VERDICT } from "./verdict";

// ---------------------------------------------------------------- Stage

/** The central object: the price and both agents' Traces on one time axis. `head` is the strip of tags above it,
 *  `children` what sits under the axis (the transport, the headline, the verdict). */
export function Stage({
  head,
  a,
  b,
  names,
  tags,
  time,
  samples,
  stale,
  priceStale,
  onPin,
  titles,
  selected,
  children,
  stageRef,
  quiet,
}: {
  /** The calm first view: no price line and no legend (the caller folds both away with the instruments). */
  quiet?: boolean;
  head: ReactNode;
  a: TraceIn | null;
  b: TraceIn | null;
  /** The two model ids. */
  names: [string, string];
  /** What each agent is doing now, as a tag beside its name. */
  tags?: [ReactNode, ReactNode];
  time?: (ms: number) => string | null;
  samples: Sample[];
  stale?: boolean;
  priceStale?: boolean;
  onPin?: (id: string) => void;
  titles?: Record<string, string>;
  selected?: string | null;
  children?: ReactNode;
  stageRef?: RefObject<HTMLElement | null>;
}) {
  const row = (w: 0 | 1, input: TraceIn | null) => (
    <div className="stage-row">
      <p className="stage-who">
        <span className="tag ink">{w ? "B" : "A"}</span>
        <span className="mono" title={names[w]}>
          {shortModel(names[w])}
        </span>
        {tags?.[w]}
      </p>
      <Trace
        variant="stage"
        name={`${w ? "B" : "A"} ${names[w]}`}
        input={input}
        {...(time ? { time } : {})}
        {...(stale === undefined ? {} : { stale })}
        {...(onPin ? { onPin } : {})}
        {...(titles ? { titles } : {})}
        {...(selected === undefined ? {} : { selected })}
      />
    </div>
  );
  return (
    <section className="panel stage" aria-label="The Trace: what each AI has decided" ref={stageRef}>
      <div className="stage-head">{head}</div>
      {a && !quiet ? (
        <PriceLine samples={samples} from={a.from} to={a.to} {...(priceStale ? { stale: true } : {})} />
      ) : null}
      {row(0, a)}
      {row(1, b)}
      {a ? <TimeAxis input={a} {...(time ? { time } : {})} /> : null}
      {quiet ? null : <StageKey />}
      {children}
    </section>
  );
}

const StageKey = () => (
  <p className="stage-key" aria-hidden="true">
    <span>□ sealed decision, side hidden until opened</span>
    <span>● headline waiting</span>
    <span>○ held</span>
    <span className="signal">◆ fooled</span>
  </p>
);

/** What an agent is doing, as the tag beside its name. */
export const BetTag = ({ side, sealed }: { side: Side | null; sealed?: boolean }) =>
  side ? <Tag kind="ink">{`betting ${bet(side)}`}</Tag> : <Tag>{sealed ? "sealed" : "first bet coming"}</Tag>;

const PIN_TAG: Record<PinMark, [string, "live" | "alert" | "ink" | "idle"]> = {
  waiting: ["waiting", "live"],
  held: ["held", "ink"],
  fooled: ["fooled", "alert"],
  nocount: ["did not count", "live"],
  refunded: ["refunded", "live"],
  control: ["control", "idle"],
};
export const MarkTag = ({ mark, locked }: { mark: PinMark; locked?: boolean }) => (
  <Tag kind={PIN_TAG[mark][1]}>{mark === "waiting" && locked ? "locked in" : PIN_TAG[mark][0]}</Tag>
);

// ---------------------------------------------------------------- instrument panels

/** The price: the newest reading, the series so far, and the oracle's own open and close when the duel has them. */
export function PricePanel({
  price,
  samples,
  of,
  open,
  close,
  source,
  stale,
}: {
  price: number | null;
  samples: Sample[];
  /** How many samples the whole series has (a replay draws its share). */
  of?: number;
  open: string | null | undefined;
  close?: string | null | undefined;
  source: string;
  stale?: boolean;
}) {
  const o = price8(open);
  const c = price8(close);
  return (
    <Panel label="NEAR/USD" tag={stale ? <Tag kind="live">stale</Tag> : undefined}>
      <Readout value={price ? price.toFixed(4) : "—"} unit="USD" />
      {samples.length > 1 ? (
        <Sparkline
          values={samples.map((s) => s.p)}
          {...(of ? { of } : {})}
          label={`Price, ${samples.length} readings, from ${Math.min(...samples.map((s) => s.p)).toFixed(4)} to ${Math.max(...samples.map((s) => s.p)).toFixed(4)}`}
        />
      ) : null}
      <dl className="kv">
        <dt>Oracle open</dt>
        <dd>{o ? o.toFixed(4) : "—"}</dd>
        {close !== undefined ? (
          <>
            <dt>Oracle close</dt>
            <dd>{c ? c.toFixed(4) : "at the close"}</dd>
          </>
        ) : null}
      </dl>
      <p className="note">{source}</p>
    </Panel>
  );
}

/** The enclave checks of a finished duel, counted: passed, failed, and not checkable. Never rounded up. */
export function ChecksPanel({
  counts,
  href,
}: {
  counts: ReturnType<typeof checkCounts> | null;
  /** Opens the Verify drawer, which runs the same checks again from the chain. */
  href: string;
}) {
  return (
    <Panel
      label="Enclave signatures"
      tag={
        counts ? (
          counts.fail ? (
            <Tag kind="alert">{`${counts.fail} failed`}</Tag>
          ) : (
            <Tag kind="ok">verified</Tag>
          )
        ) : (
          <Tag>not checked yet</Tag>
        )
      }
    >
      {counts ? (
        <>
          <Readout value={counts.pass} unit={`checks passed, ${counts.fail} failed`} />
          <Strip
            n={counts.pass}
            of={counts.total}
            cells={counts.total}
            kind="ok"
            label={`${counts.pass} of ${counts.total} checks passed`}
          />
          <dl className="kv">
            <dt>On the decisions</dt>
            <dd>{`${counts.signed.pass} passed`}</dd>
            <dt>Failed</dt>
            <dd>{counts.fail}</dd>
            <dt>Not checkable here</dt>
            <dd>{counts.skip}</dd>
          </dl>
        </>
      ) : (
        <p className="note">
          Each decision is signed inside a secure enclave and the arena checks that signature before it accepts it. The
          full set of checks runs once the duel has finished.
        </p>
      )}
      <a className="btn-link" href={href}>
        {counts ? "Run the checks yourself" : "Open the checks"}
      </a>
    </Panel>
  );
}

// ---------------------------------------------------------------- the replay

/** Plays a recording: position `t` (ms of the recorded duel), looping with a hold on the finished picture. It moves
 *  only while the stage is on screen and the tab is visible; with reduced motion it stays on the finished picture
 *  until the visitor presses play or moves the scrubber. Before the page's script runs, `t` is the end: the whole
 *  record is on screen without it. */
export function useReplay(rec: ReplayRecord) {
  const [t, setT] = useState(rec.to);
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const at = useRef(rec.to);
  const seek = (ms: number) => {
    at.current = ms;
    setT(ms);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: start once, on mount
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    seek(rec.from);
    setPlaying(true);
  }, []);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let held = 0;
    let seen = true;
    const io = new IntersectionObserver(([e]) => {
      seen = !!e?.isIntersecting;
    });
    if (ref.current) io.observe(ref.current);
    const tick = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      if (seen && document.visibilityState === "visible") {
        if (at.current >= rec.to) {
          held += dt;
          if (held >= HOLD_MS) {
            held = 0;
            at.current = rec.from;
          }
        } else at.current = Math.min(rec.to, at.current + (dt * (rec.to - rec.from)) / PLAY_MS);
        setT(at.current);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [playing, rec]);
  return {
    t,
    playing,
    ref,
    toggle: () => {
      if (!playing && at.current >= rec.to) seek(rec.from);
      setPlaying(!playing);
    },
    scrub: (ms: number) => {
      setPlaying(false);
      seek(ms);
    },
    restart: () => {
      seek(rec.from);
      setPlaying(true);
      ref.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
    },
  };
}

const recordedOn = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The replay as a control room: the recorded duel's Traces moving in the centre, its agents on the left, its
 *  instruments on the right. `lead` sits above the transport (the page's own actions). */
export function ReplayRoom({
  rec,
  lead,
  quiet,
}: {
  /** The home page's calm first view: the Traces, one line of checks and the planted headlines; every instrument
   *  panel sits in one closed "Instruments" row under it. Nothing is removed. */
  quiet?: boolean;
  rec: ReplayRecord;
  lead?: (replay: { restart: () => void }) => ReactNode;
}) {
  const r = useReplay(rec);
  const f = frameAt(rec, r.t);
  const all = timeline(rec);
  const counts = checkCounts(rec);
  const span = rec.to - rec.from;
  const elapsed = (f.t - rec.from) / 1000;
  const won = (w: "a" | "b") =>
    rec.outcome.winner === null ? "tie" : rec.outcome.winner === rec[w].pk ? "won" : "lost";
  const agent = (w: "a" | "b") => {
    const pins = (w === "a" ? f.a : f.b).pins;
    return (
      <Panel
        label={`Agent ${w.toUpperCase()}`}
        tag={
          f.done ? (
            <Tag kind={won(w) === "lost" ? "idle" : "ink"}>{won(w)}</Tag>
          ) : (
            <BetTag side={f.bet[w]} sealed={f.sealed[w] > 0} />
          )
        }
      >
        <Readout small value={<span title={rec[w].model}>{shortModel(rec[w].model)}</span>} />
        <dl className="kv">
          <dt>Bet</dt>
          <dd>{f.bet[w] ? bet(f.bet[w]) : f.sealed[w] ? "sealed" : "—"}</dd>
          <dt>Decisions sealed</dt>
          <dd>{f.sealed[w]}</dd>
          <dt>Bond before the duel</dt>
          <dd>{rec[w].bond_before ? near(rec[w].bond_before) : "—"}</dd>
          <dt>Headlines at it</dt>
          <dd>
            {pins.length ? pins.map((p) => (p.mark === "waiting" ? "waiting" : PIN_TAG[p.mark][0])).join(", ") : "0"}
          </dd>
          {f.done ? (
            <>
              <dt>Result</dt>
              <dd>{`${(w === "a" ? rec.outcome.pnl_a : rec.outcome.pnl_b) / 100}%`}</dd>
            </>
          ) : null}
        </dl>
        <p className="note">{rec[w].tee ? "Runs in a secure enclave." : "Does not run in an enclave."}</p>
      </Panel>
    );
  };
  // quiet: the one tag an agent carries, its bet while the duel runs and how it ended once it has
  const tagOf = (w: "a" | "b") =>
    quiet && f.done ? (
      <Tag key={w} kind={won(w) === "lost" ? "idle" : "ink"}>
        {won(w)}
      </Tag>
    ) : (
      <BetTag key={w} side={f.bet[w]} sealed={f.sealed[w] > 0} />
    );
  const happened = (
    <WhatHappened
      items={[
        { name: `A ${rec.a.model}`, input: frameAt(rec, rec.to).a, time: (ms) => utcTime(ms).slice(0, 5) },
        { name: `B ${rec.b.model}`, input: frameAt(rec, rec.to).b, time: (ms) => utcTime(ms).slice(0, 5) },
      ]}
    />
  );
  const shown = rec.chaos.flatMap((c, i) => (c.kind !== "Placebo" && nsMs(c.at) <= f.t ? [{ c, i }] : []));
  const transport = (
    <div className="transport">
      <button type="button" className="btn btn-quiet" aria-label={r.playing ? "Pause" : "Play"} onClick={r.toggle}>
        {r.playing ? "❚❚ Pause" : "▶ Play"}
      </button>
      <input
        type="range"
        aria-label="Position in the duel"
        aria-valuetext={`${clock(elapsed)} of ${clock(span / 1000)}`}
        min={rec.from}
        max={rec.to}
        step={1000}
        value={Math.round(f.t)}
        onChange={(e) => r.scrub(Number(e.target.value))}
      />
      <span className="mono">{`${clock(elapsed)} / ${clock(span / 1000)}`}</span>
    </div>
  );
  const left = (
    <>
      {agent("a")}
      {agent("b")}
      <Panel label="Money in this duel" tag={<Tag>test NEAR</Tag>}>
        <dl className="kv">
          {rec.chaos.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a record's index is its identity on chain
            <div key={i} style={{ display: "contents" }}>
              <dt>{`Headline at ${c.target === rec.a.pk ? "A" : "B"} cost`}</dt>
              <dd>{near(c.stake)}</dd>
              {f.t >= answeredAt(rec, c) && c.outcome === "Flipped" ? (
                <>
                  <dt>Paid back to its planter</dt>
                  <dd>{near(c.payout)}</dd>
                </>
              ) : null}
            </div>
          ))}
          {f.done ? (
            <>
              <dt>Loser paid from its bond</dt>
              <dd>{near(rec.outcome.slashed)}</dd>
            </>
          ) : null}
        </dl>
        <p className="note">Both headlines were planted by the project.</p>
      </Panel>
      <Panel label="Recorded time" tag={<Tag kind={f.done ? "idle" : "live"}>{f.done ? "closed" : "playing"}</Tag>}>
        <Readout value={clock(elapsed)} unit={`of ${clock(span / 1000)}`} />
        <Strip
          n={Math.round(elapsed)}
          of={Math.round(span / 1000)}
          cells={30}
          label={`${clock(elapsed)} of ${clock(span / 1000)} played`}
        />
        <p className="note">{`Played at ${Math.round(span / PLAY_MS)}× speed.`}</p>
      </Panel>
    </>
  );
  const right = (
    <>
      <PricePanel
        price={f.price}
        samples={f.samples}
        of={rec.price.samples.length}
        open={rec.outcome.open_price}
        close={f.done ? rec.outcome.close_price : null}
        source={`Line: ${rec.price.source}. The duel settled on the oracle's prices.`}
      />
      <ChecksPanel counts={counts} href={verifyHref(rec.id, "main")} />
      <Panel label="Event log" tag={<Tag>{`${f.moments.length} of ${all.length}`}</Tag>}>
        <ol className="log">
          {all.map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the log is positional
            <li key={i} className={`${m.at <= f.t ? "" : "later"}${m.kind === "verdict" ? " v" : ""}`}>
              <span className="mono">{utcTime(m.at)}</span>
              <span>{m.text}</span>
            </li>
          ))}
        </ol>
      </Panel>
    </>
  );
  return (
    <div className={`room${quiet ? " quiet" : ""}`}>
      <Stage
        stageRef={r.ref}
        head={
          <>
            <span className="mono">{`duel #${rec.id}`}</span>
            {quiet ? null : <span className="dim">{recordedOn(rec.from)}</span>}
            <span className="mono end">{`${utcTime(f.t)} UTC`}</span>
          </>
        }
        a={f.a}
        b={f.b}
        names={[rec.a.model, rec.b.model]}
        tags={[tagOf("a"), tagOf("b")]}
        {...(quiet ? { quiet } : {})}
        time={(ms) => utcTime(ms).slice(0, 5)}
        samples={f.samples}
        titles={Object.fromEntries(rec.chaos.map((c, i) => [String(i), c.headline]))}
      >
        {quiet ? null : transport}
        {quiet ? (
          <p className="stage-checks">
            <Tag kind={counts.fail ? "alert" : "ok"}>{counts.fail ? `${counts.fail} failed` : "verified"}</Tag>
            <span className="mono">{`${counts.pass} checks passed, ${counts.fail} failed`}</span>
            <a href={verifyHref(rec.id, "main")}>Run the checks yourself</a>
          </p>
        ) : null}
        {lead && !quiet ? <div className="stage-lead">{lead({ restart: r.restart })}</div> : null}
        <div className="stage-planted">
          {shown.length ? (
            shown.map(({ c, i }) => {
              const w = c.target === rec.a.pk ? "a" : "b";
              const mark = (w === "a" ? f.a : f.b).pins.find((p) => p.id === String(i));
              const judged = mark && mark.mark !== "waiting" && c.outcome !== "Pending";
              return (
                <div key={i} className={`planted${judged && c.outcome === "Flipped" ? " fooled" : ""}`}>
                  <p className="planted-top">
                    <span className="t-label">
                      {quiet
                        ? `Planted at ${w.toUpperCase()}`
                        : `Planted at ${w.toUpperCase()} · ${utcTime(nsMs(c.at))}`}
                    </span>
                    {mark ? <MarkTag mark={mark.mark} locked={!!mark.locked} /> : null}
                  </p>
                  <Headline text={c.headline} />
                  {quiet && !judged ? null : (
                    <p className="note">
                      {judged && c.outcome !== "Pending"
                        ? `${VERDICT[c.outcome].word}. ${sentence(c, "public", shortModel(rec[w].model)) ?? ""}`
                        : mark?.locked
                          ? "Its next decision is locked in. The result follows when it is opened."
                          : `Waiting for ${shortModel(rec[w].model)}'s next decision.`}
                    </p>
                  )}
                </div>
              );
            })
          ) : (
            <p className="note">The first headline lands in a moment.</p>
          )}
        </div>
        {quiet ? transport : null}
        {lead && quiet ? <div className="stage-lead">{lead({ restart: r.restart })}</div> : null}
        {quiet ? null : (
          <details className="details">
            <summary>
              <span className="t-label">What happened, as text</span>
            </summary>
            <div className="details-body">{happened}</div>
          </details>
        )}
      </Stage>
      {quiet ? (
        <div className="panel instruments">
          <Details id="instruments" label="Instruments">
            <p className="note">{`${recordedOn(rec.from)} UTC.`}</p>
            <div className="deck c3">
              {left}
              {right}
            </div>
            <StageKey />
            {happened}
            <LinkButton variant="quiet" href={duelPath(rec.id, "main")}>
              Open the recorded duel
            </LinkButton>
          </Details>
        </div>
      ) : (
        <>
          <div className="room-col room-left">{left}</div>
          <div className="room-col room-right">{right}</div>
        </>
      )}
    </div>
  );
}

/** The two actions every page offers when nothing is live: play the recording here, or open the recorded duel. */
export function ReplayActions({ rec, restart }: { rec: ReplayRecord; restart: () => void }) {
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={restart}>
        Watch a real attack
      </button>
      <LinkButton variant="quiet" href={duelPath(rec.id, "main")}>
        Open the recorded duel
      </LinkButton>
    </>
  );
}
