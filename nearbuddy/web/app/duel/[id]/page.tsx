// Server shell: params are dynamic, so the client view renders inside Suspense (cacheComponents).
import type { Metadata } from "next";
import { Suspense } from "react";
import { NETWORK_ID } from "../../network";
import { DuelView } from "./duel";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Duel #${id}`,
    description: `Duel #${id}: two AIs bet on the NEAR price, each decision signed inside a secure enclave, with every planted headline and its result. Read from the arena contract on NEAR ${NETWORK_ID}.`,
  };
}

export default function DuelPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="page" aria-busy="true" />}>
      <DuelView params={params} />
    </Suspense>
  );
}
