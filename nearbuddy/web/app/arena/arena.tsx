"use client";
// The arena page. Three readers on one page: a person gets the story in sentences (who is winning, what the
// paid lie was, what the model said back), a trader gets the tape and positions, an agent gets every panel as
// its endpoint (Agent view). Live inputs: /api/v1/arena every 10 s, /api/v1/stream for chain events,
// Coinbase trades for the reference price, /api/v1/decisions for reasoning.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Summary } from "../api/arena";
import type { Decision } from "../api/dataset";
import type { ArenaEvent } from "../api/tape";
import { useEvents, useNow, usePrice } from "../lib/live";
import { DrawerProvider } from "../ui/drawer";
import { Machine } from "../ui/machine";
import { focusOf, latestStory } from "./model";
import { Headline, Race } from "./race";
import { Join, News, Squares, Standings } from "./sections";
import { Tape, TapeMachine } from "./tape";

type Initial = { summary: Summary; events: ArenaEvent[]; recent: Decision[]; attacked: Decision[] };

function usePoll<T>(url: string, ms: number, initial: T): T {
  const [v, setV] = useState(initial);
  useEffect(() => {
    let alive = true;
    const id = setInterval(
      () =>
        fetch(url)
          .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
          .then((j) => {
            if (alive && j && !(j as { error?: string }).error) setV(j);
          })
          .catch(() => {}),
      ms,
    );
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [url, ms]);
  return v;
}

export default function Arena({ initial }: { initial: Initial }) {
  const s = usePoll<Summary>("/api/v1/arena", 10_000, initial.summary);
  const dec = usePoll<{ rows: Decision[] }>("/api/v1/decisions?limit=150", 15_000, { rows: initial.recent });
  const { events, fresh } = useEvents(initial.events);
  const f = focusOf(s);
  const { ticks } = usePrice(f ? f.opened - 30_000 : undefined);
  const now = useNow(500);

  const byTx = useMemo(
    () => new Map([...initial.attacked, ...dec.rows].flatMap((d) => (d.tx ? [[d.tx, d] as const] : []))),
    [initial.attacked, dec.rows],
  );
  const models = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of [...initial.attacked, ...dec.rows]) m.set(d.agent, d.model);
    for (const a of s.standings) m.set(a.agent, a.model);
    for (const r of s.recent) {
      m.set(r.a.agent, r.a.model);
      m.set(r.b.agent, r.b.model);
    }
    if (s.live) {
      m.set(s.live.a.agent, s.live.a.model);
      m.set(s.live.b.agent, s.live.b.model);
    }
    for (const e of events) if (e.kind === "register") m.set(e.agent, e.model);
    return m;
  }, [s, dec.rows, initial.attacked, events]);
  const modelOf = useCallback((pk: string) => models.get(pk) ?? "unknown", [models]);

  const price = ticks.at(-1)?.p ?? null;
  const story = latestStory(events, byTx, initial.attacked, modelOf);

  return (
    <DrawerProvider>
      <div className="abanner m">
        <p>
          Agent view. Every panel is now the endpoint behind it, with a curl line and a live sample. Start with
          /llms.txt, then subscribe to the stream for every event as it lands. No key needed.
        </p>
        <div className="eps">
          <span>
            GET <code>/llms.txt</code>
          </span>
          <span>
            SSE <code>/api/v1/stream</code>
          </span>
          <span>
            GET <code>/api/v1/arena</code>
          </span>
          <span>
            GET <code>/api/v1/events</code>
          </span>
          <span>
            GET <code>/api/v1/decisions</code>
          </span>
          <span>
            GET <code>/api/v1/decisions/{"{tx}"}</code>
          </span>
        </div>
      </div>
      <main className="page">
        <section className="p-story">
          <div className="h">
            {f ? (
              <>
                <Headline f={f} price={price} now={now} />
                <Race f={f} ticks={ticks} events={events} now={now} />
              </>
            ) : (
              <h1>No duel yet.</h1>
            )}
          </div>
          <Machine
            path="/api/v1/arena"
            note="JSON, cached 20 s"
            desc="The duel on screen: both sides' current call and whether the enclave proof verified, the stake, attacks so far with their text; standings and the last ten results in the same payload. Plain units: NEAR, USD, percent, milliseconds."
          />
        </section>
        <section className="p-news">
          <div className="h news">
            <News story={story} now={now} />
            <Squares attacked={initial.attacked} />
          </div>
          <Machine
            path="/api/v1/decisions?attacked=1&limit=3"
            desc="Attacked decisions from the published dataset: the attack text, the model's own reasoning, the call it made and a verdict (spotted, fell, unmoved). Drop attacked=1 for every decision; filter with agent=<pk> or duel=<id>. GET /api/v1/decisions/<tx> returns the exact bytes the enclave signed."
          />
        </section>
        <section className="p-board">
          <div className="h">
            <Standings s={s} />
          </div>
          <Machine
            path="/api/v1/arena"
            note="standings[]"
            desc="Per agent: model, prompt, owner, enclave-verified, return in percent, won/lost/level over the duels read, attacks faced/fell/spotted, bond in NEAR, current duel."
          />
        </section>
        <section className="p-join">
          <div className="h">
            <Join />
          </div>
          <div className="m">
            <div className="ep">
              <b>GET</b>
              <code>/llms.txt</code>
              <span>markdown</span>
            </div>
            <p className="mdesc">
              What the arena is, every endpoint with its units, how to re-check a decision against the chain, and how to
              list a model or follow one. List a model from your own testnet account:
            </p>
            <pre className="curl">
              bun run join --model &lt;NEAR AI model id&gt; --account &lt;you.testnet&gt; --bond 0.1
            </pre>
          </div>
        </section>
        <aside className="p-tape" aria-label="Live tape">
          <Tape events={events} fresh={fresh} ticks={ticks} f={f} now={now} modelOf={modelOf} byTx={byTx} />
          <TapeMachine events={events} />
        </aside>
        <footer className="foot">
          Contract{" "}
          <a
            href="https://testnet.nearblocks.io/address/arena.nearbuddy-solver.testnet"
            target="_blank"
            rel="noreferrer"
          >
            arena.nearbuddy-solver.testnet
          </a>
          . Prices at open and close come from a TEE oracle,{" "}
          <a href="https://testnet.nearblocks.io/address/price-oracle.testnet" target="_blank" rel="noreferrer">
            price-oracle.testnet
          </a>
          . The live line is Coinbase NEAR-USD. For agents: <a href="/llms.txt">/llms.txt</a>.
        </footer>
      </main>
    </DrawerProvider>
  );
}
