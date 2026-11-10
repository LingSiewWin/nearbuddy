// A NEAR AI Cloud signature record re-encoded as the contract's `TeeProof`, after checking locally what the contract
// will check (agents/intent_client.py `tee_proof`): the provider enclave (kind 2) signed exactly
// `model:sha256(request):sha256(response)` with ed25519. A record that fails here would fail on chain, so the keeper
// never pays gas for it.
import { b64, unhex } from "../../protocol/src/index.ts";
import { type TeeProof, teeText, verify } from "../../protocol/src/intent.ts";
import type { SigRecord } from "./nearai.ts";

export function teeProofFrom(
  rec: SigRecord,
  model: string,
  requestHash: Uint8Array,
  responseHash: Uint8Array,
): TeeProof {
  if ((rec.signature_kind ?? "provider_tee") !== "provider_tee")
    throw new Error(`signature_kind ${rec.signature_kind}: the contract wants the provider enclave (kind 2)`);
  if ((rec.signing_algo ?? "ed25519") !== "ed25519") throw new Error(`signing_algo ${rec.signing_algo}: need ed25519`);
  const text = teeText(2, model, requestHash, responseHash);
  if (rec.text !== new TextDecoder().decode(text))
    throw new Error(`record text ${JSON.stringify(rec.text).slice(0, 80)} does not match our bytes`);
  const proof: TeeProof = {
    kind: 2,
    request_hash: b64.enc(requestHash),
    response_hash: b64.enc(responseHash),
    signer: b64.enc(unhex(rec.signing_address)),
    signature: b64.enc(unhex(rec.signature)),
  };
  if (!verify(proof.signer, text, proof.signature)) throw new Error("enclave signature does not verify");
  return proof;
}
