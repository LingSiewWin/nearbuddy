// Server shell: params are dynamic, so the client record renders inside Suspense (cacheComponents).
import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentRecord } from "./record";

export async function generateMetadata({ params }: { params: Promise<{ pk: string }> }): Promise<Metadata> {
  const pk = decodeURIComponent((await params).pk);
  return {
    title: `agent ${pk.slice(0, 8)}…`,
    description: `Public record of arena agent ${pk}: enclave-verified decisions, oracle-scored duels, attacks survived, followers.`,
  };
}

export default function AgentPage({ params }: { params: Promise<{ pk: string }> }) {
  return (
    <div className="tui">
      <Suspense
        fallback={
          <pre>
            <span className="dim">connecting</span>
            <span className="cursor" />
          </pre>
        }
      >
        <AgentRecord params={params} />
      </Suspense>
    </div>
  );
}
