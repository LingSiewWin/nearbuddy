"use client";
// One duel, organised as one question: what are these two AIs doing, and which one do I lie to? First view: one
// sentence, the two AIs with a line of reasoning and a button each, and both Traces. Everything an analyst wants
// (price, full reasoning, every planted headline, money) is in disclosure rows under it. Read from either arena
// (`?arena=keyless`); `?attack=a|b` opens the attack box with that target chosen: a bottom sheet on phone, a panel
// beside the Traces on desktop.
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
import { bet, hm, near, nsMs, price8, shortId } from "../../ui/format";
import {
  Amount,
  Button,
  Countdown,
  Details,
  LinkButton,
  Region,
  Sheet,
  Skeleton,
  useMedia,
  useNow,
} from "../../ui/kit";
import { Collect, Headline, MachineQuote, ResultPanel, ShareSheet, VerdictWord, WaitPanel } from "../../ui/result";
import { markOf } from "../../ui/trace";
import { Pin, PriceLine, TimeAxis, Trace, WhatHappened } from "../../ui/trace-view";
import { coinFlip, sentence, VERDICT } from "../../ui/verdict";

type Which = "a" | "b";

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
  const [attack, setAttack] = useState(wanted === "a" || wanted === "b");
  const [locked, setLocked] = useState(false);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [mine, setMine] = useState<Mine[]>([]);
  const [share, setShare] = useState(false);
  const [fresh, setFresh] = useState(false);
  const seen = useRef<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const d = body.duel;
  const phase = d ? phaseOf(d, now) : "running";
  const price = usePrice(phase === "running" || phase === "closed", now);
  useEffect(() => setMine(myHeadlines()), []);
  // desktop: the attack box is a panel beside the Traces, and opening it moves focus there
  useEffect(() => {
    if (attack && desktop) panel.current?.querySelector<HTMLElement>("textarea")?.focus();
  }, [attack, desktop]);
  const close = () => {
    setAttack(false);
    const u = new URL(location.href);
    if (!u.searchParams.has("attack")) return;
    u.searchParams.delete("attack"); // closing removes the parameter
    history.replaceState(null, "", u);
  };
  const lie = (w: Which) => {
    setTarget(w);
    setAttack(true);
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

  const hist = (w: Which) => (w === "a" ? histories.a : histories.b) ?? emptyHistory(d.close_at);
  const agent = (w: Which) => (w === "a" ? body.a : body.b);
  const intent = (w: Which) => (w === "a" ? d.last_intent_a : d.last_intent_b);
  const model = (w: Which) => agent(w)?.model_id ?? "?";
  const tA = traceOf(body, "a", hist("a"), now, staleAt);
  const tB = traceOf(body, "b", hist("b"), now, staleAt);
  const gate = attackGate(body, now);
  const o = phase === "finished" ? d.outcome : null;
  const open8 = o?.open_price ?? d.open_price;
  const shownPrice = o ? price8(o.close_price) : price.price;
  const move = sinceOpen(open8, shownPrice);
  const pnl = (w: Which) => (o ? (w === "a" ? o.pnl_a : o.pnl_b) : livePnl(intent(w), price8(open8), price.price));
  const ended = (w: Which): string | null =>
    o ? (o.winner === null ? "tie" : o.winner === (w === "a" ? d.a : d.b) ? "won" : "lost") : null;
  const [pa, pb] = [pnl("a"), pnl("b")];
  const ahead: Which | null =
    !o && phase === "running" && pa !== null && pb !== null && pa !== pb ? (pa > pb ? "a" : "b") : null;
  const pct = (bps: number) => `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;
  const attacks = records.filter((c) => c.kind !== "Placebo");
  const titles = Object.fromEntries(records.map((c, i) => [String(i), c.headline]));
  const sideOf = (c: Chaos): Which => (c.target === d.a ? "a" : "b");
  const asWritten = (w: Which) => body.keyless?.[w === "a" ? 0 : 1]?.template === 1;
  const showRow = (i: string) => {
    setOpenRow(Number(i));
    // the row sits in a disclosure that opens with it: scroll once it is laid out
    setTimeout(() => document.getElementById(`headline-${i}`)?.scrollIntoView({ block: "center" }), 0);
  };
  const planted = (m: Mine | null) => {
    if (m) {
      rememberHeadline(m);
      setMine(myHeadlines());
    }
    close();
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
  const mySide = my ? sideOf(my) : "a";
  const myTrace = my ? traceOf(body, mySide, hist(mySide), now, staleAt) : null;
  const myWaiting = my?.outcome === "Pending";
  const enclave = (w: Which) =>
    agent(w)?.tee ? (
      <a className="proof" href={verifyHref(id, arena)}>
        Runs in a secure enclave
      </a>
    ) : null;
  const newest = attacks.at(-1);
  // no decision from either AI is the one gate said per AI, not once under both
  const caption = gate?.label
    ? gate.label === "Too late for this duel"
      ? `${gate.label}. ${gate.why}`
      : gate.why
    : null;
  const waitsForDecision = !!gate && !d.last_intent_a && !d.last_intent_b;

  return (
    <>
      <div className="stack-2 duel-top">
        {phase === "running" ? (
          <p>
            Two AIs are betting on the NEAR price. <Countdown to={nsMs(d.close_at)} now={now} stale={stale} /> left.
          </p>
        ) : phase === "closed" ? (
          <p className="caution">Closed. Waiting for the final price.</p>
        ) : phase === "finished" ? (
          <>
            <p className="dim">{`Finished ${hm(nsMs(d.close_at))}`}</p>
            <p>{o?.winner ? `${model(o.winner === d.a ? "a" : "b")} won this duel.` : "This duel was a tie."}</p>
          </>
        ) : (
          <p className="caution">Cancelled. The final price never arrived, so nobody won this duel.</p>
        )}
      </div>

      {my && myTrace ? (
        <section className="boxed duel-yours" aria-label="Your headline">
          {myWaiting ? (
            <WaitPanel
              c={my}
              model={model(mySide)}
              viewer="attacker"
              asWritten={asWritten(mySide)}
              trace={{ ...myTrace, pins: myTrace.pins.filter((p) => p.id === String(myIndex)) }}
              locked={body.open?.[String(myIndex)]?.open === false}
              decisionTimes={hist(mySide).decisions.map((x) => x.at)}
              closeMs={nsMs(d.close_at)}
              now={now}
              link={myTx ? `/i/${myTx}` : null}
              plantedMs={nsMs(my.at)}
            />
          ) : (
            <ResultPanel
              c={my}
              model={model(mySide)}
              viewer="attacker"
              asWritten={asWritten(mySide)}
              end={endOf(d, my.target, now)}
              feeBps={body.config.chaos?.fee_bps ?? 0}
              reason={hist(mySide).said.find((x) => x.at > nsMs(my.at))?.text ?? null}
              plantedMs={nsMs(my.at)}
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
                <a className="proof" href={verifyHref(id, arena)}>
                  Verify this result
                </a>
              }
            />
          )}
          {gate ? null : (
            <button type="button" className="btn-link" onClick={() => lie(mySide)}>
              Plant another
            </button>
          )}
          {myTx ? (
            <ShareSheet
              open={share}
              onClose={() => setShare(false)}
              tx={myTx}
              model={model(mySide)}
              outcome={my.outcome}
            />
          ) : null}
        </section>
      ) : null}

      <div className="picks duel-picks">
        {(["a", "b"] as const).map((w) => {
          const it = intent(w);
          const end = ended(w);
          return (
            <section className="pick" key={w} aria-label={`Agent ${w.toUpperCase()}`}>
              <div className="hrow">
                <h2 className="who">{model(w)}</h2>
                {end ? <span className={`end ${end === "lost" ? "dim" : "ink"}`}>{end}</span> : null}
              </div>
              {it ? (
                <>
                  <p>
                    Betting the price goes <span className="ink">{bet(it.side)}</span>
                  </p>
                  <MachineQuote text={hist(w).reason} />
                </>
              ) : (
                <p className="dim">
                  No decision yet. The first one usually lands within a few minutes of the duel opening.
                </p>
              )}
              {phase !== "running" || my ? null : (
                <Button
                  variant="attack"
                  disabled={!!gate || !it}
                  why={
                    !it || waitsForDecision
                      ? "Wait for its first decision. An attack needs a position to push against."
                      : null
                  }
                  onClick={() => lie(w)}
                >
                  Lie to this one
                </Button>
              )}
            </section>
          );
        })}
      </div>
      {phase === "running" && !my && caption && !waitsForDecision ? <p className="t-small caution">{caption}</p> : null}

      <div className={`duel-work${attack && desktop && phase === "running" ? " with-attack" : ""}`}>
        <section className="sect stack-2" aria-label="What they have done so far">
          <h2 className="t-label">What they have done so far</h2>
          <Trace
            variant="full"
            name={`A ${model("a")}`}
            input={tA}
            stale={stale}
            onPin={showRow}
            titles={titles}
            selected={openRow === null ? null : String(openRow)}
          />
          <Trace
            variant="full"
            name={`B ${model("b")}`}
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
                { name: `A ${model("a")}`, input: tA },
                { name: `B ${model("b")}`, input: tB },
              ]}
            />
          ) : null}
          {phase === "finished" || phase === "cancelled" ? (
            <div className="actions">
              <LinkButton variant="proof" href={verifyHref(id, arena)}>
                Verify this duel
              </LinkButton>
              <LinkButton variant="quiet" href="/arena">
                See a running duel
              </LinkButton>
            </div>
          ) : null}
        </section>
        {attack && desktop && phase === "running" ? (
          <section className="boxed attack-panel" ref={panel} aria-label="Plant a fake headline">
            <div className="hrow">
              <h2 className="t-title">Plant a fake headline</h2>
              <button type="button" className="btn-link end" aria-label="Close" disabled={locked} onClick={close}>
                ✕
              </button>
            </div>
            {box}
          </section>
        ) : null}
      </div>

      <section className="duel-details" aria-label="Details">
        <h2 className="t-label">Details</h2>
        <div className="details-grid">
          <Details
            id="duel-price"
            label="Price"
            summary={shownPrice ? `${shownPrice.toFixed(4)}${move ? `, ${move} since open` : ""}` : "—"}
          >
            <PriceLine samples={price.samples} from={nsMs(d.open_at)} to={nsMs(d.close_at)} stale={price.stale} />
            <p>
              <span className="t-label">{SYMBOL(d.symbol)}</span>{" "}
              <span className="t-num">{shownPrice ? shownPrice.toFixed(4) : "—"}</span>
            </p>
            <p className="t-small dim">
              Open price <span className="mono">{price8(open8)?.toFixed(4) ?? "—"}</span>
            </p>
          </Details>
          <Details id="duel-reasoning" label="Their full reasoning">
            {(["a", "b"] as const).map((w) => {
              const h = hist(w);
              const at = h.decisions.at(-1)?.at;
              return (
                <div className="stack-2" key={w}>
                  <p className="who mono">{model(w)}</p>
                  {intent(w) ? <MachineQuote text={h.reason} /> : <p className="dim">No decision yet.</p>}
                  {at ? <p className="t-small dim">{`Decided ${hm(at)}`}</p> : null}
                  {h.sealed ? <p className="t-small caution">A sealed decision is in and not opened yet.</p> : null}
                  {enclave(w)}
                </div>
              );
            })}
          </Details>
          <Details
            id="duel-headlines"
            label={`Planted headlines (${attacks.length})`}
            summary={newest ? <span className="serif-sum">{`“${newest.headline}”`}</span> : undefined}
            open={openRow !== null || !!my}
          >
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
          </Details>
          <Details id="duel-money" label="Money" summary="bonds and costs">
            <dl className="facts">
              {(["a", "b"] as const).map((w) => (
                <div key={w} style={{ display: "contents" }}>
                  <dt>{`Bond ${w.toUpperCase()}`}</dt>
                  <dd>
                    <Amount yocto={agent(w)?.bond ?? null} />{" "}
                    {ahead === w && pa !== null && pb !== null ? (
                      <span className="ink">{`ahead by ${(Math.abs(pa - pb) / 100).toFixed(2)}%`}</span>
                    ) : null}
                    {o ? <span className="mono">{` final profit ${pct(w === "a" ? o.pnl_a : o.pnl_b)}`}</span> : null}{" "}
                    <a href={agentPath(agent(w)?.pk ?? "")}>Agent page →</a>
                  </dd>
                </div>
              ))}
              {phase === "running" ? (
                <>
                  <dt>Next attack</dt>
                  <dd>{d.chaos_fee ? near(d.chaos_fee) : "—"}</dd>
                </>
              ) : null}
            </dl>
            <p className="t-small dim">A bond is money the agent's owner locked as a promise.</p>
          </Details>
        </div>
      </section>
      <p className="sect">
        <a className="proof" href={verifyHref(id, arena)}>
          Verify this duel
        </a>
      </p>

      {desktop ? null : (
        <Sheet
          open={attack && phase === "running"}
          kind="tall"
          locked={locked}
          title="Plant a fake headline"
          onClose={close}
        >
          {box}
        </Sheet>
      )}
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
        <a href="/arena">← All duels</a>
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
