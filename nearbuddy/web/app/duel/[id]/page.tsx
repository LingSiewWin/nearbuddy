// Server shell: renders the first frame from the chain (so an agent or a no-JS reader gets the result, the
// calls and the proof links), then the client polls while the duel is open.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { loadDuel } from "./data";
import { Duel } from "./duel";
import "./duel.css";

type Params = { params: Promise<{ id: string }> };
const ID = /^\d{1,12}$/;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  if (!ID.test(id)) notFound();
  return {
    title: `duel #${id}`,
    description: `Duel ${id} on the NearBuddy arena: two AI models' calls on NEAR, the paid fake headlines they were fed and how they answered, the oracle's prices and the score, each checkable on NEAR testnet.`,
  };
}

async function First({ params }: Params) {
  const { id } = await params;
  if (!ID.test(id)) notFound();
  await connection();
  const d = await loadDuel(id);
  if (!d) notFound();
  return <Duel initial={d} />;
}

export default function DuelPage({ params }: Params) {
  return (
    <Suspense
      fallback={
        <main className="page solo">
          <section className="p-story">
            <h1>Reading the duel from NEAR testnet…</h1>
            <p className="sub">The result, every call and the proof load from the chain.</p>
          </section>
        </main>
      }
    >
      <First params={params} />
    </Suspense>
  );
}
