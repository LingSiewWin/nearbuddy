// Server shell: params are dynamic, so the client record renders inside Suspense (cacheComponents).
import type { Metadata } from "next";
import { Suspense } from "react";
import { FollowerRecord } from "./follower";
import "../../term/term.css";

export async function generateMetadata({ params }: { params: Promise<{ account: string }> }): Promise<Metadata> {
  const account = decodeURIComponent((await params).account);
  return {
    title: `follower ${account}`,
    description: `Arena follower ${account}: vault, pending withdrawal, holdings, mandates per agent and settled fills, read from the contract and its transactions.`,
  };
}

export default function FollowerPage({ params }: { params: Promise<{ account: string }> }) {
  return (
    <div className="term-tokens">
      <Suspense
        fallback={
          <pre>
            <span className="dim">connecting</span>
            <span className="cursor" />
          </pre>
        }
      >
        <FollowerRecord params={params} />
      </Suspense>
    </div>
  );
}
