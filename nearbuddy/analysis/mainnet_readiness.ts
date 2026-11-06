// Read-only check of the mainnet facts the week-4 dry run depends on. Sends no transaction and spends nothing:
// RPC views, the 1Click token list, one dry quote, the NEAR AI model list and one non-billable attestation report per
// model (NEAR_AI_API_KEY sent when set). Prints a PASS/FAIL/SKIP/INFO table; exits 1 on any FAIL. Signer pins are read from
// ARENA_CONTRACT on NEAR_RPC (testnet by default; point both at the mainnet arena once it exists), and so are the
// deploy-15 checks (verified settlement, re-keyed follows, delay, cap, register v2, duel_lock, pagination), which say
// "not deployed" (SKIP) on an older arena.
//   bun analysis/mainnet_readiness.ts
//   MAINNET_RPC=https://rpc.mainnet.fastnear.com OWNER_ID_MAINNET=nearbuddy.near SOLVER_ID_MAINNET=solver.nearbuddy.near
import "../packages/protocol/src/env.ts";
import { randomBytes } from "node:crypto";
import { NETWORKS } from "../packages/protocol/src/network.ts";
import { quote, sellNearForUsdc, USDC_NEAR, WNEAR } from "../packages/solver/src/oneclick.ts";

const RPC = process.env.MAINNET_RPC ?? "https://rpc.mainnet.fastnear.com";
const ORACLE = process.env.MAINNET_ORACLE ?? "price-oracle.near";
const OWNER = process.env.OWNER_ID_MAINNET ?? "nearbuddy.near";
const SOLVER = process.env.SOLVER_ID_MAINNET ?? "solver.nearbuddy.near";
const NEAR_AI = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
const NEAR_AI_KEY = process.env.NEAR_AI_API_KEY?.trim();
const MODELS = (process.env.MAINNET_MODELS ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017,Qwen/Qwen3.8-27B").split(",");
// The arena's lock must cover the oracle's cache. Testnet runs 300 s; the roadmap plans lock 330 / floor 660.
const PLANNED_LOCK_S = Number(process.env.PLANNED_LOCK_S ?? 330);
// One follower fill: 5 USDC is about this much wNEAR at the 2026-11 price; override with FILL_YOCTO.
const FILL_YOCTO = BigInt(process.env.FILL_YOCTO ?? "1350000000000000000000000");
const USDC_ACCOUNT = USDC_NEAR.slice("nep141:".length);

type Row = { check: string; result: "PASS" | "FAIL" | "SKIP" | "INFO"; detail: string };
const rows: Row[] = [];
const add = (check: string, result: Row["result"], detail: string) => rows.push({ check, result, detail });

async function rpc<T>(method: string, params: unknown, url = RPC): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as {
    result?: T;
    error?: { cause?: { name?: string; info?: unknown }; message?: string; data?: unknown };
  };
  // the cause name first (UNKNOWN_ACCOUNT is matched on it), then whatever detail the node gave (MethodNotFound)
  if (j.error)
    throw new Error(
      [j.error.cause?.name, j.error.data, j.error.cause?.info, j.error.message]
        .filter((x) => x !== undefined)
        .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
        .join(": ") || JSON.stringify(j.error),
    );
  return j.result as T;
}
const account = (id: string) =>
  rpc<{ amount: string; code_hash: string; storage_usage: number }>("query", {
    request_type: "view_account",
    finality: "final",
    account_id: id,
  });
