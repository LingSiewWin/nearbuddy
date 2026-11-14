"use client";
// One duel, organised as one question: what are these two AIs doing, and which one do I lie to? First view: one
// sentence, the two AIs with a line of reasoning and a button each, and both Traces. Everything an analyst wants
// (price, full reasoning, every planted headline, money) is in disclosure rows under it. Read from either arena
// (`?arena=keyless`); `?attack=a|b` opens the attack box with that target chosen: a bottom sheet on phone, a panel
// beside the Traces on desktop.
import { useSearchParams } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";
import type { ChainEvent } from "../../cells";
import type { Chaos } from "../../lib/abi/arena";
import type { Sample } from "../../lib/stage";
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
  mainHistory,
  phaseOf,
  sinceOpen,
  traceOf,
  useDuel,
  usePrice,
  verifyHref,
} from "../../ui/data";
import { bet, hm, near, nsMs, price8, shortId, shortModel, TEST_NOTE } from "../../ui/format";
import { Panel, Readout, Strip, Tag } from "../../ui/instruments";
import {
  Amount,
  Button,
  Countdown,
  LinkButton,
  Region,
  Sheet,
  Skeleton,
  useMedia,
  useNow,
  useRead,
} from "../../ui/kit";
import { countChecks, RECORDED } from "../../ui/replay";
import { Collect, Headline, MachineQuote, ResultPanel, ShareSheet, VerdictWord, WaitPanel } from "../../ui/result";
import { BetTag, ChecksPanel, MarkTag, PricePanel, Stage } from "../../ui/room";
import { markOf } from "../../ui/trace";
import { Pin, Trace, WhatHappened } from "../../ui/trace-view";
import { coinFlip, pickLive, sentence, VERDICT } from "../../ui/verdict";

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
  const done = phase === "finished" || phase === "cancelled";
  // a finished duel: the same checks as the Verify drawer (kept by the server once run), which also carry the duel's
  // sealed and opened decisions however old it is; and the exchange's candles for its price line
  const checks = useRead<{ status: string; lines?: { result: string; check: string }[]; events?: ChainEvent[] }>(
    done && d && arena === "main" ? `/api/verify?duel=${id}` : null,
    300_000,
    0,
  );
  const candles = useRead<{ source: string; samples: Sample[] }>(
    done && d ? `/api/candles?from=${nsMs(d.open_at)}&to=${nsMs(d.close_at)}` : null,
    600_000,
    0,
  );
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

  const recorded = checks.data?.events;
  const hist = (w: Which) =>
    recorded
      ? mainHistory(w === "a" ? d.a : d.b, d, { oldest_ms: nsMs(d.open_at), partial: false, events: recorded })
      : ((w === "a" ? histories.a : histories.b) ?? emptyHistory(d.close_at));
  const liveRow = now ? pickLive(site.list.data?.duels ?? [], now, (r) => site.list.data?.lock_s[r.arena] ?? 0) : null;
  const samples = done ? (candles.data?.samples ?? []) : price.samples;
  const counts = checks.data?.lines ? countChecks(checks.data.lines) : null;
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
  // no decision from either AI is the one gate said per AI, not once under both
  const caption = gate?.label
    ? gate.label === "Too late for this duel"
      ? `${gate.label}. ${gate.why}`
      : gate.why
    : null;
  const waitsForDecision = !!gate && !d.last_intent_a && !d.last_intent_b;

  const state =
    phase === "running" ? (
      <Tag kind="ok">live</Tag>
    ) : phase === "closed" ? (
      <Tag kind="live">closed · waiting for the final price</Tag>
    ) : phase === "finished" ? (
      <Tag kind="ink">finished</Tag>
    ) : (
      <Tag kind="live">cancelled</Tag>
    );
  const count = (...which: Chaos["outcome"][]) => attacks.filter((c) => which.includes(c.outcome)).length;
  const agentPanel = (w: Which) => {
    const it = intent(w);
    const end = ended(w);
    const h = hist(w);
    const lastAt = h.decisions.at(-1)?.at;
    return (
      <Panel
        key={w}
        label={`Agent ${w.toUpperCase()}`}
        tag={
          end ? (
            <Tag kind={end === "lost" ? "idle" : "ink"}>{end}</Tag>
          ) : (
            <BetTag side={it?.side ?? null} sealed={h.sealed} />
          )
        }
      >
        <Readout
          small
          value={
            <a href={agentPath(agent(w)?.pk ?? "")} title={model(w)}>
              {shortModel(model(w))}
            </a>
          }
        />
        <dl className="kv">
          <dt>Bet</dt>
          <dd>{it ? bet(it.side) : "—"}</dd>
          <dt>Bond</dt>
          <dd>
            <Amount yocto={agent(w)?.bond ?? null} />
          </dd>
          {o ? (
            <>
              <dt>Final profit</dt>
              <dd>{pct(w === "a" ? o.pnl_a : o.pnl_b)}</dd>
            </>
          ) : ahead === w && pa !== null && pb !== null ? (
            <>
              <dt>Ahead by</dt>
              <dd>{`${(Math.abs(pa - pb) / 100).toFixed(2)}%`}</dd>
            </>
          ) : null}
          {lastAt ? (
            <>
              <dt>Last decision opened</dt>
              <dd>{hm(lastAt)}</dd>
            </>
          ) : null}
        </dl>
        {h.reason ? <MachineQuote text={h.reason} clamp /> : null}
        {!it && phase === "running" ? (
          <p className="note">No decision yet. The first one usually lands within a few minutes of the duel opening.</p>
        ) : null}
        {h.sealed && phase === "running" ? (
          <p className="note caution">A sealed decision is in and not opened yet.</p>
        ) : null}
        {enclave(w)}
        {phase !== "running" || my ? null : (
          <Button
            variant="attack"
            disabled={!!gate || !it}
            why={
              !it || waitsForDecision
                ? "Wait for its first decision. An attack needs a position to push against."
                : gate
                  ? caption
                  : null
            }
            onClick={() => lie(w)}
          >
            Lie to this one
          </Button>
        )}
      </Panel>
    );
  };

  return (
    <>
      <header className="page-head">
        <h1 className="t-display">{`Duel #${id}`}</h1>
        {state}
        <p className="lede">
          {phase === "running" ? (
            <>
              Two AIs are betting on the NEAR price. <Countdown to={nsMs(d.close_at)} now={now} stale={stale} /> left.
            </>
          ) : phase === "closed" ? (
            "Time is up. The duel is waiting for the oracle's final price, so nothing can be planted here any more."
          ) : phase === "finished" ? (
            `${o?.winner ? `${shortModel(model(o.winner === d.a ? "a" : "b"))} won this duel.` : "This duel was a tie."} Finished ${hm(nsMs(d.close_at))}.`
          ) : (
            "Cancelled. The final price never arrived, so nobody won this duel."
          )}
        </p>
      </header>

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
                    finished={done}
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

      <div className="room">
        <Stage
          head={
            <>
              {state}
              <span className="mono">{`duel #${id}`}</span>
              <span className="dim">{`${hm(nsMs(d.open_at))} to ${hm(nsMs(d.close_at))}, your local time`}</span>
              {phase === "running" ? (
                <span className="end">
                  ends in <Countdown to={nsMs(d.close_at)} now={now} stale={stale} />
                </span>
              ) : null}
            </>
          }
          a={tA}
          b={tB}
          names={[model("a"), model("b")]}
          tags={[
            <BetTag key="a" side={intent("a")?.side ?? null} sealed={hist("a").sealed} />,
            <BetTag key="b" side={intent("b")?.side ?? null} sealed={hist("b").sealed} />,
          ]}
          samples={samples}
          stale={stale}
          priceStale={price.stale}
          onPin={showRow}
          titles={titles}
          selected={openRow === null ? null : String(openRow)}
        >
          {done && checks.loading ? (
            <p className="note caution">
              Reading this duel's recorded decisions from the chain. This can take a few seconds.
            </p>
          ) : null}
          <div className="stage-planted" id="planted">
            {attacks.length ? (
              records.map((c, i) => {
                if (c.kind === "Placebo") return null;
                const w = sideOf(c);
                const tx = mine.find((m) => m.duel === id && m.arena === arena && m.index === i)?.tx ?? null;
                return (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: a record's index is its identity on chain
                    key={i}
                    id={`headline-${i}`}
                    className={`planted${c.outcome === "Flipped" ? " fooled" : ""}${openRow === i ? " picked" : ""}`}
                  >
                    <p className="planted-top">
                      <span className="t-label">{`Planted at ${w.toUpperCase()} · ${hm(nsMs(c.at))}`}</span>
                      <MarkTag mark={markOf(c)} locked={body.open?.[String(i)]?.open === false} />
                    </p>
                    <Headline text={c.headline} />
                    <p className="note">
                      {c.outcome === "Pending"
                        ? `Waiting for ${shortModel(model(w))}'s next decision.`
                        : sentence(c, "public", shortModel(model(w)))}
                    </p>
                    <p className="note">
                      Planted by <span className="mono">{shortId(c.injector, 14, 8)}</span> · cost{" "}
                      <Amount yocto={c.stake} />
                      {" · "}
                      {coinFlip(c.arm, c.outcome === "Pending" ? "will" : "saw", "public", asWritten(w))}
                    </p>
                    {tx ? (
                      <a className="btn-link" href={`/i/${tx}`}>
                        Open its result page
                      </a>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <p className="note">
                {phase === "running"
                  ? "Nobody has planted a headline in this duel yet. Pick an AI and lie to it."
                  : "Nobody planted a headline in this duel, so there is no FOOLED or HELD to show."}
              </p>
            )}
          </div>
          {records.some((c) => c.kind === "Placebo") ? (
            <ul className="controls-list">
              {records.map((c, i) =>
                c.kind === "Placebo" ? (
                  <HeadlineRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: a record's index is its identity on chain
                    key={i}
                    c={c}
                    index={i}
                    side={sideOf(c)}
                    open={openRow === i}
                    onToggle={() => setOpenRow(openRow === i ? null : i)}
                    tx={null}
                    asWritten={asWritten(sideOf(c))}
                  />
                ) : null,
              )}
            </ul>
          ) : null}
          <div className="stage-lead">
            {phase === "running" ? null : liveRow ? (
              <LinkButton
                variant="primary"
                href={`/duel/${liveRow.id}${liveRow.arena === "keyless" ? "?arena=keyless" : ""}`}
              >
                See the running duel
              </LinkButton>
            ) : (
              <>
                <LinkButton variant="primary" href="/">
                  Watch a real attack
                </LinkButton>
                {id === RECORDED.id && arena === "main" ? null : (
                  <LinkButton variant="quiet" href={`/duel/${RECORDED.id}`}>
                    Open the recorded duel
                  </LinkButton>
                )}
              </>
            )}
            {done ? (
              <LinkButton variant="proof" href={verifyHref(id, arena)}>
                Verify this duel
              </LinkButton>
            ) : null}
            {phase === "running" ? null : (
              <p className="note">
                {liveRow
                  ? "This duel can no longer be attacked. Another one is running."
                  : "This duel can no longer be attacked and no other duel is running right now. The replay shows a real attack from start to verdict."}
              </p>
            )}
          </div>
          {tA && tB ? (
            <details className="details">
              <summary>
                <span className="t-label">What happened, as text</span>
              </summary>
              <div className="details-body">
                <WhatHappened
                  items={[
                    { name: `A ${model("a")}`, input: tA },
                    { name: `B ${model("b")}`, input: tB },
                  ]}
                />
              </div>
            </details>
          ) : null}
        </Stage>
        <div className="room-col room-left">
          {agentPanel("a")}
          {agentPanel("b")}
        </div>
        <div className="room-col room-right">
          {attack && desktop && phase === "running" ? (
            <section className="panel attack-panel" ref={panel} aria-label="Plant a fake headline">
              <div className="hrow">
                <h2 className="t-title">Plant a fake headline</h2>
                <button type="button" className="btn-link end" aria-label="Close" disabled={locked} onClick={close}>
                  ✕
                </button>
              </div>
              {box}
            </section>
          ) : null}
          <PricePanel
            price={shownPrice}
            samples={samples}
            open={open8}
            close={o ? o.close_price : undefined}
            source={
              done
                ? `Line: ${candles.data?.source ?? "exchange candles"}. The duel settled on the oracle's prices.`
                : `Line: this browser's own readings since the page opened.${move ? ` ${move} since the open.` : ""}`
            }
            stale={price.stale}
          />
          <Panel
            label={phase === "running" ? "Cost to plant a headline" : "Headlines in this duel"}
            tag={NETWORK_ID === "testnet" ? <Tag>test NEAR</Tag> : undefined}
          >
            {phase === "running" ? (
              <Readout
                value={d.chaos_fee ? near(d.chaos_fee).replace(" NEAR", "") : "—"}
                unit="NEAR for the next one"
              />
            ) : (
              <Readout value={attacks.length} unit="planted" />
            )}
            {count("Flipped", "Held") ? (
              <Strip
                n={count("Flipped")}
                of={count("Flipped", "Held")}
                kind="alert"
                label={`Fooled ${count("Flipped")} of ${count("Flipped", "Held")} that reached a decision`}
              />
            ) : null}
            <dl className="kv">
              <dt>Fooled</dt>
              <dd>{count("Flipped")}</dd>
              <dt>Held</dt>
              <dd>{count("Held")}</dd>
              <dt>Waiting</dt>
              <dd>{count("Pending")}</dd>
              {o ? (
                <>
                  <dt>Loser paid from its bond</dt>
                  <dd>{near(o.slashed)}</dd>
                </>
              ) : null}
            </dl>
            <p className="note">
              {`A bond is money the agent's owner locked as a promise.${NETWORK_ID === "testnet" ? ` ${TEST_NOTE}.` : ""}`}
            </p>
          </Panel>
          <ChecksPanel counts={counts} href={verifyHref(id, arena)} />
        </div>
      </div>

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
      <p className="duel-head">
        <a href="/arena">← All duels</a>
      </p>
      <Region
        read={read}
        skeleton={
          <div className="stack">
            <h1 className="t-display">{`Duel #${id}`}</h1>
            <div className="room">
              <section className="panel stage">
                <Trace variant="stage" name="A" input={null} />
                <Trace variant="stage" name="B" input={null} />
                <Skeleton bars={["60%", "90%", "40%"]} />
              </section>
            </div>
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
