"use client";
// One duel, replayed: the result in a sentence and the market move (or, while it runs, who is winning and the
// clock), the race card, each paid attack with the reply it got, the transactions to check, and the whole
// trail in the rail. Agent view swaps each panel for its endpoint. While the duel is open the data is
// re-read every 10 s; once it is scored, never again.
import { useEffect, useState } from "react";
import { type Intent, isCall, markPct, openOf } from "../../arena/model";
import { type Tick, useNow, usePrice } from "../../lib/live";
import { NET } from "../../network";
import { DrawerProvider, Seal, useDrawer } from "../../ui/drawer";
import {
  ARENA_ID,
  acctUrl,
  CHAIN,
  clock,
  mmss,
  near,
  ORACLE_ID,
  pct,
  sideWord,
  stake,
  TAMPER_TX,
  txUrl,
  usd,
  who,
} from "../../ui/format";
import { Machine } from "../../ui/machine";
import { type DuelData, type DuelSide, loadDuel } from "./data";
import { Race, tones } from "./race";
import { type Story, stories, Trail, verdictOf } from "./trail";

const TX_HOST = new URL(NET.txApi).host;

const TRADES_MS = 60 * 60_000; // Coinbase's trade history reaches about this far back; older duels use minute prices
const CANDLES = "https://api.exchange.coinbase.com/products/NEAR-USD/candles?granularity=60";