async function view<T>(contract: string, method: string, args: unknown = {}, url = RPC): Promise<T> {
  const res = await rpc<{ result?: number[]; error?: string }>(
    "query",
    {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
    url,
  );
  if (!res.result) throw new Error(res.error ?? "no result");
  return JSON.parse(Buffer.from(res.result).toString()) as T;
}
/** Run one check; a thrown error is a FAIL with its message, never a crash of the whole table. */
async function check(name: string, fn: () => Promise<[Row["result"], string]>) {
  try {
    const [res, detail] = await fn();
    add(name, res, detail);
  } catch (e) {
    add(name, "FAIL", String((e as Error).message ?? e).slice(0, 160));
  }
}
const isContract = (h: string) => h !== "11111111111111111111111111111111";
const near = (yocto: bigint) => `${(Number(yocto / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;

// ---- chain: the contracts we call --------------------------------------------------------------------------
await check(`${ORACLE} deployed`, async () => {
  const a = await account(ORACLE);
  return [
    isContract(a.code_hash) ? "PASS" : "FAIL",
    `code ${a.code_hash.slice(0, 8)}…, version ${await view<string>(ORACLE, "get_version")}`,
  ];
});
await check(`${ORACLE} serves wrap.near (get_price_data)`, async () => {
  const d = await view<{ recency_duration_sec: number; prices: { asset_id: string; price: unknown }[] }>(
    ORACLE,
    "get_price_data",
    { asset_ids: ["wrap.near"] },
  );
  const p = d.prices.find((x) => x.asset_id === "wrap.near");
  if (!p) return ["FAIL", "wrap.near not in the oracle's asset list"];
  return ["PASS", `listed; cached price ${p.price ? JSON.stringify(p.price) : "null (stale: oracle_call fetches)"}`];
});
await check(`${ORACLE} recency window vs planned lock ${PLANNED_LOCK_S} s`, async () => {
  const d = await view<{ recency_duration_sec: number }>(ORACLE, "get_price_data", { asset_ids: ["wrap.near"] });
  const r = d.recency_duration_sec;
  // The lock must outlast the window in which the oracle can hand back an already-known price.
  return [r < PLANNED_LOCK_S ? "PASS" : "FAIL", `recency_duration_sec ${r}; lock must exceed it (testnet is 300)`];
});
await check(`${ORACLE} subsidises oracle_call`, async () => {
  const s = await view<boolean>(ORACLE, "can_subsidize_outlayer_calls");
  return ["INFO", s ? "yes: oracle_call is free" : "no: attach 0.01+ NEAR per uncached call (docs: 1 yocto if cached)"];
});
await check("intents.near deployed and answers mt_balance_of", async () => {
  const a = await account("intents.near");
  const bal = await view<string>("intents.near", "mt_balance_of", { account_id: SOLVER, token_id: WNEAR });
  const fee = await view<number>("intents.near", "fee");
  return [
    isContract(a.code_hash) ? "PASS" : "FAIL",
    `code ${a.code_hash.slice(0, 8)}…, fee ${fee} pips, ${SOLVER} wNEAR ${bal}`,
  ];
});
await check(`intents.near USDC balance of ${SOLVER}`, async () => {
  const bal = await view<string>("intents.near", "mt_balance_of", { account_id: SOLVER, token_id: USDC_NEAR });
  return ["INFO", `${bal} (base units, 6 dp); pre-fund before the first fill`];
});
await check("wrap.near is wNEAR, 24 dp", async () => {
  const m = await view<{ symbol: string; decimals: number }>("wrap.near", "ft_metadata");
  return [m.symbol === "wNEAR" && m.decimals === 24 ? "PASS" : "FAIL", `${m.symbol}, ${m.decimals} dp`];
});
await check(`${USDC_ACCOUNT.slice(0, 10)}… is USDC, 6 dp`, async () => {
  const m = await view<{ symbol: string; decimals: number }>(USDC_ACCOUNT, "ft_metadata");
  return [m.symbol === "USDC" && m.decimals === 6 ? "PASS" : "FAIL", `${m.symbol}, ${m.decimals} dp`];
});
await check(`USDC storage bound (${USDC_ACCOUNT.slice(0, 10)}…)`, async () => {
  const b = await view<{ min: string }>(USDC_ACCOUNT, "storage_balance_bounds");
  return ["INFO", `storage_deposit min ${near(BigInt(b.min))}`];
});
await check(`mainnet ids free: ${OWNER}, ${SOLVER}`, async () => {
  const taken: string[] = [];
  for (const id of [OWNER, SOLVER]) {
    try {
      await account(id);
      taken.push(id);
    } catch (e) {
      if (!String((e as Error).message).includes("UNKNOWN_ACCOUNT")) throw e;
    }
  }
  return ["INFO", taken.length ? `exists already: ${taken.join(", ")}` : "both unclaimed"];
});
await check("protocol storage and gas price", async () => {
  const cfg = await rpc<{ runtime_config: { storage_amount_per_byte: string } }>("EXPERIMENTAL_protocol_config", {
    finality: "final",
  });
  const gp = await rpc<{ gas_price: string }>("gas_price", [null]);
  const perByte = BigInt(cfg.runtime_config.storage_amount_per_byte);
  // 100 Tgas at the current price, the ceiling of any one arena call (sandbox max is ~5 Tgas).
  return [
    "INFO",
    `${near(perByte * 100_000n)} per 100 KB; gas ${gp.gas_price} yocto/gas = ${near(BigInt(gp.gas_price) * 10n ** 14n)} per 100 Tgas`,
  ];
});

// ---- 1Click: the rail ---------------------------------------------------------------------------------------
await check("1Click /v0/tokens lists wNEAR and USDC on near", async () => {
  const r = await fetch(`${process.env.ONECLICK_URL ?? "https://1click.chaindefuser.com"}/v0/tokens`);
  if (!r.ok) throw new Error(`tokens ${r.status}`);
  const t = (await r.json()) as { assetId: string; symbol: string; blockchain: string; decimals: number }[];
  const w = t.find((x) => x.assetId === WNEAR);
  const u = t.find((x) => x.assetId === USDC_NEAR);
  return [
    w && u ? "PASS" : "FAIL",
    `${w ? `${w.symbol}/${w.blockchain}` : "wNEAR missing"}, ${u ? `${u.symbol}/${u.blockchain}/${u.decimals}dp` : "USDC missing"}`,
  ];
});
await check("1Click dry quote, depositType INTENTS", async () => {
  const q = await quote(sellNearForUsdc(FILL_YOCTO, SOLVER, true));
  const k = q.quote;
  const jwt = process.env.ONECLICK_JWT ? "partner key" : "no key (+25 bps)";
  return [
    k.amountOut ? "PASS" : "FAIL",
    `${k.amountInFormatted} wNEAR -> ${k.amountOutFormatted} USDC, min ${k.minAmountOut}, timeEstimate ${k.timeEstimate} s, ${jwt}`,
  ];
});

// ---- NEAR AI Cloud: the enclave tier ------------------------------------------------------------------------
// Both endpoints answered without a key on 2026-11-06; the key is sent when present in case that changes.
const auth: Record<string, string> = NEAR_AI_KEY ? { Authorization: `Bearer ${NEAR_AI_KEY}` } : {};
await check("NEAR AI models owned_by nearai", async () => {
  const r = await fetch(`${NEAR_AI}/models`, { headers: auth });
  if (r.status === 401 || r.status === 403) return ["SKIP", `models ${r.status}: set NEAR_AI_API_KEY`];
  if (!r.ok) throw new Error(`models ${r.status}`);
  const list = ((await r.json()) as { data: { id: string; owned_by: string }[] }).data;
  const got = MODELS.map((m) => `${m}=${list.find((x) => x.id === m)?.owned_by ?? "absent"}`);
  return [got.every((g) => g.endsWith("=nearai")) ? "PASS" : "FAIL", got.join(", ")];
});
for (const m of MODELS) {
  await check(`NEAR AI attestation ${m.split("/")[1] ?? m} (ed25519, fresh nonce)`, async () => {
    const nonce = randomBytes(32).toString("hex");
    const u = `${NEAR_AI}/attestation/report?model=${encodeURIComponent(m)}&signing_algo=ed25519&nonce=${nonce}`;
    const r = await fetch(u, { headers: auth });
    if (r.status === 401 || r.status === 403) return ["SKIP", `attestation ${r.status}: set NEAR_AI_API_KEY`];
    if (!r.ok) throw new Error(`attestation ${r.status}`);
    const rep = (await r.json()) as { model_attestations?: { signing_address?: string; request_nonce?: string }[] };
    const atts = rep.model_attestations ?? [];
    const bound = atts.length > 0 && atts.every((a) => a.request_nonce === nonce);
    // Already trusted on ARENA_CONTRACT? A new address means the enclave rotated: re-verify before pinning.
    const pinned = await Promise.all(
      atts.map(async (a) => {
        const b64 = Buffer.from(a.signing_address ?? "", "hex").toString("base64");
        const res = await fetch(process.env.NEAR_RPC ?? "https://near-testnet.drpc.org", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "query",
            params: {
              request_type: "call_function",
              finality: "final",
              account_id: process.env.ARENA_CONTRACT ?? "arena.nearbuddy-solver.testnet",
              method_name: "is_tee_signer",
              args_base64: Buffer.from(JSON.stringify({ signer: b64 })).toString("base64"),
            },
          }),
        });
        const j = (await res.json()) as { result?: { result?: number[] } };
        const v = j.result?.result ? Buffer.from(j.result.result).toString() : "?";
        return `${a.signing_address?.slice(0, 12)}… pinned=${v}`;
      }),
    );
    return [bound ? "PASS" : "FAIL", `${atts.length} signer(s), nonce echoed ${bound}; ${pinned.join(", ")}`];
  });
}

// ---- the arena: deploy 15 (verified settlement) -------------------------------------------------------------
// Read from ARENA_CONTRACT (testnet arena by default) on NEAR_RPC, else the network table's RPC for the arena's
// network. On testnet an arena without deploy 15 reports "not deployed" (SKIP); on a mainnet arena (an id ending in
// .near) that is a FAIL and the mainnet values are required.
const ARENA = process.env.ARENA_CONTRACT ?? NETWORKS.testnet.arena;
const ON_MAINNET = ARENA.endsWith(".near");
const ARENA_RPC = process.env.NEAR_RPC ?? NETWORKS[ON_MAINNET ? "mainnet" : "testnet"].rpc;
// The testnet stand-in for intents.near that deploy 15 is migrated with (scripts/deploy15-testnet.sh).
const INTENTS_STUB = process.env.INTENTS_STUB ?? "intents-stub.nearbuddy-solver.testnet";
const MAX_VAULT_MAINNET = 27n * 10n ** 24n; // the week-4 cap: 100 USDC total
type V15Config = {
  owner: string;
  oracle_account: string;
  intent_lock_s: number;
  min_duel_s: number;
  next_duel: string;
  intents_account?: string;
  migrating?: boolean;
  paused?: boolean;
  withdraw_delay_s?: number;
  max_vault_total?: string;
  vault_total?: string;
};
const arenaCfg = await view<V15Config>(ARENA, "get_config", {}, ARENA_RPC).catch(() => null);
const v15 = typeof arenaCfg?.intents_account === "string";
const notDeployed = (): [Row["result"], string] => [
  ON_MAINNET ? "FAIL" : "SKIP",
  arenaCfg ? "not deployed: get_config has no intents_account (deploy 14 or earlier)" : `cannot read ${ARENA}`,
];
const v15check = (name: string, fn: (c: V15Config) => Promise<[Row["result"], string]>) =>
  check(`${ARENA} ${name}`, async () => (v15 && arenaCfg ? fn(arenaCfg) : notDeployed()));

await v15check("deploy 15: intents_account", async (c) => {
  const want = ON_MAINNET ? "intents.near" : INTENTS_STUB;
  return [c.intents_account === want ? "PASS" : "FAIL", ` (want )`];
});
await v15check("deploy 15: intents_account answers mt_batch_balance_of for the arena", async (c) => {
  const b = await view<string[]>(
    c.intents_account!,
    "mt_batch_balance_of",
    { account_id: ARENA, token_ids: [USDC_NEAR, WNEAR] },
    ARENA_RPC,
  );
  return ["PASS", `arena holds USDC ${b[0]}, wNEAR ${b[1]} on ${c.intents_account}`];
});
await v15check("deploy 15: follows re-keyed (migrating false)", async (c) => [
  c.migrating === false ? "PASS" : "FAIL",
  `migrating ${c.migrating}; until false, follow/unfollow/settle refuse "migrating" (run migrate_follows)`,
]);
await v15check("deploy 15: not paused", async (c) => [c.paused ? "FAIL" : "PASS", `paused ${c.paused}`]);
await v15check("deploy 15: delayed vault withdraw", async (c) => [
  (c.withdraw_delay_s ?? 0) >= 900 ? "PASS" : "FAIL",
  `withdraw_delay_s ${c.withdraw_delay_s} (at least 900, twice the settle lag)`,
]);
await v15check("deploy 15: vault cap", async (c) => {
  const cap = BigInt(c.max_vault_total ?? "0");
  const ok = ON_MAINNET ? cap > 0n && cap <= MAX_VAULT_MAINNET : cap > 0n;
  return [
    ok ? "PASS" : "FAIL",
    `max_vault_total ${near(cap)}, vault_total ${near(BigInt(c.vault_total ?? "0"))}${ON_MAINNET ? `, mainnet cap ${near(MAX_VAULT_MAINNET)}` : ""}`,
  ];
});
await v15check("deploy 15: register domain v2 (contract id bound)", async (c) => {
  const m = Buffer.from(
    await view<string>(ARENA, "register_message", { owner: c.owner }, ARENA_RPC),
    "base64",
  ).toString();
  const want = `nearbuddy-register-v2${ARENA}\u0000${c.owner}`;
  return [m === want ? "PASS" : "FAIL", JSON.stringify(m).slice(0, 90)];
});
await v15check("deploy 15: duel_lock readable", async (c) => {
  const last = Number(c.next_duel) - 1;
  if (last < 0) return ["SKIP", "no duel yet"];
  const lock = await view<string | null>(ARENA, "duel_lock", { duel_id: String(last) }, ARENA_RPC);
  return [
    lock !== null ? "PASS" : "FAIL",
    `duel ${last}: lock ${lock === null ? "null" : `${Number(BigInt(lock) / 10n ** 9n)} s`}`,
  ];
});
await v15check("deploy 15: leaderboard pages, list_followers gone", async () => {
  const page = await view<unknown[]>(ARENA, "leaderboard", { from: 0, limit: 1 }, ARENA_RPC);
  // gone only on a MethodNotFound answer; any other error (RPC down, bad args) says nothing either way
  const gone = await view(ARENA, "list_followers", { agent_pk: "" }, ARENA_RPC).then(
    () => false,
    (e) => {
      if (/MethodNotFound/.test(String((e as Error).message ?? e))) return true;
      throw e;
    },
  );
  return [
    page.length <= 1 && gone ? "PASS" : "FAIL",
    `leaderboard(0, 1) gave ${page.length}; list_followers ${gone ? "absent" : "still exported"}`,
  ];
});
// Not deploy-15 specific: the lock the arena runs must outlast the cache window of the oracle it reads.
await check(`${ARENA} intent lock vs its oracle's recency window`, async () => {
  if (!arenaCfg) throw new Error(`cannot read ${ARENA} get_config`);
  const d = await view<{ recency_duration_sec: number }>(
    arenaCfg.oracle_account,
    "get_price_data",
    { asset_ids: ["wrap.near"] },
    ARENA_RPC,
  );
  const ok = arenaCfg.intent_lock_s > d.recency_duration_sec;
  return [
    ok ? "PASS" : ON_MAINNET ? "FAIL" : "INFO",
    `intent_lock_s ${arenaCfg.intent_lock_s}, min_duel_s ${arenaCfg.min_duel_s}, ${arenaCfg.oracle_account} recency ${d.recency_duration_sec} s${ok ? "" : " (an agent can post with the close price knowable; known testnet limit)"}`,
  ];
});

// ---- table --------------------------------------------------------------------------------------------------
const w = Math.max(...rows.map((r) => r.check.length));
console.log(`mainnet readiness ${new Date().toISOString()} rpc ${RPC}`);
for (const r of rows) console.log(`${r.result.padEnd(4)}  ${r.check.padEnd(w)}  ${r.detail}`);
const fails = rows.filter((r) => r.result === "FAIL").length;
console.log(
  `${rows.filter((r) => r.result === "PASS").length} pass, ${fails} fail, ${rows.filter((r) => r.result === "SKIP").length} skip`,
);
process.exit(fails ? 1 : 0);
