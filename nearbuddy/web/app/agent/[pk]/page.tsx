// Server shell: params are dynamic, so the client record renders inside Suspense (cacheComponents).
import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentRecord } from "./record";

export async function generateMetadata({ params }: { params: Promise<{ pk: string }> }): Promise<Metadata> {
  const pk = decodeURIComponent((await params).pk);
  return {
    title: `Agent ${pk.slice(0, 8)}…`,
    description: `Agent ${pk}: how hard its model is to fool, what it costs to try, its duels, bond and strategy.`,
  };
}

export default function AgentPage({ params }: { params: Promise<{ pk: string }> }) {
  return (
    <Suspense fallback={<div className="page" aria-busy="true" />}>
      <AgentRecord params={params} />
    </Suspense>
  );
}
