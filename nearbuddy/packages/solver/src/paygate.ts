// Signer for the paygate contract (nearbuddy/paygate): the payment key lives in NEAR Chain Signatures and the
// contract signs with it only inside the owner's policy. The agent's NEAR key can be a function-call access key
// limited to `sign_payment` and `sign_login` on that contract; it pays gas only.
import type { Account } from "near-api-js";
import { teraToGas } from "near-api-js";
import { type Hex, hashMessage, hashTypedData, recoverAddress, serializeSignature } from "viem";
import type { PaygateCalls } from "../../protocol/src/abi/paygate.ts";
import type { TeeProof } from "../../protocol/src/intent.ts";

export interface GateSigner {
  /** The EVM address the contract's derived key controls. It holds the stablecoin. */
  readonly address: Hex;
  /** Signs an EIP-3009 TransferWithAuthorization (what an x402 "exact" payment carries), if the policy allows it. */
  signTypedData(typed: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
  /** Signs a sign-in message for a domain the policy lists. */
  signMessage(args: { message: string }): Promise<Hex>;
}

/** The contract refused, or the MPC network did not sign. `nearTx` is the evidence either way. */
export class GateRefused extends Error {
  constructor(
    readonly reason: string,
    readonly nearTx: string | undefined,
  ) {
    super(`paygate refused: ${reason}${nearTx ? ` (NEAR tx ${nearTx})` : ""}`);
  }
}

interface MpcSignature {
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
}

export function gateSigner(
  agent: Account,
  contractId: string,
  account: { owner: string; payer: Hex },
  decision?: { model: string; proof: TeeProof },
  log: (s: string) => void = () => {},
  /** Called once per successful signature with the NEAR transaction that carried it. */
  onTx?: (method: "sign_payment" | "sign_login", nearTx: string) => void,
  /** Called before `GateRefused` is thrown, with the refused transaction (when there is one) and the contract's reason.
   *  The payment library catches the signer's error and rethrows its own text without the original, so a caller that
   *  needs the evidence takes it from here, not from the error. */
  onRefused?: (method: "sign_payment" | "sign_login", nearTx: string | undefined, reason: string) => void,
): GateSigner {
  const { owner, payer } = account;
  async function sign<M extends "sign_payment" | "sign_login">(
    methodName: M,
    args: PaygateCalls[M]["args"],
    digest: Hex,
  ): Promise<Hex> {
    const t0 = Date.now();
    const refuse = (reason: string, nearTx: string | undefined) => {
      onRefused?.(methodName, nearTx, reason);
      return new GateRefused(reason, nearTx);
    };
    let result: Awaited<ReturnType<Account["callFunctionRaw"]>>;
    try {
      result = await agent.callFunctionRaw({ contractId, methodName, args, gas: teraToGas("300"), deposit: 0n });
    } catch (e) {
      // near-api-js throws ContractExecutionError when the contract panics; the panic text is the policy's refusal
      // and the failed transaction stays on chain as the record of it.
      const hash = (e as { transactionResult?: { transaction?: { hash?: string } } }).transactionResult?.transaction
        ?.hash;
      throw refuse(((e as Error).message ?? String(e)).split("\n")[0]!.slice(0, 300), hash);
    }
    const nearTx = result.transaction.hash;
    const status = result.status as { SuccessValue?: string; Failure?: unknown };
    if (status.SuccessValue === undefined) throw refuse(JSON.stringify(status.Failure ?? status).slice(0, 300), nearTx);
    const sig = JSON.parse(Buffer.from(status.SuccessValue, "base64").toString()) as MpcSignature | null;
    if (!sig) throw refuse("the MPC network did not sign", nearTx);
    // The signature exists and the contract has spent the decision and allowance: report it before any check of ours.
    onTx?.(methodName, nearTx);
    const signature = {
      r: `0x${sig.big_r.affine_point.slice(2)}` as Hex,
      s: `0x${sig.s.scalar}` as Hex,
      yParity: sig.recovery_id,
    };
    // The contract built the digest itself; if ours differs, the signature is for something else.
    const signer = await recoverAddress({ hash: digest, signature });
    if (signer.toLowerCase() !== payer.toLowerCase())
      throw new Error(
        `paygate signature recovers to ${signer}, expected ${payer}: client and contract disagree on the digest`,
      );
    log(`paygate ${methodName}: NEAR tx ${nearTx} (${Date.now() - t0} ms)`);
    return serializeSignature(signature);
  }

  return {
    address: payer,
    signTypedData(typed) {
      if (typed.primaryType !== "TransferWithAuthorization")
        throw new Error(`paygate signs TransferWithAuthorization only, not ${typed.primaryType}`);
      const m = typed.message as Record<string, string | bigint>;
      if (String(m.from).toLowerCase() !== payer.toLowerCase())
        throw new Error("the payment is not from the paygate payer");
      if (!decision) throw new Error("a payment needs a decision");
      return sign(
        "sign_payment",
        {
          owner,
          to: String(m.to),
          value: String(m.value),
          valid_after: String(m.validAfter),
          valid_before: String(m.validBefore),
          nonce: String(m.nonce),
          model_id: decision.model,
          decision: decision.proof,
        },
        hashTypedData(typed as Parameters<typeof hashTypedData>[0]),
      );
    },
    signMessage({ message }) {
      return sign("sign_login", { owner, message }, hashMessage(message));
    },
  };
}
