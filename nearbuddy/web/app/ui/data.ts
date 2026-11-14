"use client";
// What the Trace pages read, and how: one duel from either arena (/api/duel), its decision history (/api/events on
// the main arena, /api/league/feed on the keyless one), the price (/api/spot) and the duel list (/api/list). The pure
// functions turn those bodies into what the screens show; the hooks poll them at the design's rates.
import { useState } from "react";
import type { ArenaKind, DuelList, DuelRow } from "../api/list/route";
import type { ArenaConfigAnyDeploy } from "../api/near";
import type { ChainEvent } from "../cells";
import { isVoid } from "../eras";
import type { AgentView, Chaos, ChaosOpen, Duel, KeylessAgent } from "../lib/abi/arena";
import type { FeedLine } from "../lib/feed";
import { fresh, push, type Sample } from "../lib/stage";
import { getJson } from "../tui";
import { nsMs, price8, type Side } from "./format";
import { usePoll, useRead } from "./kit";
import { type Decision, pinsOf, type TraceIn } from "./trace";
import type { DuelEnd } from "./verdict";

export type { ArenaKind, DuelList, DuelRow };

/** GET /api/duel: one duel as either arena answers it. */
export type DuelBody = {
  at: number;
  contract: string;
  config: ArenaConfigAnyDeploy;
  duel: (Duel & { chaos?: Chaos[] | null; chaos_fee?: string | null }) | null;
  a: AgentView | null;
  b: AgentView | null;
  /** chaos_open per waiting headline's index; null where the arena has no such view. */
  open?: Record<string, ChaosOpen | null>;
  /** get_keyless of side A and B: null for a keyed agent. */
  keyless?: [KeylessAgent | null, KeylessAgent | null];
};
type Events = { oldest_ms: number | null; partial: boolean; opened: unknown; events?: ChainEvent[] };
type Feed = { duel: string; lines: FeedLine[] };

export const arenaOf = (v: string | null | undefined): ArenaKind => (v === "keyless" ? "keyless" : "main");
const q = (arena: ArenaKind, first = "&") => (arena === "keyless" ? `${first}arena=keyless` : "");
export const duelUrl = (id: string, arena: ArenaKind) => `/api/duel?id=${encodeURIComponent(id)}${q(arena)}`;
/** A duel's page; `extra` adds a query such as "attack=a" or "verify=…". */
export const duelPath = (id: string, arena: ArenaKind, extra = "") => {
  const query = [arena === "keyless" ? "arena=keyless" : "", extra].filter(Boolean).join("&");
  return `/duel/${id}${query ? `?${query}` : ""}`;
};
/** The value of the `verify` query for a duel: its id, prefixed for the keyless arena. */
export const verifyKey = (id: string, arena: ArenaKind) => (arena === "keyless" ? `keyless:${id}` : id);
/** The same page with the Verify drawer open on a duel. */
export const verifyHref = (id: string, arena: ArenaKind) => `?verify=${encodeURIComponent(verifyKey(id, arena))}`;
export const agentPath = (pk: string) => `/agent/${encodeURIComponent(pk)}`;
export const SYMBOL = (s: string) => (s === "wrap.near" ? "NEAR/USD" : s);

export type Phase = "running" | "closed" | "finished" | "cancelled";
/** Where a duel stands: running; closed (time is up, the final price is not in); finished; cancelled (voided). */
export function phaseOf(d: Pick<Duel, "resolved" | "close_at" | "outcome">, now: number): Phase {
  if (d.resolved) return !d.outcome || isVoid(d.outcome) ? "cancelled" : "finished";
  return now && now >= nsMs(d.close_at) ? "closed" : "running";
}

/** The duel's end as the money line reads it, for a headline aimed at `target`. */
export function endOf(d: Pick<Duel, "resolved" | "close_at" | "outcome">, target: string, now: number): DuelEnd {
  const phase = phaseOf(d, now);
  if (phase === "running") return { state: "running", secondsLeft: Math.max(0, (nsMs(d.close_at) - now) / 1000) };
  if (phase === "finished") {
    const w = d.outcome?.winner ?? null;
    return { state: "finished", targetLost: w !== null && w !== target };
  }
  return { state: phase };
}

export type History = {
  decisions: Decision[];
  /** Decisions are complete from this time on; null: from the opening. */
  loadedFrom: number | null;
  /** The bet now, when only the arena's last decision is known. */
  current: Side | null;
  /** The newest decision's written reason, where the chain carries one (keyless agents). */
  reason: string | null;
  /** Every decision's time with its reason, oldest first. */
  said: { at: number; text: string }[];
  /** A sealed decision is in and not opened yet (commit-reveal). */
  sealed: boolean;
};

/** One agent's decisions on the main arena, from the arena's own `intent` events. The opening bet has no event: with
 *  no later decision it is the arena's last decision, placed at the open; otherwise the stretch before the first
 *  event is not loaded. */
