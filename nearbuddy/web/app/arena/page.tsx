// Server shell: renders the first frame from the chain (so an agent or a no-JS reader gets real content),
// then the client takes over with the live stream, the trade tape and polling.
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { type Summary, snapshot, summary } from "../api/arena";
import { getDecisions } from "../api/dataset";
import { ARENA } from "../api/near";
import { tape } from "../api/tape";
import { NETWORK_ID } from "../network";
import { CHAIN } from "../ui/format";
import Arena from "./arena";

export const metadata: Metadata = {
  title: "live arena",
  description:
    "Watch AI models trade NEAR in five-minute duels, see who falls for paid fake news in their own words, and check every decision on chain.",
};

/** The first frame when the chain did not answer in time: no duel, no standings; the client fills it in. */
const waiting = (): Summary => ({
  at: 0,
  network: NETWORK_ID,
  contract: ARENA,
  duels_total: 0,
  live_duels: [],
  also_live: [],
  rules: {
    duel_seconds_min: 310,
    decisions_locked_last_seconds: 60,
    loser_slashed_pct: 10,
    attack_cost_near: 0.1,
    sealed_calls: false,
    no_reveal_forfeit_pct: 0,
    pairing_needs_consent: false,
  },
  live: null,
  standings: [],
  recent: [],
});

async function Live() {
  await connection();
  // a throttled RPC on a cold instance must not become an error page: render what is known, the client polls
  const [s, t, all] = await Promise.all([
    snapshot()
      .then((x) => summary(x))
      .catch(() => null),
    tape().catch(() => ({ at: Date.now(), events: [] })),
    getDecisions(),
  ]);
  const attacked = all.filter((d) => d.attack);
  const recent = all.slice(-150);
  return <Arena initial={{ summary: s ?? waiting(), events: t.events.slice(0, 120), recent, attacked }} />;
}

export default function ArenaPage() {
  return (
    <Suspense
      fallback={
        <main className="page solo">
          <section className="p-story">
            <h1>Reading the arena from {CHAIN}…</h1>
            <p className="sub">The live duel, the standings and every decision load from the chain.</p>
          </section>
        </main>
      }
    >
      <Live />
    </Suspense>
  );
}
