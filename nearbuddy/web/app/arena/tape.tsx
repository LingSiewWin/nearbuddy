"use client";
// The fast lane: the live reference price with its flash and sparkline, each side's position and mark, then
// every on-chain arena event newest first with the trades between events folded into "trades xN" rows, so
// the tape keeps moving between decisions. Rows open the drawer (proof for a call, the story for an attack).
import { useEffect, useMemo, useRef, useState } from "react";
import type { Decision } from "../api/dataset";
import type { ArenaEvent } from "../api/tape";
import type { Tick } from "../lib/live";
import { SHOWN_WORD, shown } from "../lib/verdict";
import { Seal, useDrawer } from "../ui/drawer";
import { ago, clock, duelHref, mmss, near, pct, tone, who } from "../ui/format";
import { type Focus, type Intent, isCall, markPct, openOf, priceAt } from "./model";

type Filter = "all" | "calls" | "attacks" | "duels";

type Feed = "connecting" | "live" | "offline";

function Quote({ ticks, f, feed }: { ticks: Tick[]; f: Focus | null; feed: Feed }) {
  const last = ticks.at(-1);
  const prev = useRef<number | null>(null);
  const [dir, setDir] = useState("");
  // the flash direction is decided after render, so StrictMode's double render cannot erase it
  useEffect(() => {
    if (!last) return;
    if (prev.current != null && last.p !== prev.current) setDir(last.p > prev.current ? "up" : "dn");
    prev.current = last.p;
  }, [last]);
  const span = ticks.filter((k) => k.t >= (last?.t ?? 0) - 5 * 60_000);
  const lo = Math.min(...span.map((k) => k.p));
  const hi = Math.max(...span.map((k) => k.p));
  const pts = span
    .map(
      (k) =>
        `${(((k.t - (span[0]?.t ?? 0)) / Math.max(1, (last?.t ?? 1) - (span[0]?.t ?? 0))) * 100).toFixed(1)},${(36 - ((k.p - lo) / Math.max(1e-9, hi - lo)) * 32).toFixed(1)}`,
    )
    .join(" ");
  const open = f ? openOf(f, ticks) : null;
  const perMin = last ? ticks.filter((k) => k.t > last.t - 60_000).length : 0;
  return (
    <div className="quote">
      <span key={last?.t} className={`qp ${dir}`}>
        {last ? last.p.toFixed(4) : "–"}
      </span>
      <svg className="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-label="last five minutes">
        <polyline points={pts} fill="none" stroke="var(--dim)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="qmeta">
        <span>
          NEAR/USD on Coinbase, {feed === "live" ? "live" : feed === "connecting" ? "connecting…" : "reconnecting…"}
        </span>
        {open && last ? (
          <span>
            <b>{pct(((last.p - open) / open) * 100)}</b> since the duel opened
          </span>
        ) : null}
        <span>
          <b>{perMin}</b> trades/min
        </span>
      </div>
    </div>
  );
}

function Positions({ f, events, ticks, now }: { f: Focus; events: ArenaEvent[]; ticks: Tick[]; now: number }) {
  const price = f.live ? (ticks.at(-1)?.p ?? null) : f.close;
  const open = openOf(f, ticks);
  const since = (pk: string) =>
    events.find((e): e is Intent => isCall(e) && e.ok && e.agent === pk && e.duel === f.duel)?.at;
  const row = (s: Focus["a"], k: string) => {
    const at = since(s.agent);
    return (
      <tr key={s.agent} className={k}>
        <td>{who(s.model)}</td>
        <td>{s.side ? `${s.side === "Long" ? "L" : "S"} ${s.size_pct}%` : "–"}</td>
        <td>{at && now ? mmss((now - at) / 1000) : "–"}</td>
        <td className="r">{pct(markPct(s, open, price))}</td>
        <td className="r">{s.bond != null ? near(s.bond, 2) : "–"}</td>
      </tr>
    );
  };
  const ta = tone(f.a.model);
  const tb = tone(f.b.model) === ta ? "k-alt" : tone(f.b.model);
  return (
    <table className="ptab">
      <thead>
        <tr>
          <th>model</th>
          <th>call</th>
          <th>held</th>
          <th className="r">if it ended now</th>
          <th className="r">bond</th>
        </tr>
      </thead>
      <tbody>
        {row(f.a, ta)}
        {row(f.b, tb)}
      </tbody>
    </table>
  );
}

type Line = { kind: "ev"; e: ArenaEvent } | { kind: "ticks"; key: string; at: number; list: Tick[] };

