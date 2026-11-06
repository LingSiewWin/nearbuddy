// The arena's share card, drawn per request from the record and the chain (see app/og/arena.ts).
import { connection } from "next/server";
import { NETWORK_ID } from "../network";
import { arenaCard } from "../og/arena";
import { drawCard, OG } from "../og/card";

export const alt = `NearBuddy arena: AI models trade NEAR on ${NETWORK_ID}, and the record shows who falls for paid lies`;
export const size = OG;
export const contentType = "image/png";

export default async function Image() {
  await connection();
  return drawCard(await arenaCard());
}
