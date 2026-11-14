// GET /api/list: the newest duels of both arenas (the main one and the keyless one), one row each, for the home page
// and the duel list. A row carries its arena, both models, the times, how it ended and how many headlines it holds;
// a duel that is not resolved also carries both bonds' total (the home page's tie-break). Cached 20 s and built once
// at a time; the last good body beats a 502. A resolved duel and an agent's model never change, so both are read once.
// ponytail: scans the newest SCAN duels of each arena; an indexer when "Show more" has to reach further back.
import { isVoid } from "../../eras";
import type { AgentView, Duel } from "../../lib/abi/arena";
import { NETWORK_ID } from "../../network";
import { chunked, readDuel } from "../duels";
import { KEYLESS_ARENA, keylessView } from "../keyless";
import { arenaConfigAnyDeploy, arenaView, json, jsonBody } from "../near";

export type ArenaKind = "main" | "keyless";
export type DuelRow = {
  arena: ArenaKind;
  id: string;
  a: { pk: string; model: string };
  b: { pk: string; model: string };
  open_at: string;
  close_at: string;
  resolved: boolean;
  winner: "A" | "B" | "Tie" | null;
  /** Resolved with no price: nobody won. */
  cancelled: boolean;
  headlines: number;
  /** Both agents' bonds in yoctoNEAR, for a duel that is not resolved; null otherwise. */
  bond: string | null;
};
export type DuelList = {
  at: number;
  network: string;
  /** Seconds before the close in which no new decision can land, per arena; null when that arena was not read. */
  lock_s: Record<ArenaKind, number | null>;
  duels: DuelRow[];
  /** Arenas that could not be read this time: their rows are missing, not empty. */
  unread: ArenaKind[];
};

const SCAN = 60;
const TTL = 20_000;
const keylessDone = new Map<string, Duel>();
const models = new Map<string, string>();
let cache: { at: number; body: string } | null = null;
let inflight: Promise<string> | null = null;

async function rows(arena: ArenaKind, view: typeof arenaView, duels: Duel[]): Promise<DuelRow[]> {
  const open = duels.filter((d) => !d.resolved);
  const need = [...new Set(duels.flatMap((d) => [d.a, d.b]))].filter(
    (pk) => !models.has(`${arena}:${pk}`) || open.some((d) => d.a === pk || d.b === pk),
  );
  const bonds = new Map<string, string>();
  const views = await chunked(need, 8, (pk) => view("get_agent", { agent_pk: pk }).catch(() => null));
  views.forEach((v: AgentView | null, i) => {
    const pk = need[i] as string;
    if (!v) return;
    models.set(`${arena}:${pk}`, v.model_id);
    bonds.set(pk, v.bond);
  });
  const side = (pk: string) => ({ pk, model: models.get(`${arena}:${pk}`) ?? "?" });
  return duels.map((d) => {
    const o = d.resolved ? d.outcome : null;
    const [ba, bb] = [bonds.get(d.a), bonds.get(d.b)];
    return {
      arena,
      id: d.id,
      a: side(d.a),
      b: side(d.b),
      open_at: d.open_at,
      close_at: d.close_at,
      resolved: d.resolved,
      winner: o && !isVoid(o) ? (o.winner === null ? "Tie" : o.winner === d.a ? "A" : "B") : null,
      cancelled: d.resolved && (!o || isVoid(o)),
      headlines: o ? o.injections : d.injections.length,
      bond: !d.resolved && ba && bb ? (BigInt(ba) + BigInt(bb)).toString() : null,
    };
  });
}

const newest = (next: number) => Array.from({ length: Math.min(SCAN, next) }, (_, i) => String(next - 1 - i));

async function main(): Promise<{ lock: number; rows: DuelRow[] }> {
  const config = await arenaConfigAnyDeploy();
  const read = await chunked(newest(Number(config.next_duel)), 8, (id) => readDuel(id));
  return {
    lock: config.intent_lock_s,
    rows: await rows(
      "main",
      arenaView,
      read.filter((d): d is NonNullable<typeof d> => !!d),
    ),
  };
}

async function keyless(): Promise<{ lock: number; rows: DuelRow[] }> {
  const config = await keylessView("get_config", {});
  const ids = newest(Number(config.next_duel));
  const fresh = await chunked(
    ids.filter((id) => !keylessDone.has(id)),
    8,
    (id) => keylessView("get_duel", { duel_id: id }).catch(() => null),
  );
  for (const d of fresh) if (d?.resolved) keylessDone.set(d.id, d);
  const open = fresh.filter((d): d is Duel => !!d && !d.resolved);
  const duels = [...open, ...ids.flatMap((id) => keylessDone.get(id) ?? [])];
  return { lock: config.intent_lock_s, rows: await rows("keyless", keylessView, duels) };
}

async function build(): Promise<string> {
  const [m, k] = await Promise.all([main().catch(() => null), KEYLESS_ARENA ? keyless().catch(() => null) : null]);
  if (!m && !k) throw new Error("neither arena could be read");
  const list: DuelList = {
    at: Date.now(),
    network: NETWORK_ID,
    lock_s: { main: m?.lock ?? null, keyless: k?.lock ?? null },
    duels: [...(m?.rows ?? []), ...(k?.rows ?? [])].sort((x, y) => (BigInt(y.close_at) > BigInt(x.close_at) ? 1 : -1)),
    unread: [...(m ? [] : (["main"] as const)), ...(KEYLESS_ARENA && !k ? (["keyless"] as const) : [])],
  };
  const body = jsonBody(list);
  cache = { at: Date.now(), body };
  return body;
}

export async function GET() {
  if (cache && Date.now() - cache.at < TTL) return json(cache.body);
  inflight ??= build().finally(() => {
    inflight = null;
  });
  try {
    return json(await inflight);
  } catch (e) {
    if (cache) return json(cache.body);
    return json(JSON.stringify({ error: String(e instanceof Error ? e.message : e).slice(0, 200) }), 502);
  }
}
