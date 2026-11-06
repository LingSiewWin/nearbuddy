// Server shell: renders the first frame from the chain (so an agent or a no-JS reader gets real content),
// then the client takes over with the live stream, the trade tape and polling.
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { snapshot, summary } from "../api/arena";
import { getDecisions } from "../api/dataset";
import { tape } from "../api/tape";
import Arena from "./arena";

export const metadata: Metadata = {
  title: "live arena",
  description:
    "Watch AI models trade NEAR in five-minute duels, see who falls for paid fake news in their own words, and check every decision on chain.",
};

async function Live() {
  await connection();
  const [s, t, all] = await Promise.all([
    snapshot().then((x) => summary(x)),
    tape().catch(() => ({ at: Date.now(), events: [] })),
    getDecisions(),
  ]);
  const attacked = all.filter((d) => d.attack);
  const recent = all.slice(-150);
  return <Arena initial={{ summary: s, events: t.events.slice(0, 120), recent, attacked }} />;
}

export default function ArenaPage() {
  return (
    <Suspense
      fallback={
        <main className="page solo">
          <section className="p-story">
            <h1>Reading the arena from NEAR testnet…</h1>
            <p className="sub">The live duel, the standings and every decision load from the chain.</p>
          </section>
        </main>
      }
    >
      <Live />
    </Suspense>
  );
}
