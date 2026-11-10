// NearBuddy end-to-end demo, terminal UI.
// 1. owner locks NEAR in vault, 2. solver stakes, 3. owner issues mandate to a fresh agent key,
// 4. agent (no account, no balance) buys N paid API calls via 402 + IOU, 5. solver settles all in ONE tx.
import { type ChildProcess, spawn } from "node:child_process";
import { teraToGas } from "near-api-js";
import {
  CONTRACT,
  explorerTx,
  fmtNear,
  getMandate,
  getSolver,
  getVault,
  loadAccount,
  provider,
  type SettlementReport,
} from "../../protocol/src/chain.ts";
import { Agent, type SignedIou } from "../../protocol/src/index.ts";
import {
  decodeHeader,
  encodeHeader,
  HEADERS,
  type PaymentPayload,
  type PaymentRequired,
  X402_VERSION,
  type SettlementResponse as X402Settlement,
} from "../../protocol/src/x402.ts";

const OWNER = process.env.OWNER_ID ?? "nearbuddy-owner.testnet";
const SOLVER = process.env.SOLVER_ID ?? "nearbuddy-solver.testnet";
const API = process.env.API_ID ?? "nearbuddy-api.testnet";
const CALLS = Number(process.env.CALLS ?? 100);
const API_URL = "http://127.0.0.1:4010";
const SOLVER_URL = "http://127.0.0.1:4020";
const PRICE = 50_000_000_000_000_000_000n; // 0.00005 NEAR, must match resource server

const W = 100;
const line = (ch = "─") => ch.repeat(W);
const box = (title: string, rows: string[]) => {
  console.log(`┌${line()}┐`);
  console.log(`│ ${title.padEnd(W - 1)}│`);
  console.log(`├${line()}┤`);
  for (const r of rows) console.log(`│ ${r.padEnd(W - 1).slice(0, W - 1)}│`);
  console.log(`└${line()}┘`);
};
const step = (n: number, s: string) => console.log(`\n[${n}] ${s}`);
const bar = (i: number, n: number) => {
  const f = Math.round((i / n) * 40);
  return `${"█".repeat(f)}${"░".repeat(40 - f)} ${i}/${n}`;
};

async function waitPort(url: string) {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`service not up: ${url}`);
}

