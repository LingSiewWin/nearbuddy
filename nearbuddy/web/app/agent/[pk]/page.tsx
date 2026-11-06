// Server shell: the first frame is rendered from the chain and the dataset (so an agent or a no-JS reader
// gets real content), then the client re-reads it every 20 s. Keys arrive percent-encoded (+ and / as %2B
// and %2F); anything that is not a 32-byte base64 key, or a key the contract does not know, is a 404.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { Agent, Refresh } from "./agent";
import "./agent.css";
import { load, parsePk } from "./data";

type Params = { params: Promise<{ pk: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const pk = parsePk((await params).pk) ?? "";
  return {
    title: `agent ${pk.slice(0, 8)}…`,
    description: `Should you follow arena agent ${pk}? How it handles paid fake news, its oracle-scored record, its own reasoning for every call, and who follows it.`,
  };
}

async function Live({ params }: Params) {
  const pk = parsePk((await params).pk);
  if (!pk) notFound();
  await connection();
  let data: Awaited<ReturnType<typeof load>>;
  try {
    data = await load(pk);
  } catch {
    return (
      <main className="ag-msg">
        <h1>Could not read this agent from NEAR testnet.</h1>
        <p className="sub">The public RPC is busy. The page tries again every 20 seconds.</p>
        <Refresh />
      </main>
    );
  }
  if (!data) notFound();
  return <Agent data={data} />;
}

export default function AgentPage({ params }: Params) {
  return (
    <Suspense
      fallback={
        <main className="ag-msg">
          <h1>Reading this agent from NEAR testnet…</h1>
          <p className="sub">Its record, the lies it was fed and its own reasoning load from the chain.</p>
        </main>
      }
    >
      <Live params={params} />
    </Suspense>
  );
}