export function Tape({
  events,
  fresh,
  ticks,
  f,
  now,
  modelOf,
  byTx,
  feed,
}: {
  events: ArenaEvent[];
  fresh: Set<string>;
  ticks: Tick[];
  f: Focus | null;
  now: number;
  modelOf: (pk: string) => string;
  byTx: Map<string, Decision>;
  feed: Feed;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const open = useDrawer();
  const lines = useMemo(() => {
    const shown = events
      .filter((e) =>
        filter === "all"
          ? true
          : filter === "calls"
            ? isCall(e) || e.kind === "commit"
            : filter === "attacks"
              ? e.kind === "attack"
              : e.kind === "open" || e.kind === "resolve",
      )
      .slice(0, 80);
    if (filter !== "all") return shown.map((e): Line => ({ kind: "ev", e }));
    const out: Line[] = [];
    let upper = Number.POSITIVE_INFINITY;
    for (const e of shown) {
      const between = ticks.filter((k) => k.t > e.at && k.t <= upper);
      if (between.length)
        out.push({ kind: "ticks", key: `t${e.tx}`, at: between.at(-1)?.t ?? e.at, list: between.slice(-40) });
      out.push({ kind: "ev", e });
      upper = e.at;
    }
    return out;
  }, [events, ticks, filter]);

  // one polite line for screen readers: the newest attack, duel open or result (calls and trades come too often
  // to speak); a live region announces changes only, so the first frame stays silent
  const loud = events.find(
    (e): e is Extract<ArenaEvent, { kind: "attack" | "open" | "resolve" }> =>
      e.ok && (e.kind === "attack" || e.kind === "open" || e.kind === "resolve"),
  );
  const say = !loud
    ? ""
    : loud.kind === "attack"
      ? `Paid attack on ${who(modelOf(loud.target))}${loud.text ? `: ${loud.text}` : ""}`
      : `Duel ${loud.duel ?? ""} ${loud.kind === "open" ? "opened" : "resolved"}`;

  // the newest chain event's age: past 3 min the arena (or the stream) has gone quiet, so the header greys out
  const lastAt = events[0]?.at;
  const stale = !!lastAt && now - lastAt > 180_000;

  const reply = (pk: string, duel: number, after: number) =>
    events
      .filter((e): e is Intent => isCall(e) && e.ok && e.duel === duel && e.agent === pk && e.at > after)
      .sort((x, y) => x.at - y.at)[0];

  const row = (l: Line) => {
    if (l.kind === "ticks") {
      const [hms, msec] = now ? clock(l.at) : ["··:··:··", ""];
      return (
        <div key={l.key} className="row r-tick">
          <time>
            {hms}
            <i>{msec}</i>
          </time>
          <span className="ty">trades</span>
          <span>×{l.list.length}</span>
          <span className="bars" aria-hidden="true">
            {l.list.map((k, i) => (
              <i
                // biome-ignore lint/suspicious/noArrayIndexKey: trades can share a timestamp; position is the identity
                key={`${k.t}${i}`}
                className={i && k.p > (l.list[i - 1] as Tick).p ? "u" : i && k.p < (l.list[i - 1] as Tick).p ? "d" : ""}
              />
            ))}
          </span>
          <span />
          <span className="px">{l.list.at(-1)?.p.toFixed(4)}</span>
        </div>
      );
    }
    const e = l.e;
    const [hms, msec] = now ? clock(e.at) : ["··:··:··", ""];
    const px = priceAt(ticks, e.at);
    const time = (
      <time>
        {hms}
        <i>{msec}</i>
      </time>
    );
    const cls = `row r-${e.kind}${fresh.has(e.tx) ? " new" : ""}${e.ok ? "" : " r-fail"}`;
    if (e.kind === "commit") {
      const m = modelOf(e.agent);
      return (
        <div key={e.tx} className={`${cls} ${tone(m)}`} title="a hidden call: only its hash is public until the reveal">
          {time}
          <span className="ty">seal</span>
          <span className="who">{who(m)}</span>
          <span className="wt">sealed a call, revealed later</span>
          <span />
          <span className="px">{px?.toFixed(4) ?? ""}</span>
        </div>
      );
    }
    if (isCall(e)) {
      const m = modelOf(e.agent);
      const d = byTx.get(e.tx);
      return (
        <button
          type="button"
          key={e.tx}
          className={`${cls} ${tone(m)}`}
          onClick={() => open({ kind: "intent", ev: e, model: m, d })}
          title={d?.reason ?? "open the proof"}
        >
          {time}
          <span className="ty">{e.kind === "reveal" ? "reveal" : "call"}</span>
          <span className="who">{who(m)}</span>
          <span className="wt">
            {e.ok ? `${e.side} ${e.size / 100}%` : `${e.side} refused`}
            {d && shown(d) ? `, ${SHOWN_WORD[shown(d) ?? "untested"].toLowerCase()}` : ""}
          </span>
          <span className="sb">{e.ok && e.tee === 2 ? <Seal /> : null}</span>
          <span className="px">{px?.toFixed(4) ?? ""}</span>
        </button>
      );
    }
    if (e.kind === "attack") {
      const m = modelOf(e.target);
      const r = reply(e.target, e.duel, e.at);
      return (
        <button
          type="button"
          key={e.tx}
          className={`${cls} ${tone(m)}`}
          onClick={() => open({ kind: "attack", ev: e, model: m, reply: r ? { ev: r, d: byTx.get(r.tx) } : undefined })}
          title={e.text ?? "a custom headline; only its hash is on chain"}
        >
          {time}
          <span className="ty">attack</span>
          <span className="who">{who(m)}</span>
          <span className="wt">{e.text ? `“${e.text}”` : "custom headline"}</span>
          <span />
          <span className="px">{px?.toFixed(4) ?? ""}</span>
        </button>
      );
    }
    if (e.kind === "open" || e.kind === "resolve") {
      const text =
        e.kind === "open"
          ? e.ok
            ? `Duel ${e.duel ?? ""} opened: ${who(modelOf(e.a))} vs ${who(modelOf(e.b))}`
            : `Refused: open a duel, ${who(modelOf(e.a))} vs ${who(modelOf(e.b))}`
          : e.pnlA == null || e.pnlB == null
            ? `Duel ${e.duel} resolved`
            : e.pnlA === e.pnlB
              ? `Duel ${e.duel} level, ${pct(e.pnlA / 100)} each`
              : `Duel ${e.duel}: ${pct(e.pnlA / 100)} vs ${pct(e.pnlB / 100)}${
                  e.fade
                    ? `, ${who(modelOf(e.fade.agent))} agreed ${e.fade.reason === "later" ? "later" : "as answerer"}, scored on the other side`
                    : ""
                }`;
      return (
        <a key={e.tx} className={cls} href={e.duel != null ? duelHref(e.duel) : undefined}>
          {time}
          <span className="ty">{e.kind === "open" ? "open" : "result"}</span>
          <span>#{e.duel ?? "?"}</span>
          <span className="wt">{text}</span>
          <span />
          <span className="px">
            {e.kind === "open" && e.price
              ? (e.price / 1e8).toFixed(4)
              : e.kind === "resolve" && e.close
                ? (e.close / 1e8).toFixed(4)
                : ""}
          </span>
        </a>
      );
    }
    return (
      <div key={e.tx} className={cls}>
        {time}
        <span className="ty">{e.kind === "register" ? "join" : "admin"}</span>
        <span />
        <span className="wt">{e.kind === "register" ? `${e.model} listed` : e.method}</span>
        <span />
        <span className="px" />
      </div>
    );
  };

  return (
    <>
      <div className="h thead">
        <div className="t1">
          <h2>Tape</h2>
          <span className={`rate${stale ? " stale" : ""}`} title="Every arena transaction; times are your local time">
            {!lastAt
              ? "no arena transactions yet"
              : now
                ? `last arena transaction ${ago(lastAt, now)}`
                : "every arena transaction"}
          </span>
        </div>
        <Quote ticks={ticks} f={f} feed={feed} />
        {f ? <Positions f={f} events={events} ticks={ticks} now={now} /> : null}
      </div>
      <fieldset className="h filters">
        <legend className="sr">Show</legend>
        {(["all", "calls", "attacks", "duels"] as Filter[]).map((k) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {k[0]?.toUpperCase()}
            {k.slice(1)}
          </button>
        ))}
      </fieldset>
      <div className="h rows">
        {lines.length ? (
          lines.map(row)
        ) : (
          <p className="lede">No {filter === "all" ? "arena transactions" : filter} in this window yet.</p>
        )}
      </div>
      <p className="sr" aria-live="polite">
        {say}
      </p>
    </>
  );
}

/** The same tape as an agent receives it from /api/v1/stream. */
export function TapeMachine({ events }: { events: ArenaEvent[] }) {
  return (
    <div className="m">
      <div className="ep">
        <b>SSE</b>
        <code>/api/v1/stream</code>
        <span>text/event-stream</span>
      </div>
      <p className="mdesc">
        Every arena transaction as it lands: event name = kind (intent, attack, open, resolve, register), id = block
        height. Reconnect with Last-Event-ID to resume. Polling instead: GET /api/v1/events?since=&lt;block&gt;.
      </p>
      <pre className="curl">curl -sN {"<this host>"}/api/v1/stream</pre>
      <div className="sse">
        {events.slice(0, 24).map((e) => (
          <div key={e.tx} className={`fr${e.kind === "attack" ? " at" : ""}`}>
            <span className="lbl">id: </span>
            {e.block}
            {"\n"}
            <span className="lbl">event: </span>
            <span className="e">{e.kind}</span>
            {"\n"}
            <span className="lbl">data: </span>
            {JSON.stringify(e)}
          </div>
        ))}
      </div>
    </div>
  );
}
