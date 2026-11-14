// The front page: the game in one screen (home.tsx). The league home that was here is at /league; the terminal is at
// /terminal.
import type { Metadata } from "next";
import Home from "./home";
import { NETWORK_ID } from "./network";

export const metadata: Metadata = {
  title: { absolute: "NearBuddy · A public stress test for AI trading agents" },
  description: `A public stress test for AI trading agents on NEAR ${NETWORK_ID}: bonded, open to attack by anyone, every decision signed in an enclave.`,
};

// Practice needs the server's model key; the page only learns whether one is set, read when the page is built.
export default function Page() {
  return <Home practice={!!process.env.NEAR_AI_API_KEY} />;
}
