// The pull: move `amount` USDC from the payer wallet to the issuer's payout address on Sepolia.
// The transaction is signed by the NearBuddy vault contract through NEAR Chain Signatures: the
// solver builds and hashes the unsigned tx, the contract asks the MPC network to sign the hash,
// the solver attaches r/s/v and broadcasts. The puller address is derived from (contract, path).
import { type Account, teraToGas } from "near-api-js";
import {
  createPublicClient,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  parseAbi,
  serializeTransaction,
} from "viem";
import { sepolia } from "viem/chains";
import { CONTRACT } from "../../protocol/src/chain.ts";

export const SEPOLIA_RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
export const USDC = (process.env.SEPOLIA_USDC ?? "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238") as Hex;
/// MPC-derived address of nearbuddy-vault.testnet at path "sepolia-1":
/// keccak256(derived_public_key(nearbuddy-vault.testnet, "sepolia-1"))[12..]. No one holds its key.
export const PULLER = (process.env.PULLER ?? "0x1a10a02f13144a60a775b6969c01dfDdD3BB4595") as Hex;
export const MPC_PATH = process.env.MPC_PATH ?? "sepolia-1";
export const CHAIN_ID = sepolia.id; // 11155111

export const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const evm = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });

export async function observe(wallet: Hex): Promise<{ balance: bigint; allowance: bigint }> {
  const [balance, allowance] = await Promise.all([
    evm.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [wallet] }),
    evm.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [wallet, PULLER] }),
  ]);
  return { balance, allowance };
}

export interface PullResult {
  ok: boolean;
  txHash?: Hex;
  reason?: string;
  nearTx?: string;
  mpcMs?: number;
}

/** Build, MPC-sign via the contract, broadcast, and wait for the receipt. */
export async function pull(solver: Account, from: Hex, to: Hex, amount: bigint): Promise<PullResult> {
  const data = encodeFunctionData({ abi: erc20, functionName: "transferFrom", args: [from, to, amount] });
  const [nonce, fees] = await Promise.all([
    evm.getTransactionCount({ address: PULLER, blockTag: "pending" }),
    evm.estimateFeesPerGas(),
  ]);
  // Simulate first: a revert here is the "pull failed" path and costs no gas. The estimate also
  // sizes the gas limit (USDC's FiatToken proxy + a fresh recipient slot can exceed a fixed 80k).
  let gas: bigint;
  try {
    gas = await evm.estimateGas({ account: PULLER, to: USDC, data });
  } catch (e) {
    return { ok: false, reason: `simulation reverted: ${(e as Error).message.split("\n")[0]}` };
  }
  const tx = {
    chainId: CHAIN_ID,
    type: "eip1559" as const,
    nonce,
    to: USDC,
    data,
    value: 0n,
    gas: (gas * 13n) / 10n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
  const hash = keccak256(serializeTransaction(tx));
  const t0 = Date.now();
  const r = await solver.callFunctionRaw({
    contractId: CONTRACT,
    methodName: "request_pull_signature",
    args: { payload_hex: hash.slice(2), path: MPC_PATH },
    gas: teraToGas("300"),
    deposit: 1n,
  });
  const mpcMs = Date.now() - t0;
  const st = r.status as { SuccessValue?: string };
  if (!st.SuccessValue)
    return {
      ok: false,
      reason: `MPC signing failed: ${JSON.stringify(r.status).slice(0, 200)}`,
      nearTx: r.transaction.hash,
    };
  const sig = JSON.parse(Buffer.from(st.SuccessValue, "base64").toString()) as {
    big_r: { affine_point: string };
    s: { scalar: string };
    recovery_id: number;
  };
  const signed = serializeTransaction(tx, {
    r: `0x${sig.big_r.affine_point.slice(2)}` as Hex,
    s: `0x${sig.s.scalar}` as Hex,
    yParity: sig.recovery_id,
  });
  try {
    const txHash = await evm.sendRawTransaction({ serializedTransaction: signed });
    const rc = await evm.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    return rc.status === "success"
      ? { ok: true, txHash, nearTx: r.transaction.hash, mpcMs }
      : { ok: false, txHash, reason: "reverted on-chain", nearTx: r.transaction.hash, mpcMs };
  } catch (e) {
    return {
      ok: false,
      reason: `broadcast failed: ${(e as Error).message.split("\n")[0]}`,
      nearTx: r.transaction.hash,
      mpcMs,
    };
  }
}
