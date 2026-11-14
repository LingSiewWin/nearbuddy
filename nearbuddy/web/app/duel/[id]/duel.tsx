"use client";
// One duel: the price and both agents' Traces on one time axis, what each AI decided and why, the planted headlines,
// and the attack box (a bottom sheet on phone, inline in the right column on desktop). Read from either arena
// (`?arena=keyless`); `?attack=a|b` opens the attack box with that target chosen.
import { useSearchParams } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";
import type { Chaos } from "../../lib/abi/arena";
import { NETWORK_ID } from "../../network";
import { livePnl } from "../../term/model";
import { AttackBox, attackGate } from "../../ui/attack";
import { type Mine, myHeadlines, rememberHeadline, useSite } from "../../ui/chrome";
import {
  agentPath,
  arenaOf,
  type DuelBody,
  endOf,
  type History,
  phaseOf,
  SYMBOL,
  sinceOpen,
  traceOf,
  useDuel,
  usePrice,
  verifyHref,
} from "../../ui/data";
import { bet, hm, near, nsMs, plural, price8, shortId } from "../../ui/format";
import { Amount, Button, Countdown, LinkButton, Region, Sheet, Skeleton, useMedia, useNow } from "../../ui/kit";
import { Collect, Headline, MachineQuote, ResultPanel, ShareSheet, VerdictWord, WaitPanel } from "../../ui/result";
import { markOf } from "../../ui/trace";
import { Pin, PriceLine, TimeAxis, Trace, WhatHappened } from "../../ui/trace-view";
import { coinFlip, sentence, VERDICT } from "../../ui/verdict";

type Which = "a" | "b";

/** One side of the duel: the model, its bet and since when, its own words, its enclave label and bond. */
function AgentPanel({
  which,
  body,
  h,
  word,
  pnl,
  arenaQuery,
}: {
  which: Which;
  body: DuelBody;
  h: History | null;
  /** "ahead" while running; "won", "lost" or "tie" once finished. */
  word: string | null;
  /** The final profit in bps, once finished. */
  pnl: number | null;
  arenaQuery: string;
}) {
  const d = body.duel;
  const agent = which === "a" ? body.a : body.b;
  if (!d || !agent) return null;
  const it = which === "a" ? d.last_intent_a : d.last_intent_b;
  const lastAt = h?.decisions.at(-1);
  const since = it && lastAt && lastAt.side === it.side ? ` since ${hm(lastAt.at)}` : "";
  return (
    <section className="sect stack-2" aria-label={`Agent ${which.toUpperCase()}`}>
      <div className="hrow">
        <h2 className="agent-name">
          {which.toUpperCase()} <span className="mono">{agent.model_id}</span>
        </h2>
        {word ? <span className={`end${word === "lost" ? " dim" : " ink"}`}>{word}</span> : null}
      </div>
      {it ? (
        <>
          <p>{`Betting ${bet(it.side)}${since}`}</p>
          <MachineQuote text={h?.reason ?? null} clamp />
        </>
      ) : (
        <p className="dim">No decision yet. The first one usually lands within a few minutes of the duel opening.</p>
      )}
      {h?.sealed ? <p className="t-small caution">A sealed decision is in and not opened yet.</p> : null}
      {pnl !== null ? <p className="mono">{`Final profit ${pnl >= 0 ? "+" : ""}${(pnl / 100).toFixed(2)}%`}</p> : null}
      {agent.tee ? (
        <p>
          <a className="proof" href={verifyHref(d.id, arenaOf(arenaQuery))}>
            Runs in a secure enclave
          </a>
        </p>
      ) : null}
      <p className="t-small">
        Bond <Amount yocto={agent.bond} /> · <a href={agentPath(agent.pk)}>Agent page →</a>
      </p>
    </section>
  );
}

/** One row of the planted-headlines list; expands to the full text, who planted it, the cost, the coin flip and the
 *  verdict sentence. A control headline (the arena's own baseline) gets no verdict word. */