export function mainHistory(
  pk: string,
  d: Pick<Duel, "open_at" | "close_at" | "last_intent_a" | "last_intent_b" | "a">,
  ev: Events | null,
): History {
  const last = (pk === d.a ? d.last_intent_a : d.last_intent_b)?.side ?? null;
  const none = { reason: null, said: [], sealed: false };
  if (!ev) return { decisions: [], loadedFrom: nsMs(d.close_at), current: last, ...none };
  const mine = (ev.events ?? []).filter((e) => e.agent_pk === pk).sort((x, y) => x.at_ms - y.at_ms);
  const decisions = mine.flatMap((e) => (e.event === "intent" && e.side ? [{ at: e.at_ms, side: e.side }] : []));
  const sealed = mine.at(-1)?.event === "commit";
  const open = nsMs(d.open_at);
  const whole = !ev.partial && ev.oldest_ms !== null && ev.oldest_ms <= open;
  const first = decisions[0];
  if (first) return { decisions, loadedFrom: first.at > open ? first.at : null, current: last, ...none, sealed };
  if (last && whole) return { decisions: [{ at: open, side: last }], loadedFrom: null, current: last, ...none, sealed };
  return { decisions: [], loadedFrom: last || !whole ? nsMs(d.close_at) : null, current: last, ...none, sealed };
}

/** One agent's decisions on the keyless arena, from the replies its keepers submitted (the feed reads every
 *  transaction since the open, so the history is whole). */
export function keylessHistory(
  pk: string,
  model: string,
  d: Pick<Duel, "close_at" | "last_intent_a" | "last_intent_b" | "a">,
  feed: Feed | null,
): History {
  const last = (pk === d.a ? d.last_intent_a : d.last_intent_b)?.side ?? null;
  if (!feed)
    return { decisions: [], loadedFrom: nsMs(d.close_at), current: last, reason: null, said: [], sealed: false };
  const short = model.split("/").pop() ?? model;
  const mine = feed.lines.flatMap((l) =>
    l.kind === "model" && (l.agent ? l.agent === pk : l.model === short) ? [l] : [],
  );
  const said = mine.map((l) => ({ at: nsMs(l.at), text: l.text }));
  return {
    decisions: mine.flatMap((l) => (l.side ? [{ at: nsMs(l.at), side: l.side }] : [])),
    loadedFrom: null,
    current: last,
    reason: said.at(-1)?.text || null,
    said,
    sealed: false,
  };
}

/** One agent's Trace over a duel. `staleAt`: the last good read while the duel read is stale. */
export function traceOf(
  body: DuelBody,
  which: "a" | "b",
  h: History,
  now: number,
  staleAt: number | null,
): TraceIn | null {
  const d = body.duel;
  if (!d) return null;
  const pk = which === "a" ? d.a : d.b;
  const locked = new Set(Object.entries(body.open ?? {}).flatMap(([i, o]) => (o && !o.open ? [Number(i)] : [])));
  return {
    from: nsMs(d.open_at),
    to: nsMs(d.close_at),
    now,
    staleAt,
    running: phaseOf(d, now) === "running",
    decisions: h.decisions,
    loadedFrom: h.loadedFrom,
    current: h.current,
    pins: pinsOf(d.chaos ?? [], pk, locked),
  };
}

/** Polls one duel: every 5 s, or every 3 s while `fast` (one of the visitor's attacks is waiting). Stale after 30 s. */
export function useDuel(id: string | null, arena: ArenaKind, fast = false) {
  const read = useRead<DuelBody>(id ? duelUrl(id, arena) : null, fast ? 3000 : 5000, 30_000);
  const [events, setEvents] = useState<{ key: string; ev: Events } | null>(null);
  const [feed, setFeed] = useState<{ key: string; feed: Feed } | null>(null);
  const key = `${arena}:${id}`;
  // the decision history is enrichment: when it cannot be read the Trace says "earlier decisions not loaded"
  usePoll(
    () => {
      if (!id) return;
      if (arena === "main")
        getJson<Events>(`/api/events?duel=${encodeURIComponent(id)}`)
          .then((ev) => setEvents({ key, ev }))
          .catch(() => {});
      else
        getJson<Feed>(`/api/league/feed?duel=${encodeURIComponent(id)}`)
          .then((f) => setFeed({ key, feed: f }))
          .catch(() => {});
    },
    10_000,
    key,
  );
  const d = read.data?.duel ?? null;
  const ev = events?.key === key ? events.ev : null;
  const fd = feed?.key === key ? feed.feed : null;
  const history = (which: "a" | "b"): History | null => {
    if (!d || !read.data) return null;
    const pk = which === "a" ? d.a : d.b;
    const model = (which === "a" ? read.data.a : read.data.b)?.model_id ?? "";
    return arena === "main" ? mainHistory(pk, d, ev) : keylessHistory(pk, model, d, fd);
  };
  return { read, a: history("a"), b: history("b") };
}

/** NEAR/USD: this browser's own readings since it opened the page (every 2 s), and whether the last one is fresh. A
 *  reading older than 10 s is no price: the page shows "—". */
export function usePrice(on: boolean, now: number) {
  const [buf, setBuf] = useState<Sample[]>([]);
  usePoll(
    () => {
      if (!on) return;
      getJson<{ price: string; at: number }>("/api/spot")
        .then((s) => setBuf((b) => push(b, { t: Date.now(), p: Number(s.price) }, Date.now() - 3 * 3_600_000)))
        .catch(() => {}); // a missing reading shows as a stale price
    },
    2000,
    `spot:${on}`,
  );
  const ok = on && fresh(buf, now);
  return { samples: buf, price: ok ? (buf[buf.length - 1]?.p ?? null) : null, stale: on && buf.length > 0 && !ok };
}

/** A duel's percentage move since its open, "+0.31%", or null without both prices. */
export function sinceOpen(openPrice: string | null | undefined, price: number | null): string | null {
  const open = price8(openPrice);
  if (!open || !price) return null;
  const pct = ((price - open) / open) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}