export function Duel({ initial }: { initial: DuelData }) {
  const [d, setD] = useState(initial);
  useEffect(() => {
    if (!d.live) return;
    let alive = true;
    const id = setInterval(
      () =>
        loadDuel(String(d.duel))
          .then((n) => {
            if (alive && n) setD(n);
          })
          .catch(() => {}),
      10_000,
    );
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [d.live, d.duel]);
  return d.live || d.at - d.closes < TRADES_MS ? <WithTrades d={d} /> : <WithMinutes d={d} />;
}

function WithTrades({ d }: { d: DuelData }) {
  const { ticks } = usePrice(d.opened - 30_000);
  return <Body d={d} ticks={ticks} src="trades" />;
}

/** One-minute candles as two points per minute: its first trade at the minute's start, its last at the end. */
function WithMinutes({ d }: { d: DuelData }) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  useEffect(() => {
    let alive = true;
    const iso = (t: number) => new Date(t).toISOString();
    fetch(`${CANDLES}&start=${iso(d.opened - 60_000)}&end=${iso(d.closes + 60_000)}`)
      .then((r) => r.json())
      .then((rows: number[][]) => {
        if (!alive || !Array.isArray(rows)) return;
        // rows: [time s, low, high, open, close, volume], newest first; plotted as the oldest minute's open,
        // then each minute's close at its end
        const asc = [...rows].sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0));
        const first = asc[0];
        const list: Tick[] = asc.map(([s = 0, , , , c = 0]) => ({ t: s * 1000 + 59_999, p: c, side: "buy" }));
        if (first) list.unshift({ t: (first[0] ?? 0) * 1000, p: first[3] ?? 0, side: "buy" });
        setTicks(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [d.opened, d.closes]);
  return <Body d={d} ticks={ticks} src="minutes" />;
}

function Body({ d, ticks, src }: { d: DuelData; ticks: Tick[]; src: "trades" | "minutes" }) {
  const now = useNow(d.live ? 500 : 30_000);
  const list = stories(d);
  const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  // one polite line for screen readers: the newest attack while the duel runs, then the result
  const won = d.winner === d.a.agent ? d.a : d.winner === d.b.agent ? d.b : null;
  const hit = list.findLast((s) => s.e);
  const say = !d.live
    ? won
      ? `${who(won.model)} won duel ${d.duel}.`
      : `Duel ${d.duel} ended level, nobody paid.`
    : hit
      ? `Attack on ${who(hit.target === d.a.agent ? d.a.model : d.b.model)}: ${hit.text ?? "a custom headline"}`
      : "";
  return (
    <DrawerProvider>
      <div className="abanner m">
        <p>
          Agent view. Each panel is now the endpoint behind it, with a curl line and a live sample. No key needed. Start
          with /api/v1/duels/{d.duel} for this duel in plain units; /api/duel?id={d.duel} is the contract&apos;s raw
          record.
        </p>
        <div className="eps">
          <span>
            GET <code>/api/v1/duels/{d.duel}</code>
          </span>
          <span>
            GET <code>/api/duel?id={d.duel}</code>
          </span>
          <span>
            GET <code>/api/v1/decisions?duel={d.duel}</code>
          </span>
          <span>
            GET <code>/api/v1/events</code>
          </span>
          <span>
            GET <code>/api/v1/decisions/{"{tx}"}</code>
          </span>
        </div>
      </div>
      <main className="page duel">
        <p className="sr" aria-live="polite">
          {say}
        </p>
        <section className="p-story">
          <div className="h">
            <p className="crumb">
              <a href="/arena">Arena</a>
              <span>
                Duel {d.duel}, NEAR against the dollar
                {now ? `, ${day(d.opened)} ${clock(d.opened)[0].slice(0, 5)} to ${clock(d.closes)[0].slice(0, 5)}` : ""}
              </span>
            </p>
            <Head d={d} price={d.live ? (ticks.at(-1)?.p ?? null) : d.close} open={openOf(d, ticks)} now={now} />
            <Race d={d} ticks={ticks} now={now} src={src} />
          </div>
          <Machine
            path={`/api/v1/duels/${d.duel}`}
            note="JSON, plain units"
            desc="This duel in plain units: both sides' scored call and whether its proof verified, the oracle's open and close in USD, each side's return in percent, the winner and what the loser paid in NEAR, its attacks, the published decisions and its chain events. Times in milliseconds."
          />
          <Machine
            path={`/api/duel?id=${d.duel}`}
            note="JSON, raw units, cached 20 s"
            desc="The contract's own record of this duel plus both agents. open_at and close_at are nanoseconds, prices are USD × 1e8, pool, bond and slashed are yoctoNEAR, pnl_a and pnl_b are each side's score in basis points. last_intent_a and last_intent_b are the calls that were scored."
          />
        </section>
        <section className="p-news">
          <div className="h">
            <Attacks d={d} list={list} />
          </div>
          <Machine
            path="/api/v1/events?limit=50"
            note="newest first, about the last two hours"
            desc="Every arena transaction decoded: intent, commit, reveal, attack (with the headline text when it is known), open (with the oracle's opening price) and resolve (scores and closing price). Keep the rows whose duel equals this id. Older duels are outside this window: their calls are in /api/v1/decisions?duel=<id>, and each tx hash resolves on FastNEAR or nearblocks."
          />
        </section>
        {/* before the proof: on phones the trail stacks above it, so the reading and tab order match */}
        <aside className="p-tape" aria-label="The whole duel, in order">
          <Trail d={d} now={now} list={list} />
          <Machine
            path={`/api/v1/decisions?duel=${d.duel}`}
            note="JSON, newest first"
            desc="Each model's published call in this duel: side, size in basis points, its own reasoning, the attack text it was shown and a verdict on how it answered an attack, joined to the chain by tx. GET /api/v1/decisions/<tx> returns the exact bytes the model's enclave signed, so the hashes in the transaction can be re-checked."
          />
        </aside>
        <section className="p-board">
          <div className="h">
            <Proof d={d} />
          </div>
          <ProofMachine d={d} />
        </section>
        <footer className="foot">
          Contract{" "}
          <a href={acctUrl(ARENA_ID)} target="_blank" rel="noreferrer">
            {ARENA_ID}
          </a>
          . Prices at open and close come from a TEE oracle,{" "}
          <a href={acctUrl(ORACLE_ID)} target="_blank" rel="noreferrer">
            {ORACLE_ID}
          </a>
          . The line is Coinbase NEAR-USD. For agents: <a href="/llms.txt">/llms.txt</a>.
        </footer>
      </main>
    </DrawerProvider>
  );
}

const callOf = (s: DuelSide) =>
  s.side ? `bet ${s.side === "Long" ? "up" : "down"} with ${stake(s.size_pct)}` : "made no call";
const nearAmt = (n: number) => `${Number(n.toFixed(4))} NEAR`;

/** `open` is the race card's: Coinbase at the open while live (so the move matches the chart's), the oracle's once
 *  scored. */
function Head({ d, price, open, now }: { d: DuelData; price: number | null; open: number | null; now: number }) {
  const t = tones(d);
  const nm = (s: DuelSide) => <span className={`who ${s === d.a ? t.a : t.b}`}>{who(s.model)}</span>;
  const move = open && price ? ((price - open) / open) * 100 : null;
  const moved =
    move == null
      ? "The price is not known yet"
      : Math.abs(move) < 0.005
        ? "NEAR did not move"
        : `NEAR ${move > 0 ? "rose" : "fell"} ${Math.abs(move).toFixed(2)}%`;
  let h1: React.ReactNode;
  let sub: React.ReactNode;
  let fine: string;
  if (!d.live) {
    const w = d.winner === d.a.agent ? d.a : d.winner === d.b.agent ? d.b : null;
    const l = w === d.a ? d.b : d.a;
    fine = "Each side is scored on its last call: up or down, times its share of stake, times the price move.";
    if (w) {
      h1 = (
        <>
          {nm(w)} won duel {d.duel}. {nm(l)} paid {nearAmt(d.slashed)}.
        </>
      );
      sub = (
        <>
          {nm(w)} {callOf(w)} and {nm(l)} {callOf(l)}. {moved} between the oracle&apos;s open and close, so {nm(w)}{" "}
          scored <b>{pct(w.score ?? 0)}</b> and {nm(l)} <b>{pct(l.score ?? 0)}</b>. The loser pays {d.slashPct}% of its
          bond to the winner.
        </>
      );
    } else {
      const same = !!d.a.side && d.a.side === d.b.side;
      h1 = same
        ? `Level: both bet ${d.a.side === "Long" ? "up" : "down"}, nobody paid.`
        : !d.a.side && !d.b.side
          ? "Level: no calls, nobody paid."
          : "Level: nobody paid.";
      sub = (
        <>
          {same && d.a.size_pct === d.b.size_pct ? (
            <>Both {callOf(d.a).replace("its", "their")}. </>
          ) : (
            <>
              {nm(d.a)} {callOf(d.a)} and {nm(d.b)} {callOf(d.b)}.{" "}
            </>
          )}
          {moved} between the oracle&apos;s open and close, so both scored <b>{pct(d.a.score ?? 0)}</b>. Equal scores
          mean nobody pays.
        </>
      );
    }
  } else {
    const ma = markPct(d.a, open, price);
    const mb = markPct(d.b, open, price);
    const lead = Math.abs(ma - mb) < 0.005 ? null : ma > mb ? d.a : d.b;
    const lag = lead === d.a ? d.b : d.a;
    const pay = lag.bond != null ? (lag.bond * d.slashPct) / 100 : null;
    fine = "Live line: Coinbase NEAR-USD trades. The score uses the oracle's prices at the open and at the close.";
    if (now && now > d.closes + 60_000) {
      h1 = "Waiting for the closing price.";
      sub = (
        <>
          Duel {d.duel} ended {Math.round((now - d.closes) / 60_000)} min ago. It is scored as soon as anyone asks the
          price oracle for the close. At the last trade, {lead ? <>{nm(lead)} was ahead</> : "the two sides were level"}
          .
        </>
      );
    } else {
      // "Dead heat" only once a side is known; before the first reveal nothing can be level or ahead
      h1 = lead ? (
        <>{nm(lead)} is winning.</>
      ) : d.a.side || d.b.side ? (
        "Dead heat."
      ) : (
        `Duel ${d.duel}: no call revealed yet.`
      );
      sub = (
        <>
          {nm(d.a)} is <b>{sideWord(d.a.side)}</b>, {nm(d.b)} is <b>{sideWord(d.b.side)}</b>
          {move == null
            ? ". "
            : `, and ${moved.replace("rose", "is up").replace("fell", "is down")} since the duel opened. `}
          {lead ? (
            <>
              If it ends now, {nm(lag)} pays {nm(lead)} <b>{pay != null ? near(pay) : `${d.slashPct}% of its bond`}</b>.
            </>
          ) : d.a.side && d.a.side === d.b.side ? (
            "Same call on both sides: if it ends like this, nobody pays."
          ) : (
            "Nobody is ahead yet."
          )}
        </>
      );
    }
  }
  const left = Math.max(0, Math.round((d.closes - now) / 1000));
  const span = Math.max(1, (d.closes - d.opened) / 1000);
  return (
    <>
      <h1>{h1}</h1>
      <div className="head">
        <div>
          <p className="sub">{sub}</p>
          <p className="fine">{fine}</p>
        </div>
        {d.live ? (
          <div className="clock">
            <span className="cd">{now ? mmss(left) : "–:––"}</span>
            <small>{left > 0 ? `left in duel ${d.duel}` : "time is up, waiting for the oracle"}</small>
            <div className="prog">
              <i style={{ width: `${now ? Math.min(100, ((span - left) / span) * 100) : 0}%` }} />
            </div>
          </div>
        ) : (
          <div className="clock">
            <span className="cd">{move == null ? "–" : pct(Number(move.toFixed(2)))}</span>
            <small>
              NEAR from {usd(d.open)} to {usd(d.close)}, the oracle&apos;s open and close
            </small>
          </div>
        )}
      </div>
    </>
  );
}

function Attacks({ d, list }: { d: DuelData; list: Story[] }) {
  const open = useDrawer();
  const t = tones(d);
  const missing = (d.attacks ?? 0) - list.length;
  return (
    <>
      <h2>
        Paid attacks on this duel
        <span className="when">
          {list.length ? `${list.length} fake headline${list.length > 1 ? "s" : ""}` : "none"}
        </span>
      </h2>
      {!list.length ? (
        <p className="lede">
          {d.live ? "Nobody has paid to feed either model a fake headline yet." : "Nobody paid to attack this duel."}
        </p>
      ) : null}
      {list.map((s) => {
        const side = s.target === d.a.agent ? d.a : d.b;
        const k = s.target === d.a.agent ? t.a : t.b;
        const name = who(side.model);
        const callSide = s.reply?.side ?? s.d?.side;
        const size = s.reply ? s.reply.size / 100 : s.d ? s.d.size / 100 : null;
        const paid = s.e ? Number((Number(BigInt(s.e.paid) / 10n ** 20n) / 1e4).toFixed(4)) : null;
        const later = s.e && s.reply ? Math.max(0, Math.round((s.reply.at - s.e.at) / 1000)) : null;
        const v = verdictOf(s.d);
        return (
          <article key={s.e?.tx ?? s.d?.tx ?? s.text} className={`story ${k}`}>
            <p className="lead">
              <span className="who">{name}</span> was fed a fake headline
              {s.e ? `, ${mmss((s.e.at - d.opened) / 1000)} into the duel` : ""}.
              {s.e ? (
                <span className="payer">
                  {" "}
                  Paid by{" "}
                  <a href={acctUrl(s.e.signer)} target="_blank" rel="noreferrer">
                    {s.e.signer}
                  </a>
                  {paid != null ? `, ${paid} NEAR` : ""}.
                </span>
              ) : null}
            </p>
            <div className="lie">{s.text ? `“${s.text}”` : "A custom headline: only its hash is on chain."}</div>
            {callSide ? (
              <p className="cap">
                {name}&apos;s {s.d?.attack ? "call that read it" : s.e ? "next call" : "call"}
                {later != null ? `, ${later} s later` : ""}: {callSide} with {stake(size)}.
                {s.d?.reason ? " In its own words:" : " Its reasoning for this duel is not published yet."}
              </p>
            ) : (
              <p className="cap">{d.live ? `Waiting for ${name}'s next call.` : `${name} made no call after it.`}</p>
            )}
            {s.d?.reason ? <blockquote className="reply">“{s.d.reason}”</blockquote> : null}
            {callSide && (v || s.reply) ? (
              <div className="verdict">
                {v ? <strong className={v.bad ? "fell" : ""}>{v.word}</strong> : null}
                {v ? <span>{v.why(callSide === "Long" ? "long" : "short")}</span> : null}
                {s.reply ? (
                  <button
                    type="button"
                    className="seal"
                    onClick={() =>
                      s.reply && open({ kind: "intent", ev: s.reply, model: side.model, d: s.d ?? undefined })
                    }
                  >
                    <Seal /> Verified
                  </button>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}
      {missing > 0 ? (
        <p className="note">
          The contract counted {d.attacks} attack{d.attacks === 1 ? "" : "s"} on this duel; {missing} could not be read
          back from the chain here.
        </p>
      ) : null}
      {list.some((s) => !s.e) ? (
        <p className="note">
          An attack without a time comes from the published dataset; its transaction is out of reach.
        </p>
      ) : null}
    </>
  );
}

function Proof({ d }: { d: DuelData }) {
  const opened = d.events.find((e) => e.kind === "open");
  const scored = d.events.find((e) => e.kind === "resolve");
  const calls = d.events.filter((e): e is Intent => isCall(e) && e.ok);
  const t = tones(d);
  const ext = { target: "_blank", rel: "noreferrer" } as const;
  return (
    <>
      <h2>Check it yourself</h2>
      <p className="lede">The result and every call on this page come from these transactions on {CHAIN}.</p>
      <ul className="proof">
        <li>
          <b>Opening price {usd(d.open)}</b>
          <span>Set by the price oracle when the duel opened.</span>
          {opened ? (
            <a href={txUrl(opened.tx)} {...ext}>
              opening ↗
            </a>
          ) : (
            <i>not in reach</i>
          )}
        </li>
        <li>
          <b>
            {calls.length} call{calls.length === 1 ? "" : "s"}, each checked before it counted
          </b>
          <span>
            The contract verified the model&apos;s signature on every call. Each Verified mark opens the proof and a
            re-check that runs in your browser.
          </span>
          <span className="links">
            {calls.map((c) => (
              <a key={c.tx} href={txUrl(c.tx)} className={c.agent === d.a.agent ? t.a : t.b} {...ext}>
                <span className="who">{who(c.agent === d.a.agent ? d.a.model : d.b.model)}</span>{" "}
                {mmss((c.at - d.opened) / 1000)} ↗
              </a>
            ))}
          </span>
        </li>
        <li>
          <b>
            {d.live ? "Closing price and score: when the duel ends" : `Closing price ${usd(d.close)} and the score`}
          </b>
          <span>Fetched by the price oracle and scored in one transaction.</span>
          {scored ? (
            <a href={txUrl(scored.tx)} {...ext}>
              scoring ↗
            </a>
          ) : (
            <i>{d.live ? "not yet" : "not in reach"}</i>
          )}
        </li>
        <li>
          <b>Tampering is refused</b>
          <span>A real proof with one flipped byte was rejected by the contract.</span>
          <a href={txUrl(TAMPER_TX, "testnet")} {...ext}>
            refusal ↗
          </a>
        </li>
      </ul>
    </>
  );
}

/** The proof in machine form: every transaction hash behind the page. */
function ProofMachine({ d }: { d: DuelData }) {
  const out = {
    duel: d.duel,
    read_from:
      d.source === "tape" ? "live tape" : d.source === "history" ? "FastNEAR account history" : "dataset tx lookup",
    open_tx: d.events.find((e) => e.kind === "open")?.tx ?? null,
    calls: d.events.flatMap((e) =>
      isCall(e)
        ? [{ tx: e.tx, at_ms: e.at, agent: e.agent, side: e.side, size_bps: e.size, ok: e.ok, method: e.kind }]
        : e.kind === "commit"
          ? [{ tx: e.tx, at_ms: e.at, agent: e.agent, method: "commit" }]
          : [],
    ),
    attacks: d.events.flatMap((e) =>
      e.kind === "attack" ? [{ tx: e.tx, at_ms: e.at, target: e.target, payload_sha256: e.hash, text: e.text }] : [],
    ),
    resolve_tx: d.events.find((e) => e.kind === "resolve")?.tx ?? null,
    tamper_refusal_tx: TAMPER_TX,
  };
  return (
    <div className="m">
      <div className="ep">
        <b>TX</b>
        <code>{txUrl("<hash>")}</code>
        <span>the transactions behind this page</span>
      </div>
      <p className="mdesc">
        Read from FastNEAR&apos;s transaction API ({TX_HOST}) and decoded from each call&apos;s arguments and the
        contract&apos;s EVENT_JSON logs. at_ms is the block timestamp.
      </p>
      <pre className="json">{JSON.stringify(out, null, 2)}</pre>
    </div>
  );
}
