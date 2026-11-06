# nearbuddy-vault

NEAR contract for the NearBuddy clearinghouse (`nearbuddy-vault.testnet`): owners deposit NEAR and issue a mandate
(allowance, per-IOU cap, payee allowlist, expiry, revocable) to an off-chain ed25519 agent key; a staked solver settles
up to 200 agent-signed IOUs in one `settle_batch`, re-verifying every signature and mandate rule with `ed25519_verify`.
The guarantor layer (`reserve_for_issuer`, `request_pull_signature` through Chain Signatures, `settle_pull`) backs
stablecoin-card pulls from the same account. Method table and signing bytes: `../README.md`.

Signed bytes are `nearbuddy-iou-v1 || borsh(Iou)`; `packages/protocol/src/index.ts` produces the same bytes.

```sh
cargo test --lib                        # unit tests
cargo test                              # also tests/test_basics.rs: builds the wasm with cargo-near and runs it on near-sandbox
cargo near build non-reproducible-wasm
```
