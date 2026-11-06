// Guarantor demo: one self-custody wallet on Sepolia, a card issuer that must answer in seconds,
// and NearBuddy in between. Two runs:
//   A. swipe -> cert -> pull succeeds (signed by the NEAR contract via Chain Signatures) -> settle: fee accrues
//   B. swipe -> cert -> wallet drained before the pull -> pull fails -> settle: issuer paid from the reserve
// Needs Sepolia ETH on the puller and the user wallet, and Sepolia USDC on the user wallet (see plan.md).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createWalletClient, formatUnits, type Hex, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { SignedCert } from "../../protocol/src/cert.ts";
import { CONTRACT, explorerTx, fmtNear, provider } from "../../protocol/src/chain.ts";
import type { IssuerReserve, PullReport } from "../../solver/src/guarantor.ts";
import { erc20, evm, PULLER, SEPOLIA_RPC, USDC } from "../../solver/src/pull.ts";

const ISSUER = process.env.ISSUER_ID ?? "nearbuddy-api.testnet";
const SOLVER_URL = "http://127.0.0.1:4020";
const AMOUNT = parseUnits(process.env.PULL_USDC ?? "1", 6);
const secrets = (f: string) =>
  (
    JSON.parse(readFileSync(new URL(`../../../.secrets/${f}`, import.meta.url), "utf8")) as {
      address: Hex;
      private_key: Hex;
    }[]
  )[0]!;
const user = secrets("user-wallet.json"),
  issuerEvm = secrets("issuer-wallet.json");
const userAcc = privateKeyToAccount(user.private_key);
const userWallet = createWalletClient({ account: userAcc, chain: sepolia, transport: http(SEPOLIA_RPC) });
const sep = (h: string) => `https://sepolia.etherscan.io/tx/${h}`;

const W = 100;
const line = (ch = "─") => ch.repeat(W);
const box = (title: string, rows: string[]) => {
  console.log(`┌${line()}┐\n│ ${title.padEnd(W - 1)}│\n├${line()}┤`);
  for (const r of rows) console.log(`│ ${r.padEnd(W - 1).slice(0, W - 1)}│`);
  console.log(`└${line()}┘`);
};
const step = (s: string) => console.log(`\n▶ ${s}`);
const post = async <T>(path: string, body: unknown): Promise<T> =>
  (await fetch(`${SOLVER_URL}${path}`, { method: "POST", body: JSON.stringify(body) })).json() as Promise<T>;
const getIssuer = () =>
  provider.callFunction({
    contractId: CONTRACT,
    method: "get_issuer",
    args: { issuer: ISSUER },
  }) as Promise<IssuerReserve | null>;
const usdc = (a: Hex) => evm.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });
const nearBal = async (id: string) => BigInt((await provider.viewAccount({ accountId: id })).amount);

async function swipe(label: string, drainFirst: boolean) {
  step(`${label}: card swiped for ${formatUnits(AMOUNT, 6)} USDC. Issuer asks NearBuddy for a guarantee.`);
  const g = await post<{ ok: true; signed: SignedCert; ms: number } | { ok: false; reason: string; ms: number }>(
    "/guarantee",
    {
      issuer: ISSUER,
      wallet: user.address,
      amount: AMOUNT.toString(),
      payout_to: issuerEvm.address,
    },
  );
  if (!g.ok) throw new Error(`guarantee refused: ${g.reason}`);
  const c = g.signed.cert;
  console.log(
    `  cert in ${g.ms} ms  nonce ${c.nonce}  payout-if-fail ${fmtNear(c.payout)} NEAR  sig ${g.signed.signature.slice(0, 16)}…`,
  );
  console.log(`  issuer approves the authorization. Card network answered. Now the slow part: the on-chain pull.`);
  if (drainFirst) {
    // Leave half a pull behind so the wallet is short but not empty (keeps testnet USDC for reruns).
    const bal = await usdc(user.address);
    const drain = bal - AMOUNT / 2n;
    step(
      `${label}: user drains the wallet before the pull lands (${formatUnits(drain, 6)} of ${formatUnits(bal, 6)} USDC -> 0x…dEaD)`,
    );
    const h = await userWallet.writeContract({
      address: USDC,
      abi: erc20,
      functionName: "transfer",
      args: ["0x000000000000000000000000000000000000dEaD", drain],
    });
    await evm.waitForTransactionReceipt({ hash: h });
    console.log(`  drain tx ${sep(h)}`);
  }
  step(
    `${label}: NearBuddy pulls. NEAR contract -> Chain Signatures MPC -> signed Sepolia transferFrom from puller ${PULLER}`,
  );
  const p = await post<{ ok: boolean; txHash?: string; reason?: string; nearTx?: string; mpcMs?: number }>("/pull", {
    id: `${c.solver}:${c.nonce}`,
  });
  if (p.ok)
    console.log(`  pulled ✔  sepolia ${sep(p.txHash!)}\n  mpc sign ${p.mpcMs} ms  near ${explorerTx(p.nearTx!)}`);
  else
    console.log(
      `  pull FAILED ✘  ${p.reason}${p.txHash ? `\n  sepolia ${sep(p.txHash)}` : ""}${p.nearTx ? `\n  near ${explorerTx(p.nearTx)}` : ""}`,
    );
  step(`${label}: solver settles the outcome on NEAR (settle_pull)`);
  const s = await post<{ txHash: string; report: PullReport; count: number } | { nothing: true }>("/settle_pulls", {});
  if ("nothing" in s) throw new Error("nothing to settle");
  console.log(
    `  tx ${explorerTx(s.txHash)}  settled ${s.report.settled}  paid_out ${fmtNear(s.report.paid_out)} NEAR  fees_accrued ${fmtNear(s.report.fees_accrued)}  rejected ${s.report.rejected.length}`,
  );
  return { pulled: p.ok, settleTx: s.txHash, pullTx: p.txHash };
}

