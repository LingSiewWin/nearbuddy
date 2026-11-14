// Who planted the headlines: classifies every injector of an arena by how its account came to exist, from chain data
// only (lab/live/PREREG.md, "Outside attackers"). Read-only: views and the FastNEAR tx API, no key.
//
//   house   the account is a project account, a sub-account of one, or was created or funded by one
//   guest   a nb-guest-*.testnet account created by NEAR's public testnet faucet (signer `testnet`): made through
//           this project's /api/guest, so countable as outside only if not on the project's own guest list
//   outside created by an account that is neither the project nor the public faucet
//   unknown no creating transaction found (too old for the indexer, or it failed): never counted as outside
//
// What chain data cannot show: that two guests or two outside accounts are not one person, or that an outside account
// is not a project member's personal wallet. Those limits are reported with every count.
//
// Usage: bun analysis/attackers.ts <arena> [<arena> ...]   (prints one JSON row per injector)

/** Accounts the project controls: exact names and every sub-account of them. */
export const HOUSE_ROOTS = [
  "nearbuddy-solver.testnet",
  "nearbuddy-owner.testnet",
  "nearbuddy-redteam1.testnet",
  "nb-pred-a-1111.testnet",
  "nb-relay-1111.testnet",
  "nb-keyless-arena-1111.testnet",
  "nb-keyless-keeper-1111.testnet",
  "nb-kk-spec-1111.testnet",
];
/** Faucet-made accounts the project made itself (guest tests, red-team and battle runs): listed by hand when made,
 *  never inferred. The chain cannot tell them from a stranger's (nb-battle-9d5b was "outside" until listed). */
export const HOUSE_ACCOUNTS = ["nb-guest-ut778rx9rp.testnet", "nb-battle-9d5b.testnet"];
const FAUCET = "testnet";
const GUEST = /^nb-guest-[a-z0-9]{10}\.testnet$/;

export type Origin = { signer: string; receiver: string; actions: string[] } | null;
export type Class = "house" | "guest" | "outside" | "unknown";

const under = (a: string, roots: string[]) => roots.some((r) => a === r || a.endsWith(`.${r}`));

/** The class of `account`, given the transaction that created it (`origin`, null when none was found). A creator is
 *  house when it is under a house root; `houseGuests` are the project's own guests. */
export function classify(
  account: string,
  origin: Origin,
  roots: string[] = HOUSE_ROOTS,
  houseGuests: string[] = HOUSE_ACCOUNTS,
): Class {
  if (under(account, roots) || houseGuests.includes(account)) return "house";
  if (!origin || origin.receiver !== account || !origin.actions.includes("CreateAccount")) return "unknown";
  if (under(origin.signer, roots)) return "house";
  if (origin.signer === FAUCET) return GUEST.test(account) ? "guest" : "outside";
  return "outside";
}

const TX = "https://tx.test.fastnear.com/v0";
const RPC = process.env.ATTACKERS_RPC ?? "https://test.rpc.fastnear.com";
async function post<T>(url: string, body: unknown): Promise<T> {
  for (let i = 0; ; i++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (r?.ok) return (await r.json()) as T;
    if (i >= 5) throw new Error(`${url}: ${r?.status ?? "no answer"}`);
    await new Promise((s) => setTimeout(s, 1000 * 2 ** i)); // FastNEAR 429s a burst
  }
}
async function view<T>(contract: string, method: string, args: object): Promise<T> {
  const r = await post<{ result?: { result: number[] } }>(RPC, {
    jsonrpc: "2.0",
    id: 1,
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
  });
  if (!r.result) throw new Error(`${contract}.${method}: no result`);
  return JSON.parse(Buffer.from(r.result.result).toString()) as T;
}

type Tx = { transaction: { signer_id: string; receiver_id: string; actions: (string | Record<string, unknown>)[] } };
/** The oldest transaction the indexer lists for `account` that created it, or null. */
async function origin(account: string): Promise<Origin> {
  const hashes: string[] = [];
  let resume: string | undefined;
  do {
    const p = await post<{ account_txs: { transaction_hash: string }[]; resume_token?: string }>(`${TX}/account`, {
      account_id: account,
      ...(resume ? { resume_token: resume } : {}),
    });
    hashes.push(...p.account_txs.map((t) => t.transaction_hash));
    resume = p.resume_token;
  } while (resume);
  for (const h of hashes.reverse()) {
    const [x] = (await post<{ transactions: Tx[] }>(`${TX}/transactions`, { tx_hashes: [h] })).transactions;
    const actions = (x?.transaction.actions ?? []).map((a) => (typeof a === "string" ? a : (Object.keys(a)[0] ?? "")));
    if (x && x.transaction.receiver_id === account && actions.includes("CreateAccount"))
      return { signer: x.transaction.signer_id, receiver: account, actions };
  }
  return null;
}

if (import.meta.main) {
  for (const arena of process.argv.slice(2)) {
    const next = Number((await view<{ next_duel: string }>(arena, "get_config", {})).next_duel);
    const count = new Map<string, number>();
    for (let d = 0; d < next; d++)
      for (const c of await view<{ injector: string }[]>(arena, "get_chaos", { duel_id: String(d) }))
        count.set(c.injector, (count.get(c.injector) ?? 0) + 1);
    for (const [account, attacks] of count) {
      const o = await origin(account);
      console.log(JSON.stringify({ arena, account, attacks, class: classify(account, o), creator: o?.signer ?? null }));
    }
  }
}
