// The front page: "Fool the AI" as an interactive terminal (term/term.tsx). The full btop-style record stays at /arena.
import type { Metadata } from "next";
import { NETWORK_ID } from "./network";
import Term from "./term/term";
import "./term/term.css";

export const metadata: Metadata = {
  title: { absolute: "Fool the AI · NearBuddy" },
  description: `Plant one fake headline in a live AI trading duel on NEAR ${NETWORK_ID}, sign it with your wallet, and see whether the model takes the bait. Every call is enclave-signed.`,
};

export default function Home() {
  return <Term />;
}
