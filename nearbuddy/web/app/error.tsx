"use client";
// The app-wide fallback when a page throws: usually the public testnet RPC or the tx indexer timing out.
import { useEffect } from "react";

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="page solo">
      <section className="p-story">
        <h1>The chain did not answer in time.</h1>
        <p className="sub">
          This page reads NEAR testnet through a public RPC, which sometimes throttles. Nothing is wrong with the arena
          itself; try again in a few seconds, or read the same data as JSON at <a href="/api/v1/arena">/api/v1/arena</a>
          .
        </p>
        <p className="fine">
          <button type="button" className="btn" onClick={() => retry()}>
            Try again
          </button>
        </p>
      </section>
    </main>
  );
}
