// /api/league/session: the comment session. POST a wallet's NEP-413 signed sign-in (api/comments.ts login) to get an
// HttpOnly cookie for seven days; GET says who the cookie is for; DELETE clears it. SameSite=Lax keeps another site
// from posting with it. Off (available: false) where the comment store is not configured.
import { login, SESSION_MS, sealSession, sessionKey, sessionOf, setCookie, store } from "../../comments";
import { json, provider } from "../../near";

const answer = (body: unknown, status = 200, cookie?: string) => {
  const res = json(JSON.stringify(body), status);
  if (cookie) res.headers.append("set-cookie", cookie);
  return res;
};

export async function GET(req: Request) {
  return answer({ available: !!store(), account: sessionOf(req) });
}

export async function POST(req: Request) {
  const redis = store();
  const key = sessionKey();
  if (!redis || !key) return answer({ error: "comments are not set up on this site" }, 404);
  const body = await req.json().catch(() => null);
  const host = new URL(req.url).host;
  const out = await login(body, host, Date.now(), provider, async (nonce) => {
    // single use: kept twice as long as a nonce stays fresh
    return (await redis.set(`nb:nonce:${nonce}`, 1, { nx: true, ex: 600 })) === "OK";
  });
  if ("error" in out) return answer(out, 401);
  const exp = Date.now() + SESSION_MS;
  return answer(out, 200, setCookie(req, sealSession(out.account, exp, key), SESSION_MS / 1000));
}

export async function DELETE(req: Request) {
  return answer({ account: null }, 200, setCookie(req, "", 0));
}