async function main() {
  console.clear?.();
  box("NEARBUDDY  ·  zero-balance credit clearinghouse for AI agents  ·  NEAR testnet", [
    `contract  ${CONTRACT}`,
    `owner     ${OWNER}`,
    `solver    ${SOLVER}`,
    `api/payee ${API}`,
  ]);

  const kids: ChildProcess[] = [];
  for (const pkg of ["solver", "resource-server"]) {
    const p = spawn("bun", [`packages/${pkg}/src/index.ts`], { stdio: ["ignore", "pipe", "inherit"] });
    p.stdout?.on("data", (d) => process.stdout.write(`    ${String(d).trim()}\n`));
    kids.push(p);
  }
  process.on("exit", () => {
    for (const k of kids) k.kill();
  });
  await waitPort(`${SOLVER_URL}/ledger`);
  await waitPort(`${API_URL}/quote`);

  const owner = loadAccount(OWNER);
  const solverAcc = loadAccount(SOLVER);
  const balApi0 = BigInt((await provider.viewAccount({ accountId: API })).amount);

  step(1, `owner locks NEAR in vault (money never leaves the owner's vault until settlement)`);
  let vault = await getVault(OWNER);
  if (!vault || BigInt(vault.balance) < 10n ** 23n) {
    const r = await owner.callFunctionRaw({
      contractId: CONTRACT,
      methodName: "deposit",
      args: {},
      deposit: 10n ** 24n,
      gas: teraToGas("30"),
    });
    console.log(`    deposit 1 NEAR  tx ${explorerTx(r.transaction.hash)}`);
    vault = await getVault(OWNER);
  }
  console.log(`    vault balance: ${fmtNear(vault!.balance)} NEAR`);

  step(2, `solver stakes (backs every IOU it underwrites)`);
  let solver = await getSolver(SOLVER);
  if (!solver) {
    const r = await solverAcc.callFunctionRaw({
      contractId: CONTRACT,
      methodName: "register_solver",
      args: {},
      deposit: 5n * 10n ** 23n,
      gas: teraToGas("30"),
    });
    console.log(`    stake 0.5 NEAR  tx ${explorerTx(r.transaction.hash)}`);
    solver = await getSolver(SOLVER);
  }
  console.log(
    `    solver stake: ${fmtNear(solver!.stake)} NEAR, fees earned so far: ${fmtNear(solver!.fees_earned)}, IOUs settled: ${solver!.ious_settled}`,
  );

  step(3, `owner issues a mandate to a brand-new agent key (agent has NO account, NO balance)`);
  const agent = new Agent();
  const allowance = PRICE * BigInt(CALLS) * 2n;
  const expires = (BigInt(Date.now()) * 1_000_000n + 3_600n * 1_000_000_000n).toString();
  const r3 = await owner.callFunctionRaw({
    contractId: CONTRACT,
    methodName: "issue_mandate",
    gas: teraToGas("30"),
    args: {
      agent_pk: agent.pkB64,
      allowance: allowance.toString(),
      per_tx_cap: (PRICE * 2n).toString(),
      allowed_payees: [API],
      expires_at: expires,
    },
  });
  console.log(`    agent key   ${agent.pkString}   (base64, as get_mandate takes it: ${agent.pkB64})`);
  console.log(
    `    allowance   ${fmtNear(allowance)} NEAR, per-IOU cap ${fmtNear(PRICE * 2n)} NEAR, payees [${API}], expires in 1h`,
  );
  console.log(`    mandate tx  ${explorerTx(r3.transaction.hash)}`);

  step(4, `agent buys ${CALLS} paid API calls over x402 v2: GET -> 402 -> sign IOU -> retry -> 200  (no chain tx)`);
  const t0 = Date.now();
  let last: { pair: string; price: number } | null = null;
  let keep: SignedIou | null = null; // one accepted IOU, reused in the attack step
  const pairs = ["NEAR/USD", "BTC/USD", "ETH/USD"];
  let terms!: PaymentRequired["accepts"][number];
  let lastReceipt: X402Settlement | null = null;
  for (let i = 1; i <= CALLS; i++) {
    const pair = pairs[i % 3]!;
    const first = await fetch(`${API_URL}/quote?pair=${encodeURIComponent(pair)}`);
    if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
    const required = decodeHeader<PaymentRequired>(first.headers.get(HEADERS.required)!);
    terms = required.accepts[0]!;
    const signed: SignedIou = agent.sign({
      owner: OWNER,
      payee: terms.payTo,
      amount: terms.amount,
      expires_at: expires,
    });
    const pp: PaymentPayload = { x402Version: X402_VERSION, accepted: terms, payload: signed };
    const paid = await fetch(`${API_URL}/quote?pair=${encodeURIComponent(pair)}`, {
      headers: { [HEADERS.signature]: encodeHeader(pp) },
    });
    if (paid.status !== 200) throw new Error(`call ${i} failed: ${paid.status} ${await paid.text()}`);
    lastReceipt = decodeHeader<X402Settlement>(paid.headers.get(HEADERS.response)!);
    keep ??= signed;
    last = (await paid.json()) as typeof last;
    process.stdout.write(`\r    ${bar(i, CALLS)}  ${pair} = ${last!.price}   `);
  }
  const ms = Date.now() - t0;
  console.log(
    `\n    ${CALLS} calls in ${ms} ms (${(ms / CALLS).toFixed(1)} ms/call), 0 chain transactions, agent balance still 0`,
  );
  console.log(
    `    x402 v2: 402 PAYMENT-REQUIRED scheme=${terms.scheme} network=${terms.network}  ->  PAYMENT-SIGNATURE  ->  200 PAYMENT-RESPONSE ${JSON.stringify(lastReceipt?.extra)}`,
  );
  const ledger = (await (await fetch(`${SOLVER_URL}/ledger`)).json()) as { carrying: number };
  console.log(
    `    solver is carrying ${ledger.carrying} unsettled IOUs worth ${fmtNear(PRICE * BigInt(ledger.carrying))} NEAR`,
  );

  if (process.env.SKIP_SETTLE) {
    console.log("    SKIP_SETTLE set: leaving IOUs carried by the solver (test persistence / auto-settle)");
    process.exit(0);
  }
  step(5, `solver settles everything in ONE transaction`);
  const settleRes = await fetch(`${SOLVER_URL}/settle`, { method: "POST" });
  const settleBody = await settleRes.text();
  if (!settleRes.ok) throw new Error(`settle failed: ${settleBody}`);
  const s = JSON.parse(settleBody) as { txHash: string; report: SettlementReport; count: number; gasTgas: number };
  const vaultAfter = (await getVault(OWNER))!;
  const mandate = (await getMandate(agent.pkB64))!;
  const solverAfter = (await getSolver(SOLVER))!;
  const balApi1 = BigInt((await provider.viewAccount({ accountId: API })).amount);
  box("SETTLEMENT", [
    `tx            ${explorerTx(s.txHash)}`,
    `IOUs in batch ${s.count}   settled ${s.report.settled}   rejected ${s.report.rejected.length}   gas ${s.gasTgas.toFixed(2)} TGas (${(s.gasTgas / s.count).toFixed(3)} TGas/IOU)`,
    `total paid    ${fmtNear(s.report.total_paid)} NEAR   solver fee ${fmtNear(s.report.solver_fee)} NEAR   covered by solver stake ${fmtNear(s.report.covered_by_solver)}`,
    `vault         ${fmtNear(vault!.balance)} -> ${fmtNear(vaultAfter.balance)} NEAR`,
    `mandate spent ${fmtNear(mandate.spent)} / ${fmtNear(mandate.allowance)} NEAR`,
    `api received  +${fmtNear(balApi1 - balApi0)} NEAR (net of fee)`,
    `solver        stake ${fmtNear(solverAfter.stake)} NEAR, lifetime IOUs ${solverAfter.ious_settled}`,
  ]);
  if (s.report.rejected.length) console.log("    rejected:", s.report.rejected);

  step(6, `attacks: a hijacked agent and a dishonest solver both bounce off the mandate`);
  const tryApi = async (label: string, signed: SignedIou) => {
    const r = await fetch(`${API_URL}/quote?pair=NEAR/USD`, {
      headers: {
        [HEADERS.signature]: encodeHeader({
          x402Version: X402_VERSION,
          accepted: terms,
          payload: signed,
        } satisfies PaymentPayload),
      },
    });
    const body = (await r.json()) as { error?: string };
    console.log(`    ${label.padEnd(44)} -> HTTP ${r.status}  ${body.error ?? "accepted"}`);
  };
  await tryApi(
    "over per-IOU cap (3x price)",
    agent.sign({ owner: OWNER, payee: API, amount: (PRICE * 3n).toString(), expires_at: expires }),
  );
  await tryApi("replay an already-settled IOU", keep!);
  const forged: SignedIou = { ...keep!, iou: { ...keep!.iou, nonce: (BigInt(keep!.iou.nonce) + 10_000n).toString() } };
  await tryApi("forged IOU (new nonce, old signature)", forged);
  const stranger = new Agent();
  await tryApi(
    "unknown agent key (no mandate)",
    stranger.sign({ owner: OWNER, payee: API, amount: PRICE.toString(), expires_at: expires }),
  );
  console.log(`    dishonest solver submits the replay + the forgery straight to the contract ...`);
  const r6 = await solverAcc.callFunctionRaw({
    contractId: CONTRACT,
    methodName: "settle_batch",
    args: { ious: [keep, forged] },
    gas: teraToGas("100"),
  });
  const rep6 = JSON.parse(
    Buffer.from((r6.status as { SuccessValue: string }).SuccessValue, "base64").toString(),
  ) as SettlementReport;
  console.log(
    `    contract: settled ${rep6.settled}, rejected ${rep6.rejected.map((x) => `#${x.index} ${x.reason}`).join(", ")}   tx ${explorerTx(r6.transaction.hash)}`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("\nDEMO FAILED:", e);
  process.exit(1);
});
