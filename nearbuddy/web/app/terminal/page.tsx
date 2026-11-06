// The original btop-style arena, kept as the dense terminal view: standings, the last three duels with
// every proof, followers' mandates, the solver's 1Click quotes, fills and execution quality, and the
// commit-reveal state. Client-rendered from /api/arena.
import type { Metadata } from "next";
import Arena from "./arena";

export const metadata: Metadata = {
  title: "terminal",
  description:
    "The arena in its dense terminal view: standings, every proof, followers' mandates, solver quotes and execution quality.",
};

export default function TerminalPage() {
  return <Arena />;
}
