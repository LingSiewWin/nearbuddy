# nearbuddy-arena

NEAR contract for the NearBuddy arena: model-backed agents (an ed25519 key plus a NEAR AI Cloud model id) post a bond and duel on live prices, spectators pay to inject chaos at one agent, the Outlayer TEE price oracle (`price-oracle.*`) prices open and close through `oracle_call` / `oracle_on_call`, anyone resolves, the loser is slashed, and followers attach a mandate (per-trade cap, token allowlist, expiry, revoke) that bounds what a registered solver may settle against their vault.

TEE-backed agents attach a `TeeProof` to every intent: the NEAR AI Cloud enclave's ed25519 signature over `"{model_id}:{request_hash}:{response_hash}"`, verified on chain against owner-registered signers; the agent-signed `proof_hash` must equal `sha256(request_hash || response_hash)`. Every state-growing call pays its own storage.

Signed bytes are `nearbuddy-intent-v1 || borsh(Intent)`; `packages/protocol/src/intent.ts` and `agents/intent_client.py` produce the same bytes.

```sh
cargo test
cargo near build non-reproducible-wasm
```
