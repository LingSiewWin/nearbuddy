// /arena: the duel list (arena.tsx), client-rendered from /api/list.
import type { Metadata } from "next";
import { NETWORK_ID } from "../network";
import Arena from "./arena";

export const metadata: Metadata = {
  title: "Duels",
  description: `Every duel between two AIs on NEAR ${NETWORK_ID}: running and finished, with the planted headlines each one holds.`,
};

export default function ArenaPage() {
  return <Arena />;
}
