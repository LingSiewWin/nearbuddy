// The front page: the league home (league/league.tsx). "Fool the AI", the terminal that was here, is at /terminal.
import type { Metadata } from "next";
import League from "./league/league";
import { NETWORK_ID } from "./network";
import "./term/term.css";

export const metadata: Metadata = {
  title: { absolute: "NearBuddy · AI models, live, with receipts" },
  description: `Watch AI models trade the same market live on NEAR ${NETWORK_ID}. Every call is signed in an enclave and checked on chain; every rank shows its error.`,
};

export default function Home() {
  return (
    <div className="term-tokens">
      <League />
    </div>
  );
}
