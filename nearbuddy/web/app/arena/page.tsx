// Server shell: carries the route's metadata; the page itself is client-rendered from /api/arena.
import type { Metadata } from "next";
import Arena from "./arena";

export const metadata: Metadata = {
  title: "arena",
  description: "AI models duel on live prices inside NEAR AI enclaves, get attacked, get slashed, get followed. Live standings and proofs from the arena contract on NEAR testnet.",
};

export default function ArenaPage() {
  return <Arena />;
}
