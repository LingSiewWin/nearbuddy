"use client";
// The league home: a ticker, the live match (or a replay of the last one) with the feed beside it, and the
// leaderboards. Read-only: nothing here signs or sends. Data, polled only while the tab is visible: /api/league (5 s),
// /api/spot (2 s, live only), /api/league/feed (3 s live, 30 s replay), /api/league/replay (once per finished match).
import { useEffect, useRef, useState } from "react";
import type { League as Body } from "../api/league";
import type { Comment } from "../lib/comments";
import type { FeedLine } from "../lib/feed";
import { fresh, push, type Sample } from "../lib/stage";
import * as wallet from "../lib/wallet";
import { getJson } from "../tui";
import { AccountBar } from "./account";
import { Boards, Ticker } from "./boards";
import { Chat, type Session } from "./chat";
import { Feed } from "./feed";
import "./league.css";
import { Shout } from "./shout";
import { Stage } from "./stage";
import { type Operator, Start } from "./start";

type Replay = { duel: string; from: number; to: number; samples: Sample[] };
/** A replay plays the whole match in this long, then holds its last frame before it starts again. One-minute candles
 *  at real speed would stand still for a minute at a time. */
const REPLAY_MS = 30_000;
const REPLAY_PAUSE_MS = 5_000;

/** The replay's line up to match time `t`: the samples before it, and a tip interpolated between its neighbours so
 *  the line moves on every tick. */
function upTo(samples: Sample[], t: number): Sample[] {
  const seen = samples.filter((s) => s.t <= t);
  const prev = seen[seen.length - 1];
  const next = samples[seen.length];
  if (!prev || !next || prev.t === t) return seen;
  return [...seen, { t, p: prev.p + ((next.p - prev.p) * (t - prev.t)) / (next.t - prev.t) }];
}
const ms = (ns: string) => Number(BigInt(ns) / 1_000_000n);

