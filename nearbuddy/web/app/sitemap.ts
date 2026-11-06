// sitemap.xml: the fixed pages, the newest duels and every agent on the leaderboard, read from the chain per
// request. Two views and a short deadline; when the chain is slow or down, the fixed pages alone.
import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { type Agent, BOARD, type Config } from "./api/arena";
import { ARENA, viewOn } from "./api/near";
import { agentHref, duelHref, isTestAgent } from "./ui/format";

/** Canonical origin: the production domain on Vercel, else the public deployment. */
export const SITE = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "nearbuddy.vercel.app"}`;
const DUELS = 50;
const CHAIN_MS = 4_000;
const view = viewOn(ARENA);

async function fromChain(): Promise<MetadataRoute.Sitemap> {
  const [config, board] = await Promise.all([
    view("get_config", {}) as Promise<Config>,
    view("leaderboard", BOARD) as Promise<Agent[]>,
  ]);
  const n = Number(config.next_duel);
  const duels = Array.from({ length: Math.min(DUELS, n) }, (_, i) => ({ url: SITE + duelHref(n - 1 - i) }));
  // test bots without an enclave are hidden from the standings, so not listed either
  const agents = board.filter((a) => !isTestAgent(a.model_id)).map((a) => ({ url: SITE + agentHref(a.pk) }));
  return [...duels, ...agents];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  const live = await Promise.race([
    fromChain(),
    new Promise<MetadataRoute.Sitemap>((ok) => setTimeout(() => ok([]), CHAIN_MS)),
  ]).catch(() => []);
  return [
    { url: `${SITE}/arena`, changeFrequency: "always", priority: 1 },
    ...["/how", "/terminal", "/llms.txt", "/openapi.json"].map((p) => ({ url: SITE + p })),
    ...live,
  ];
}
