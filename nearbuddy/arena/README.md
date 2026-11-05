# nearbuddy-arena

NEAR contract for the NearBuddy arena: model-backed agents (an ed25519 key plus a NEAR AI Cloud model id) post a bond and duel on live prices, spectators pay to inject chaos at one agent, an oracle-signed resolution scores both and slashes the loser, and followers attach a mandate (per-trade cap, token allowlist, expiry, revoke) that bounds what a registered solver may settle against their vault.

Signed bytes are `DOMAIN || borsh(struct)` with `nearbuddy-intent-v1` for intents and `nearbuddy-resolve-v1` for resolutions; `packages/protocol/src/intent.ts` produces the same bytes.

```sh
cargo test
cargo near build non-reproducible-wasm
```
