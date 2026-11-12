// GET /api/league/feed?duel=<id>: one keyless match's feed (lib/feed.ts): each model's reply from the
// submit_completion transactions (the chain keeps only the reply's hash, so the text is read from the call's args
// through lib/verify's transaction reader) and the shouts from get_chaos. Kept as lib/feed keepFor says (3 s open,
// 60 s resolved, for good an hour after the close); the last good body beats a 502.
// ponytail: an open match rescans its transaction window every 3 s; an events indexer when matches run back to back.
import { canonicalDuelId } from "../../../lib/enter";
import { keepFor, merge, type Said, type Shout, saidOf } from "../../../lib/feed";
import { arenaCalls, txsBetween } from "../../../lib/verify";
import { NETWORK_ID } from "../../../network";
import { KEYLESS_ARENA, keylessView } from "../../keyless";
import { json, jsonBody } from "../../near";

export const maxDuration = 60;

const kept = new Map<string, { until: number; body: string }>();
const inflight = new Map<string, Promise<string>>();
const utf8 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const short = (model_id: string) => model_id.split("/").pop() ?? model_id;

async function build(arena: string, id: string): Promise<string | null> {
  const duel = await keylessView("get_duel", { duel_id: id });
  if (!duel) return null;
  const openMs = Number(BigInt(duel.open_at) / 1_000_000n);
  const closeMs = Number(BigInt(duel.close_at) / 1_000_000n);
  const [a, b, chaos, txs] = await Promise.all([
    keylessView("get_agent", { agent_pk: duel.a }),
    keylessView("get_agent", { agent_pk: duel.b }),
    keylessView("get_chaos", { duel_id: id }),
    txsBetween(arena, openMs - 120_000, Math.min(closeMs + 3_600_000, Date.now())),
  ]);
  const modelOf = new Map([
    [duel.a, short(a?.model_id ?? "?")],
    [duel.b, short(b?.model_id ?? "?")],
  ]);
  const said: Said[] = arenaCalls(txs, arena)
    .filter((c) => c.ok && c.method === "submit_completion" && String(c.args.duel_id) === id)
    .map((c) => ({
      kind: "model",
      at: String(c.at_ns),
      model: modelOf.get(String(c.args.agent)) ?? "?",
      tx: c.tx,
      ...saidOf(utf8(String(c.args.response))),
    }));
  const shouts: Shout[] = chaos.map((c, index) => ({
    kind: "shout",
    at: c.at,
    index,
    by: c.injector,
    target: c.target === duel.a ? "A" : "B",
    text: c.headline || null,
    arm: c.arm,
    outcome: c.outcome,
  }));
  const body = jsonBody({ at: Date.now(), duel: id, lines: merge(said, shouts) });
  kept.set(id, { until: Date.now() + keepFor(duel.resolved, closeMs, Date.now()), body });
  if (kept.size > 200) kept.delete(kept.keys().next().value as string);
  return body;
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("duel");
  if (!id || !canonicalDuelId(id))
    return json(JSON.stringify({ error: "duel must be a duel number, no leading zero" }), 400);
  if (!KEYLESS_ARENA) return json(JSON.stringify({ error: `no keyless arena on ${NETWORK_ID}` }), 404);
  const hit = kept.get(id);
  if (hit && Date.now() < hit.until) return json(hit.body);
  let p = inflight.get(id);
  if (!p) {
    const arena = KEYLESS_ARENA;
    p = build(arena, id)
      .then((body) => body ?? "")
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  try {
    const body = await p;
    return body ? json(body) : json(JSON.stringify({ error: `no duel #${id}` }), 404);
  } catch (e) {
    if (hit) return json(hit.body);
    return json(JSON.stringify({ error: String(e instanceof Error ? e.message : e).slice(0, 200) }), 502);
  }
}
