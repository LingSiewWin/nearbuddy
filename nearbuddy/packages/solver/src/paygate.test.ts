import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Account } from "near-api-js";
import { hashMessage, hashTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { GateRefused, gateSigner } from "./paygate.ts";

// Shared with paygate/src/lib.rs, which builds the same digests in the contract.
const W = JSON.parse(readFileSync(new URL("../../../fixtures/wire-vectors.json", import.meta.url), "utf8"));
const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
const typed = (from: string) => ({
  domain: W.payment.domain,
  types,
  primaryType: "TransferWithAuthorization",
  message: { ...W.payment.message, from },
});

test("the payment and sign-in digests match the shared vectors", () => {
  assert.equal(
    hashTypedData(typed(W.payment.message.from) as Parameters<typeof hashTypedData>[0]),
    W.payment.digest_hex,
  );
  assert.equal(hashMessage(W.login.message), W.login.digest_hex);
});

/** A stand-in for the contract plus the MPC network: signs whatever digest `digestOf(args)` names with `key`. */
function fakeAgent(key: `0x${string}`, digestOf: (args: Record<string, string>) => `0x${string}`) {
  const calls: { methodName: string; args: Record<string, string> }[] = [];
  const agent = {
    callFunctionRaw: async (p: { methodName: string; args: Record<string, string> }) => {
      calls.push(p);
      const s = await sign({ hash: digestOf(p.args), privateKey: key });
      const mpc = { big_r: { affine_point: `02${s.r.slice(2)}` }, s: { scalar: s.s.slice(2) }, recovery_id: s.yParity };
      return {
        transaction: { hash: "NEARTX" },
        status: { SuccessValue: Buffer.from(JSON.stringify(mpc)).toString("base64") },
      };
    },
  } as unknown as Account;
  return { agent, calls };
}

test("gateSigner sends the payment fields, not a hash, and returns a signature from the payer", async () => {
  const key = generatePrivateKey();
  const payer = privateKeyToAccount(key).address;
  const t = typed(payer);
  const { agent, calls } = fakeAgent(key, () => hashTypedData(t as Parameters<typeof hashTypedData>[0]));
  const sig = await gateSigner(agent, "gate.testnet", payer).signTypedData(t);
  assert.equal(sig.length, 132);
  assert.deepEqual(calls[0], {
    contractId: "gate.testnet",
    methodName: "sign_payment",
    args: {
      to: W.payment.message.to,
      value: "1310000",
      valid_after: "0",
      valid_before: "1794567890",
      nonce: W.payment.message.nonce,
    },
    gas: calls[0] && (calls[0] as unknown as { gas: bigint }).gas,
    deposit: 0n,
  });
});

test("gateSigner rejects a signature over any other digest", async () => {
  const key = generatePrivateKey();
  const payer = privateKeyToAccount(key).address;
  const { agent } = fakeAgent(key, () => `0x${"11".repeat(32)}`);
  await assert.rejects(gateSigner(agent, "gate.testnet", payer).signTypedData(typed(payer)), /disagree on the digest/);
});

test("gateSigner refuses to ask for anything but a payment from the payer", async () => {
  const key = generatePrivateKey();
  const payer = privateKeyToAccount(key).address;
  const { agent, calls } = fakeAgent(key, () => `0x${"11".repeat(32)}`);
  const gate = gateSigner(agent, "gate.testnet", payer);
  assert.throws(() => gate.signTypedData({ ...typed(payer), primaryType: "Permit" }), /TransferWithAuthorization only/);
  assert.throws(() => gate.signTypedData(typed(W.payment.message.from)), /not from the paygate payer/);
  assert.equal(calls.length, 0);
});

test("a contract panic surfaces as GateRefused with the transaction hash", async () => {
  const agent = {
    callFunctionRaw: async () => {
      throw Object.assign(new Error("Smart contract panicked: the payment is above the per-payment cap"), {
        transactionResult: { transaction: { hash: "REFUSEDTX" } },
      });
    },
  } as unknown as Account;
  const payer = privateKeyToAccount(generatePrivateKey()).address;
  await assert.rejects(gateSigner(agent, "gate.testnet", payer).signTypedData(typed(payer)), (e: unknown) => {
    assert.ok(e instanceof GateRefused);
    assert.equal(e.nearTx, "REFUSEDTX");
    assert.match(e.message, /above the per-payment cap/);
    return true;
  });
});
