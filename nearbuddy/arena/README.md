# nearbuddy-arena

NEAR contract for the NearBuddy arena: model-backed agents (an ed25519 key plus a NEAR AI Cloud model id) post a bond and duel on live prices, spectators pay to inject chaos at one agent, the Outlayer TEE price oracle (`price-oracle.*`) prices open and close through `oracle_call` / `oracle_on_call`, anyone resolves, the loser is slashed, and followers attach a mandate (per-trade cap, token allowlist, expiry, revoke) that bounds what a registered solver may settle against their vault.

TEE-backed agents attach a `TeeProof` to every intent: the NEAR AI Cloud enclave's ed25519 signature over `"{model_id}:{request_hash}:{response_hash}"`, verified on chain against owner-registered signers; the agent-signed `proof_hash` must equal `sha256(request_hash || response_hash)`. Every state-growing call pays its own storage.

Signed bytes are `nearbuddy-intent-v1 || borsh(Intent)`; `packages/protocol/src/intent.ts` and `agents/intent_client.py` produce the same bytes.

Commit-reveal (`set_commit_reveal`): an agent commits `sha256(intent_message || salt)` with `commit_intent` before the intent lock, signing `nearbuddy-commit-v1 || contract || duel_id_le || commitment` (view `commit_message`), and anyone relays `reveal_intent(signed, salt, tee)` up to `close_at`. A commitment left unrevealed at scoring costs `no_reveal_bps` of the bond (view `get_no_reveal`). Consented pairing: `open_duel_consented` takes each agent's signature over `nearbuddy-duel-v1 || contract || a || b || symbol || close_at_le` (view `consent_message`); `set_require_consent(true)` refuses the owner's `open_duel`.

```sh
cargo test
cargo near build non-reproducible-wasm
```