/** Runs `f` now and every `every` ms while the tab is visible; `key` restarts it. */
function usePoll(f: () => void, every: number, key: string) {
  const run = useRef(f);
  run.current = f;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` restarts the poll on purpose
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") run.current();
    };
    tick();
    const id = setInterval(tick, every);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [every, key]);
}

export default function League() {
  const [league, setLeague] = useState<Body | null>(null);
  const [failed, setFailed] = useState(false);
  const [buf, setBuf] = useState<Sample[]>([]);
  const [lines, setLines] = useState<FeedLine[]>([]);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replayAt, setReplayAt] = useState(0);
  // 0 until mounted: the prerender has no clock, and the clock poll sets it at once in the browser
  const [now, setNow] = useState(0);
  const lastAt = useRef(0);
  const [operator, setOperator] = useState<Operator>({ available: false });
  const [account, setAccount] = useState<string | null>(null);
  const [session, setSession] = useState<Session>({ available: false, account: null });
  const [comments, setComments] = useState<Comment[]>([]);
  // the wallet a previous visit connected, and sign-in or sign-out from another tab
  useEffect(() => {
    let alive = true;
    let off = () => {};
    wallet.account().then((a) => alive && setAccount(a));
    wallet
      .onChange((a) => alive && setAccount(a))
      .then((f) => {
        off = f;
      });
    return () => {
      alive = false;
      off();
    };
  }, []);

  // a match is live only until its close by this browser's clock: a stale league body must not keep it on stage
  const told = league?.live ?? null;
  const live = told && (now === 0 || now < ms(told.close_at)) ? told : null;
  // past its close and not resolved yet: it stays on stage, closed, until the oracle answers
  const closing = live ? null : (told ?? league?.closing ?? null);
  const shown = live ?? closing ?? league?.last ?? null;
  const shownId = shown?.id ?? "";

  usePoll(
    () =>
      getJson<Body>("/api/league")
        .then((l) => {
          setLeague(l);
          setFailed(false);
        })
        .catch(() => setFailed(true)),
    5_000,
    "league",
  );
  usePoll(() => setNow(Date.now()), 500, "clock");
  usePoll(
    () =>
      getJson<Operator>("/api/league/start")
        .then(setOperator)
        .catch(() => {}),
    5_000,
    "operator",
  );
  // the live line: this browser's own spot readings since it opened the page, within the match
  usePoll(
    () => {
      if (!live) return;
      getJson<{ price: string; at: number }>("/api/spot")
        .then((s) => {
          // a reading counts once, when the server's stamp advances, and is timed by this browser's clock: staleness
          // must not depend on the two clocks agreeing
          if (s.at <= lastAt.current) return;
          lastAt.current = s.at;
          setBuf((b) => push(b, { t: Date.now(), p: Number(s.price) }, 0));
        })
        .catch(() => {}); // a missing reading shows as a stale price
    },
    2_000,
    `spot:${live?.id ?? ""}`,
  );
  usePoll(
    () => {
      if (!shownId) return;
      getJson<{ duel: string; lines: FeedLine[] }>(`/api/league/feed?duel=${shownId}`)
        .then((f) => f.duel === shownId && setLines(f.lines))
        .catch(() => {});
    },
    live || closing ? 3_000 : 30_000,
    `feed:${shownId}:${live ? "live" : "replay"}`,
  );
  // who the comment session is for, once; the chat box changes it on sign-in and sign-out
  useEffect(() => {
    getJson<Session>("/api/league/session")
      .then(setSession)
      .catch(() => {});
  }, []);
  usePoll(
    () => {
      if (!shownId || !session.available) return;
      getJson<{ duel: string; comments: Comment[] }>(`/api/league/comments?duel=${shownId}`)
        .then((c) => c.duel === shownId && setComments(c.comments))
        .catch(() => {});
    },
    live || closing ? 2_000 : 30_000,
    `comments:${shownId}:${live ? "live" : "replay"}:${session.available}`,
  );
  // a new match on the stage starts from an empty line and an empty feed
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the shown match changes
  useEffect(() => {
    setBuf([]);
    setLines([]);
    setComments([]);
    setReplay(null);
  }, [shownId]);
  useEffect(() => {
    if (live || closing || !shownId) return;
    let alive = true;
    getJson<Replay>(`/api/league/replay?duel=${shownId}`)
      .then((r) => {
        if (!alive) return;
        setReplay(r);
        setReplayAt(Date.now());
      })
      .catch(() => alive && setReplay({ duel: shownId, from: 0, to: 0, samples: [] }));
    return () => {
      alive = false;
    };
  }, [shownId, live, closing]);

  const shouts = lines.flatMap((l) => (l.kind === "shout" ? [ms(l.at)] : []));
  let stage = null;
  if (shown && (live || closing)) {
    stage = (
      <Stage
        match={shown}
        mode={live ? "live" : "closing"}
        samples={buf}
        t0={ms(shown.open_at)}
        t1={ms(shown.close_at)}
        nowMs={now}
        priced={!!live && fresh(buf, now)}
        shouts={shouts}
      />
    );
  } else if (shown) {
    const span = replay ? replay.to - replay.from : 0;
    // the fraction of the match played so far, 1 during the pause
    const played = replay && span > 0 ? Math.min(((now - replayAt) % (REPLAY_MS + REPLAY_PAUSE_MS)) / REPLAY_MS, 1) : 0;
    const seen = replay ? upTo(replay.samples, replay.from + played * span) : [];
    stage = (
      <Stage
        match={shown}
        mode="replay"
        samples={seen}
        t0={replay?.from ?? 0}
        t1={replay?.to ?? 1}
        nowMs={now}
        priced={!replay || replay.samples.length > 0}
        shouts={shouts}
      />
    );
  }

  return (
    <main className="league">
      <h1>
        NearBuddy <span className="dim">· AI models trade the same market live; every call is signed and checked</span>
      </h1>
      <AccountBar account={account} onAccount={setAccount} />
      {league ? <Ticker league={league} /> : null}
      <Start op={operator} now={now} live={!!live} onStarted={setOperator} />
      <div className="live">
        {stage ?? (
          <section id="stage" className="panel stage">
            <p className="dim">
              {league ? "no match yet" : failed ? "the league is unreachable" : "reading the league"}
            </p>
          </section>
        )}
        <Feed lines={lines} comments={comments}>
          <Chat
            duel={shownId}
            session={session}
            onSession={setSession}
            account={account}
            onPosted={(c) => setComments((all) => (all.some((x) => x.id === c.id) ? all : [...all, c]))}
          />
          <Shout
            live={live}
            contract={league?.contract ?? null}
            fee={league?.shout_fee ?? null}
            account={account}
            onAccount={setAccount}
          />
        </Feed>
      </div>
      {league ? <Boards league={league} /> : null}
      <footer>
        <a href="/enter">enter an agent</a>
        <a href="/terminal">terminal</a>
        <a href="/arena">full record</a>
        {league?.contract ? <span>{`${league.contract} on NEAR ${league.network}`}</span> : null}
      </footer>
    </main>
  );
}
