// POST /api/guest {accountId, publicKey}: creates and funds a guest account (lib/guest.ts) through NEAR's public
// testnet faucet service, the one the NEAR CLI's `create-account sponsor-by-faucet-service` uses. Only the public key
// arrives here; the private key stays in the visitor's browser. Testnet only. Limited per address and site-wide
// (api/guest.ts), counted in the comment store's Redis when it is configured, else in this process.
import { NETWORK_ID } from "../../network";
import { store } from "../comments";
import { allow, checkGuest, WINDOW_S } from "../guest";
import { json, provider } from "../near";

const FAUCET = "https://helper.nearprotocol.com/account";
const local = new Map<string, { n: number; until: number }>();
const answer = (body: unknown, status = 200) => json(JSON.stringify(body), status);

async function bump(key: string): Promise<number> {
  const redis = store();
  if (redis) {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, WINDOW_S);
    return n;
  }
  const now = Date.now();
  const cur = local.get(key);
  const next = cur && cur.until > now ? { n: cur.n + 1, until: cur.until } : { n: 1, until: now + WINDOW_S * 1000 };
  local.set(key, next);
  return next.n;
}

const exists = (accountId: string) =>
  provider.viewAccount({ accountId }).then(
    (a) => a,
    () => null,
  );

export async function POST(req: Request) {
  if (NETWORK_ID !== "testnet") return answer({ error: "guest accounts exist on testnet only" }, 404);
  const guest = checkGuest(await req.json().catch(() => null));
  if (!guest) return answer({ error: "bad guest account request" }, 400);
  const address = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!(await allow(address, bump).catch(() => false)))
    return answer(
      { error: "too many guest accounts from here for now: try again within the hour, or connect a wallet" },
      429,
    );
  if (await exists(guest.accountId)) return answer({ error: "that name is taken: try again" }, 409);
  const made = await fetch(FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: guest.accountId, newAccountPublicKey: guest.publicKey }),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  }).catch(() => null);
  if (!made?.ok)
    return answer({ error: "the NEAR testnet faucet did not create the account: try again in a minute" }, 502);
  // the account is usable once a final block shows it
  for (let i = 0; i < 12; i++) {
    const a = await exists(guest.accountId);
    if (a) return answer({ accountId: guest.accountId, balance: String(a.amount) });
    await new Promise((r) => setTimeout(r, 800));
  }
  return answer({ error: "the account was requested but is not visible yet: try again in a moment" }, 504);
}
