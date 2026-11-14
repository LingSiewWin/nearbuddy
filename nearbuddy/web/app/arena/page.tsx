// /arena: the live match with its start panel (live/live.tsx, in the terminal's look) above the duel list (arena.tsx,
// client-rendered from /api/list).
import type { Metadata } from "next";
import { NETWORK_ID } from "../network";
import "../term/term.css";
import Arena from "./arena";
import LiveArena from "./live/live";

export const metadata: Metadata = {
  title: "Arena",
  description: `Two AIs trade the same market live on NEAR ${NETWORK_ID}, and every duel so far: running and finished, with the planted headlines each one holds.`,
};

export default function ArenaPage() {
  return (
    <Arena>
      {/* `inline`: the terminal tokens without the full-screen page that hides the site header (ui.css, term.css) */}
      <div className="term-tokens inline">
        <LiveArena />
      </div>
    </Arena>
  );
}
