"use client";
// Client-side live feeds. Reference price: every NEAR-USD trade on Coinbase (public websocket, seeded from
// the REST trade history so the line starts at least one duel back). Duels are scored by the TEE oracle at
// open and close; this line is context, not the score. Arena events: /api/v1/stream (server-sent events),
// merged by tx so a reconnect never duplicates a row.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArenaEvent } from "../api/tape";

export type Tick = { t: number; p: number; side: "buy" | "sell" };
const KEEP_MS = 15 * 60_000;
const CB_REST = "https://api.exchange.coinbase.com/products/NEAR-USD/trades?limit=1000";
const CB_WS = "wss://ws-feed.exchange.coinbase.com";

/** Trades newest last, kept back to `since` (ms) or the last KEEP_MS, whichever is older; older history is
 *  paged in from the REST trades endpoint (cursor in the cb-after header). `status`: is the socket live. */
export function usePrice(since?: number) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const floor = useRef(Number.POSITIVE_INFINITY);
  floor.current = Math.min(since ?? Number.POSITIVE_INFINITY, Date.now() - KEEP_MS);
  const add = useCallback(
    (list: Tick[]) =>
      setTicks((old) => {
        const seen = new Set(old.map((x) => `${x.t}:${x.p}`));
        const merged = [...old, ...list.filter((x) => !seen.has(`${x.t}:${x.p}`))].filter((x) => x.t >= floor.current);
        merged.sort((a, b) => a.t - b.t);
        return merged;
      }),
    [],
  );
  // history: newest page first, then older pages until `since` is covered (at most 6 pages of 1000 trades)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `since` is read through `floor`; a new duel re-runs the backfill
  useEffect(() => {
    let alive = true;
    (async () => {
      let after: string | null = null;
      for (let page = 0; alive && page < 6; page++) {
        const r: Response = await fetch(after ? `${CB_REST}&after=${after}` : CB_REST);
        const rows = (await r.json()) as { time: string; price: string; side: "buy" | "sell" }[];
        if (!Array.isArray(rows) || !rows.length) break;
        add(rows.map((x) => ({ t: Date.parse(x.time), p: Number(x.price), side: x.side })));
        after = r.headers.get("cb-after");
        if (!after || Date.parse((rows.at(-1) as { time: string }).time) <= floor.current) break;
      }
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [since, add]);
  useEffect(() => {
    let alive = true;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let wait = 1_000;
    const open = () => {
      ws = new WebSocket(CB_WS);
      ws.onopen = () => {
        wait = 1_000;
        setStatus("live");
        ws?.send(JSON.stringify({ type: "subscribe", product_ids: ["NEAR-USD"], channels: ["matches"] }));
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { type: string; time?: string; price?: string; side?: "buy" | "sell" };
        // Coinbase's side is the maker's; the taker (the aggressor a tape shows) is the other side
        if ((m.type === "match" || m.type === "last_match") && m.price && m.time)
          add([{ t: Date.parse(m.time), p: Number(m.price), side: m.side === "buy" ? "sell" : "buy" }]);
      };
      ws.onclose = () => {
        if (!alive) return;
        setStatus("offline");
        retry = setTimeout(open, wait);
        wait = Math.min(wait * 2, 30_000);
      };
    };
    open();
    return () => {
      alive = false;
      clearTimeout(retry);
      ws?.close();
    };
  }, [add]);
  return { ticks, last: ticks.at(-1) ?? null, status };
}

/** Arena events newest first, starting from `initial` (server-rendered) and extended by the stream. */
export function useEvents(initial: ArenaEvent[]) {
  const [events, setEvents] = useState(initial);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const seen = useRef(new Set(initial.map((e) => e.tx)));
  useEffect(() => {
    const top = initial[0]?.block ?? 0;
    const es = new EventSource(`/api/v1/stream${top ? `?since=${top}` : ""}`);
    const on = (msg: MessageEvent) => {
      if (typeof msg.data !== "string") return; // EventSource's own "open" event has no data
      const e = JSON.parse(String(msg.data)) as ArenaEvent;
      if (seen.current.has(e.tx)) return;
      seen.current.add(e.tx);
      setEvents((old) => [e, ...old].sort((a, b) => b.block - a.block).slice(0, 200));
      setFresh((f) => new Set(f).add(e.tx));
      setTimeout(
        () =>
          setFresh((f) => {
            const n = new Set(f);
            n.delete(e.tx);
            return n;
          }),
        2_500,
      );
    };
    for (const k of ["intent", "attack", "open", "resolve", "register", "other"]) es.addEventListener(k, on);
    return () => es.close();
  }, [initial]);
  return { events, fresh };
}

/** Wall clock that re-renders every `ms`; 0 until mounted so server and first client render agree. */
export function useNow(ms = 1_000) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