function HeadlineRow({
  c,
  index,
  side,
  open,
  onToggle,
  tx,
  asWritten,
}: {
  c: Chaos;
  index: number;
  side: Which;
  open: boolean;
  onToggle: () => void;
  /** Its transaction, when it was planted from this browser. */
  tx: string | null;
  asWritten: boolean;
}) {
  const mark = markOf(c);
  const control = mark === "control";
  const changed = c.next && c.prev ? (c.next === c.prev ? "its bet did not change" : "its bet changed") : null;
  return (
    <li id={`headline-${index}`} className={`hl-row${open ? " open" : ""}`}>
      <button type="button" className="hl-toggle" aria-expanded={open} onClick={onToggle}>
        <svg width="16" height="16" aria-hidden="true">
          <Pin x={8} y={8} mark={mark} />
        </svg>
        <span className="hl-main">
          <Headline text={c.headline} as={open ? "block" : "line"} />
          <span className="t-small dim">
            {`at ${side.toUpperCase()} · ${hm(nsMs(c.at))} · `}
            {control ? (changed ?? "control") : null}
          </span>
          {control ? <span className="vtag dim">control</span> : <VerdictWord outcome={c.outcome} size="tag" />}
        </span>
      </button>
      {open ? (
        <div className="hl-more stack-2">
          {control ? (
            <p className="t-small dim">Planted by the arena as a baseline. Not an attack.</p>
          ) : (
            <>
              <p className="t-small">
                Planted by <span className="mono">{shortId(c.injector, 14, 8)}</span> · cost <Amount yocto={c.stake} />
              </p>
              <p className="t-small dim">
                {coinFlip(c.arm, c.outcome === "Pending" ? "will" : "saw", "public", asWritten)}
              </p>
              {c.outcome === "Pending" ? null : <p className="t-small">{sentence(c, "public")}</p>}
              {tx ? (
                <a className="btn-link" href={`/i/${tx}`}>
                  Open result
                </a>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

function Loaded({
  id,
  body,
  stale,
  staleAt,
  histories,
  now,
  refresh,
}: {
  id: string;
  body: DuelBody;
  stale: boolean;
  staleAt: number | null;
  histories: { a: History | null; b: History | null };
  now: number;
  refresh: () => void;
}) {
  const site = useSite();
  const sp = useSearchParams();
  const arena = arenaOf(sp.get("arena"));
  const desktop = useMedia("(min-width: 960px)");
  const wanted = sp.get("attack");
  const [target, setTarget] = useState<Which>(wanted === "b" ? "b" : "a");
  const [sheet, setSheet] = useState(false);
  const [locked, setLocked] = useState(false);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [mine, setMine] = useState<Mine[]>([]);
  const [share, setShare] = useState(false);
  const [fresh, setFresh] = useState(false);
  const seen = useRef<string | null>(null);
  const inline = useRef<HTMLDivElement>(null);
  const d = body.duel;
  const phase = d ? phaseOf(d, now) : "running";
  const price = usePrice(phase === "running" || phase === "closed", now);
  useEffect(() => setMine(myHeadlines()), []);
  // ?attack=a|b: the sheet on phone, focus moved to the inline box on desktop
  useEffect(() => {
    if (wanted !== "a" && wanted !== "b") return;
    if (desktop) inline.current?.querySelector<HTMLElement>("input, textarea")?.focus();
    else setSheet(true);
  }, [wanted, desktop]);
  const dropParam = () => {
    const u = new URL(location.href);
    if (!u.searchParams.has("attack")) return;
    u.searchParams.delete("attack");
    history.replaceState(null, "", u);
  };

  // the visitor's own newest headline in this duel, and its verdict arriving while they watch
  const records = d?.chaos ?? [];
  const myIndex = site.account ? records.findLastIndex((c) => c.injector === site.account && c.kind !== "Placebo") : -1;
  const my = myIndex >= 0 ? (records[myIndex] as Chaos) : null;
  const myTx = mine.find((m) => m.duel === id && m.arena === arena && (m.index === myIndex || m.index === null))?.tx;
  const myOutcome = my?.outcome ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: react to the outcome changing, nothing else
  useEffect(() => {
    if (!my || !myOutcome) return;
    if (seen.current === "Pending" && myOutcome !== "Pending") {
      setFresh(true);
      site.announce(`${VERDICT[myOutcome as keyof typeof VERDICT].word}. ${sentence(my, "attacker") ?? ""}`);
    }
    seen.current = myOutcome;
    document.title = `${myOutcome === "Pending" ? "Waiting" : VERDICT[myOutcome].word} · Duel #${id}`;
  }, [myOutcome]);

  if (!d)
    return (
      <div className="stack">
        <p>{`There is no duel #${id} on ${NETWORK_ID}.`}</p>
        <LinkButton variant="quiet" href="/arena">
          See all duels
        </LinkButton>
      </div>
    );

  const tA = traceOf(body, "a", histories.a ?? emptyHistory(d.close_at), now, staleAt);
  const tB = traceOf(body, "b", histories.b ?? emptyHistory(d.close_at), now, staleAt);
  const gate = attackGate(body, now);
  const o = phase === "finished" ? d.outcome : null;
  const open8 = o?.open_price ?? d.open_price;
  const shownPrice = o ? price8(o.close_price) : price.price;
  const move = sinceOpen(open8, shownPrice);
  const live = {
    a: livePnl(d.last_intent_a, price8(open8), price.price),
    b: livePnl(d.last_intent_b, price8(open8), price.price),
  };
  const word = (w: Which): string | null => {
    if (o) return o.winner === null ? "tie" : o.winner === (w === "a" ? d.a : d.b) ? "won" : "lost";
    if (phase !== "running" || live.a === null || live.b === null || live.a === live.b) return null;
    return (w === "a" ? live.a > live.b : live.b > live.a) ? "ahead" : null;
  };
  const attacks = records.filter((c) => c.kind !== "Placebo");
  const titles = Object.fromEntries(records.map((c, i) => [String(i), c.headline]));
  const sideOf = (c: Chaos): Which => (c.target === d.a ? "a" : "b");
  const asWritten = (w: Which) => body.keyless?.[w === "a" ? 0 : 1]?.template === 1;
  const showRow = (i: string) => {
    setOpenRow(Number(i));
    document.getElementById(`headline-${i}`)?.scrollIntoView({ block: "center" });
  };
  const planted = (m: Mine | null) => {
    if (m) {
      rememberHeadline(m);
      setMine(myHeadlines());
    }
    setSheet(false);
    dropParam();
    refresh();
  };
  const box = (
    <AttackBox
      body={body}
      arena={arena}
      histories={histories}
      now={now}
      target={target}
      onTarget={setTarget}
      onPlanted={planted}
      onLock={setLocked}
      refresh={refresh}
    />
  );
  const myTrace = my
    ? traceOf(
        body,
        sideOf(my),
        (sideOf(my) === "a" ? histories.a : histories.b) ?? emptyHistory(d.close_at),
        now,
        staleAt,
      )
    : null;
  const myWaiting = my?.outcome === "Pending";
  const verify = (
    <a className="proof" href={verifyHref(id, arena)}>
      Verify this duel
    </a>
  );

  return (
    <>
      <div className="duel-top">
        <div className="hrow">
          <span className="t-num">
            <span className="t-label">{SYMBOL(d.symbol)}</span> {shownPrice ? shownPrice.toFixed(4) : "—"}
          </span>
          <span className="end">
            {phase === "running" ? (
              <>
                ends in <Countdown to={nsMs(d.close_at)} now={now} stale={stale} />
              </>
            ) : phase === "closed" ? (
              <span className="caution">Closed. Waiting for the final price.</span>
            ) : phase === "finished" ? (
              `Finished ${hm(nsMs(d.close_at))}`
            ) : null}
          </span>
        </div>
        {move ? <p className="mono t-small">{`${move} since open`}</p> : null}
        {phase === "cancelled" ? (
          <p className="caution">Cancelled. The final price never arrived, so nobody won this duel.</p>
        ) : null}
      </div>

      <div className="duel-grid">
        <section className="duel-chart" aria-label="Decisions over time">
          {phase === "running" || price.samples.some((x) => x.t <= nsMs(d.close_at)) ? (
            <PriceLine samples={price.samples} from={nsMs(d.open_at)} to={nsMs(d.close_at)} stale={price.stale} />
          ) : null}
          <Trace
            variant="full"
            name={`A ${body.a?.model_id ?? ""}`}
            input={tA}
            stale={stale}
            onPin={showRow}
            titles={titles}
            selected={openRow === null ? null : String(openRow)}
          />
          <Trace
            variant="full"
            name={`B ${body.b?.model_id ?? ""}`}
            input={tB}
            stale={stale}
            onPin={showRow}
            titles={titles}
            selected={openRow === null ? null : String(openRow)}
          />
          {tA ? <TimeAxis input={tA} /> : null}
          {tA && tB ? (
            <WhatHappened
              items={[
                { name: `A ${body.a?.model_id ?? ""}`, input: tA },
                { name: `B ${body.b?.model_id ?? ""}`, input: tB },
              ]}
            />
          ) : null}
        </section>

        {my && myTrace ? (
          <section className="duel-yours boxed" aria-label="Your headline">
            {myWaiting ? (
              <WaitPanel
                c={my}
                model={(sideOf(my) === "a" ? body.a : body.b)?.model_id ?? "the AI"}
                viewer="attacker"
                asWritten={asWritten(sideOf(my))}
                trace={{ ...myTrace, pins: myTrace.pins.filter((p) => p.id === String(myIndex)) }}
                locked={body.open?.[String(myIndex)]?.open === false}
                decisionTimes={((sideOf(my) === "a" ? histories.a : histories.b)?.decisions ?? []).map((x) => x.at)}
                closeMs={nsMs(d.close_at)}
                now={now}
                link={myTx ? `/i/${myTx}` : null}
                plantedMs={nsMs(my.at)}
              />
            ) : (
              <ResultPanel
                c={my}
                model={(sideOf(my) === "a" ? body.a : body.b)?.model_id ?? "the AI"}
                viewer="attacker"
                asWritten={asWritten(sideOf(my))}
                end={endOf(d, my.target, now)}
                feeBps={body.config.chaos?.fee_bps ?? 0}
                reason={
                  (sideOf(my) === "a" ? histories.a : histories.b)?.said.find((s) => s.at > nsMs(my.at))?.text ?? null
                }
                trace={{ ...myTrace, pins: myTrace.pins.filter((p) => p.id === String(myIndex)) }}
                fresh={fresh}
                actions={
                  <>
                    <Collect
                      records={records}
                      account={site.account}
                      contract={body.contract}
                      duelId={id}
                      finished={phase === "finished" || phase === "cancelled"}
                      onDone={refresh}
                    />
                    {myTx ? (
                      <Button variant="quiet" onClick={() => setShare(true)}>
                        Share
                      </Button>
                    ) : null}
                  </>
                }
                links={
                  <>
                    <a className="proof" href={verifyHref(id, arena)}>
                      Verify this result
                    </a>
                    {gate ? null : (
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() =>
                          desktop ? inline.current?.querySelector<HTMLElement>("textarea")?.focus() : setSheet(true)
                        }
                      >
                        Plant another
                      </button>
                    )}
                  </>
                }
              />
            )}
            {myTx ? (
              <ShareSheet
                open={share}
                onClose={() => setShare(false)}
                tx={myTx}
                model={(sideOf(my) === "a" ? body.a : body.b)?.model_id ?? "an AI"}
                outcome={my.outcome}
              />
            ) : null}
          </section>
        ) : null}

        <div className="duel-side">
          <div className="duel-agents">
            <AgentPanel
              which="a"
              body={body}
              h={histories.a}
              word={word("a")}
              pnl={o ? o.pnl_a : null}
              arenaQuery={arena}
            />
            <AgentPanel
              which="b"
              body={body}
              h={histories.b}
              word={word("b")}
              pnl={o ? o.pnl_b : null}
              arenaQuery={arena}
            />
          </div>
          {desktop && phase === "running" ? (
            <section className="sect duel-attack" ref={inline} aria-label="Plant a fake headline">
              {box}
            </section>
          ) : null}
          <p className="sect duel-verify">{verify}</p>
        </div>

        <section className="sect duel-headlines stack-2">
          <h2 className="t-label">{`Planted headlines (${attacks.length})`}</h2>
          {records.length ? (
            <ul>
              {records.map((c, i) => (
                <HeadlineRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: a record's index is its identity on chain
                  key={i}
                  c={c}
                  index={i}
                  side={sideOf(c)}
                  open={openRow === i}
                  onToggle={() => setOpenRow(openRow === i ? null : i)}
                  tx={mine.find((m) => m.duel === id && m.arena === arena && m.index === i)?.tx ?? null}
                  asWritten={asWritten(sideOf(c))}
                />
              ))}
            </ul>
          ) : (
            <p className="dim">Nobody has planted a headline in this duel.</p>
          )}
        </section>
      </div>

      {desktop ? null : phase === "running" && !myWaiting ? (
        <div className="sticky-bar">
          <Button variant="attack" disabled={!!gate} why={gate?.why} onClick={() => setSheet(true)}>
            {gate?.label || "Plant a fake headline"}
          </Button>
        </div>
      ) : phase === "finished" || phase === "cancelled" ? (
        <div className="sticky-bar two">
          <LinkButton variant="proof" href={verifyHref(id, arena)}>
            Verify this duel
          </LinkButton>
          <LinkButton variant="quiet" href="/arena">
            See a running duel
          </LinkButton>
        </div>
      ) : null}
      {desktop ? null : (
        <Sheet
          open={sheet}
          kind="tall"
          locked={locked}
          title="Plant a fake headline"
          onClose={() => {
            setSheet(false);
            dropParam();
          }}
        >
          {box}
        </Sheet>
      )}
      <p className="sr">{`${plural(attacks.length, "planted headline")} in this duel. Cost of the next one: ${d.chaos_fee ? near(d.chaos_fee) : "not read yet"}.`}</p>
    </>
  );
}

const emptyHistory = (closeAt: string): History => ({
  decisions: [],
  loadedFrom: nsMs(closeAt),
  current: null,
  reason: null,
  said: [],
  sealed: false,
});

export function DuelView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const sp = useSearchParams();
  const arena = arenaOf(sp.get("arena"));
  const site = useSite();
  const now = useNow();
  const [fast, setFast] = useState(false);
  const { read, a, b } = useDuel(id, arena, fast);
  // while one of the visitor's attacks is waiting, the duel is read every 3 s
  const waiting =
    !!site.account && !!read.data?.duel?.chaos?.some((c) => c.injector === site.account && c.outcome === "Pending");
  useEffect(() => setFast(waiting), [waiting]);
  return (
    <div className="page duel">
      <div className="hrow duel-head">
        <a href="/arena">← Duels</a>
        <h1 className="t-title end">{`Duel #${id}`}</h1>
      </div>
      <Region
        read={read}
        skeleton={
          <div className="stack">
            <Trace variant="full" name="A" input={null} />
            <Trace variant="full" name="B" input={null} />
            <Skeleton bars={["60%", "90%", "40%"]} />
          </div>
        }
      >
        {(body, stale) => (
          <Loaded
            id={id}
            body={body}
            stale={stale}
            staleAt={stale && now ? now - read.age * 1000 : null}
            histories={{ a, b }}
            now={now}
            refresh={read.retry}
          />
        )}
      </Region>
    </div>
  );
}
