// Server shell: params are dynamic, so the client record renders inside Suspense (cacheComponents).
import type { Metadata } from "next";
import { Suspense } from "react";
import { NETWORK_ID } from "../../../../packages/protocol/src/network";
import { DuelRecord } from "./duel";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `duel #${id}`,
    description: `Arena duel #${id}: two enclave-verified models, TEE oracle prices, attacks and the scored outcome, read from the contract on NEAR ${NETWORK_ID}.`,
  };
}

export default function DuelPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense
      fallback={
        <pre>
          <span className="dim">connecting</span>
          <span className="cursor" />
        </pre>
      }
    >
      <DuelRecord params={params} />
    </Suspense>
  );
}
