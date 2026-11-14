// /api/arena/live/comments: GET ?duel=<id> lists a match's comments, oldest first (the newest 200; one copy kept 2 s for
// every tab). POST {duel, text} adds one for the signed-in account (session cookie): the text rule of lib/comments,
// one comment per account every 5 s. Stored off chain in Upstash Redis, one capped list per match that expires 30
// days after its last comment. A comment is shown to people only: it never enters a model's request.
import { type Comment, clean } from "../../../../lib/comments";
import { canonicalDuelId } from "../../../../lib/enter";
import { KEEP, KEEP_S, sessionOf, store } from "../../../comments";
import { json } from "../../../near";

const EDGE = "public, s-maxage=2, stale-while-revalidate=10";
const TTL = 2_000;
const RATE_S = 5;
const key = (duel: string) => `nb:comments:${duel}`;
const kept = new Map<string, { at: number; body: string }>();
const bad = (error: string, status: number) => json(JSON.stringify({ error }), status);

export async function GET(req: Request) {
  const duel = new URL(req.url).searchParams.get("duel");
  if (!duel || !canonicalDuelId(duel)) return bad("duel must be a duel number, no leading zero", 400);
  const redis = store();
  if (!redis) return json(JSON.stringify({ available: false, duel, comments: [] }));
  const hit = kept.get(duel);
  if (hit && Date.now() - hit.at < TTL) return json(hit.body, 200, EDGE);
  try {
    const newest = await redis.lrange<Comment>(key(duel), 0, KEEP - 1);
    const body = JSON.stringify({ available: true, duel, comments: newest.reverse() });
    kept.set(duel, { at: Date.now(), body });
    if (kept.size > 200) kept.delete(kept.keys().next().value as string);
    return json(body, 200, EDGE);
  } catch {
    return hit ? json(hit.body, 200, EDGE) : bad("the comment store did not answer", 502);
  }
}

export async function POST(req: Request) {
  const redis = store();
  if (!redis) return bad("comments are not set up on this site", 404);
  const account = sessionOf(req);
  if (!account) return bad("sign in to comment", 401);
  const body = (await req.json().catch(() => null)) as { duel?: unknown; text?: unknown } | null;
  const duel = body?.duel;
  if (typeof duel !== "string" || !canonicalDuelId(duel))
    return bad("duel must be a duel number, no leading zero", 400);
  const text = clean(body?.text);
  if ("error" in text) return bad(text.error, 400);
  try {
    if ((await redis.set(`nb:rate:${account}`, 1, { nx: true, ex: RATE_S })) !== "OK")
      return bad(`one comment every ${RATE_S} seconds`, 429);
    const comment: Comment = { id: crypto.randomUUID(), at: Date.now(), by: account, text: text.text };
    await redis
      .pipeline()
      .lpush(key(duel), comment)
      .ltrim(key(duel), 0, KEEP - 1)
      .expire(key(duel), KEEP_S)
      .exec();
    kept.delete(duel);
    return json(JSON.stringify({ comment }));
  } catch {
    return bad("the comment store did not answer", 502);
  }
}
