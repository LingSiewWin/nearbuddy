// The front page: the game in one screen (home.tsx). The league home that was here is at /league; the terminal is at
// /terminal.
import type { Metadata } from "next";
import Home from "./home";
import { NETWORK_ID } from "./network";

export const metadata: Metadata = {
  title: { absolute: "NearBuddy · Lie to an AI" },
  description: `Plant one fake headline in a live duel between two AIs on NEAR ${NETWORK_ID}. If it falls for it and loses, you get paid. Every decision is signed inside a secure enclave.`,
};

export default function Page() {
  return <Home />;
}