async function main() {
  console.clear?.();
  box("NEARBUDDY GUARANTOR  ·  one wallet, many cards  ·  NEAR testnet + Ethereum Sepolia", [
    `contract ${CONTRACT}   issuer ${ISSUER}   payout -> ${issuerEvm.address}`,
    `user wallet ${user.address}   puller (MPC-derived from contract) ${PULLER}`,
  ]);
  const [uEth, uUsdc, pEth, allowance] = await Promise.all([
    evm.getBalance({ address: user.address }),
    usdc(user.address),
    evm.getBalance({ address: PULLER }),
    evm.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [user.address, PULLER] }),
  ]);
  console.log(
    `\nuser: ${formatUnits(uEth, 18)} ETH, ${formatUnits(uUsdc, 6)} USDC, allowance ${formatUnits(allowance, 6)}   puller: ${formatUnits(pEth, 18)} ETH`,
  );
  if (uEth === 0n || pEth === 0n || uUsdc < AMOUNT * 2n) {
    console.log(
      `\nFUND FIRST (testnet faucets):\n  Sepolia ETH  -> ${PULLER}  (puller gas)\n  Sepolia ETH  -> ${user.address}  (approve + drain gas)\n  Sepolia USDC -> ${user.address}  https://faucet.circle.com`,
    );
    process.exit(1);
  }

  const solver = spawn("bun", ["packages/solver/src/index.ts"], { stdio: ["ignore", "pipe", "inherit"] });
  solver.stdout?.on("data", (d) => process.stdout.write(`    ${String(d).trim()}\n`));
  process.on("exit", () => solver.kill());
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${SOLVER_URL}/guarantor`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  if (allowance < AMOUNT * 2n) {
    step(`user approves the puller once (one approve, any number of cards; funds stay in the wallet)`);
    const h = await userWallet.writeContract({
      address: USDC,
      abi: erc20,
      functionName: "approve",
      args: [PULLER, 2n ** 128n],
    });
    await evm.waitForTransactionReceipt({ hash: h });
    console.log(`  approve tx ${sep(h)}`);
  }

  const ir0 = (await getIssuer())!;
  const issuerNear0 = await nearBal(ISSUER);
  console.log(
    `\nissuer reserve: ${fmtNear(ir0.reserved)} NEAR reserved, ${ir0.pulls_ok} ok / ${ir0.pulls_failed} failed so far`,
  );

  const a = await swipe("RUN A", false);
  const b = await swipe("RUN B", true);

  const ir1 = (await getIssuer())!;
  const issuerNear1 = await nearBal(ISSUER);
  const issuerUsdc = await usdc(issuerEvm.address);
  console.log();
  box("RESULT", [
    `run A  pull ${a.pulled ? "succeeded" : "failed"}   fee accrued to solver   settle ${explorerTx(a.settleTx)}`,
    `run B  pull ${b.pulled ? "succeeded" : "FAILED (wallet drained)"}   issuer paid from reserve   settle ${explorerTx(b.settleTx)}`,
    `issuer reserve ${fmtNear(ir0.reserved)} -> ${fmtNear(ir1.reserved)} NEAR   paid_out ${fmtNear(ir1.paid_out)}   fees_accrued ${fmtNear(ir1.fees_accrued)}`,
    `issuer NEAR balance +${fmtNear(issuerNear1 - issuerNear0)}   issuer USDC received ${formatUnits(issuerUsdc, 6)}`,
    `the issuer was made whole on the failed swipe without trusting the wallet, the chain, or NearBuddy's word.`,
  ]);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
