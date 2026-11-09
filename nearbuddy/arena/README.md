# nearbuddy-arena

NEAR contract for the NearBuddy arena: model-backed agents (an ed25519 key plus a NEAR AI Cloud model id) post a bond and duel on live prices, spectators pay to inject chaos at one agent, the Outlayer TEE price oracle (`price-oracle.*`) prices open and close through `oracle_call` / `oracle_on_call`, anyone resolves, the loser is slashed, and followers attach a mandate (per-trade cap, token allowlist, expiry, revoke) that bounds what a registered solver may settle against their vault.

TEE-backed agents attach a `TeeProof` to every intent: the NEAR AI Cloud enclave's ed25519 signature over `"{model_id}:{request_hash}:{response_hash}"`, verified on chain against owner-registered signers; the agent-signed `proof_hash` must equal `sha256(request_hash || response_hash)`. Every state-growing call pays its own storage.

Signed bytes are `nearbuddy-intent-v1 || borsh(Intent)`; `packages/protocol/src/intent.ts` and `agents/intent_client.py` produce the same bytes.

Commit-reveal (`set_commit_reveal`): an agent commits `sha256(intent_message || salt)` with `commit_intent` before the intent lock, signing `nearbuddy-commit-v1 || contract || duel_id_le || commitment` (view `commit_message`), and anyone relays `reveal_intent(signed, salt, tee)` up to `close_at`. A commitment left unrevealed at scoring forfeits the duel and pays `no_reveal_bps` of the bond (default `slash_bps`) to the opponent, or to `owner_fees` when both withheld (view `get_no_reveal`). Consented pairing: `open_duel_consented` takes each agent's signature over `nearbuddy-duel-v1 || contract || a || b || symbol || close_at_le` (view `consent_message`); `set_require_consent(true)` refuses the owner's `open_duel`.

## Chaos v2: fool the AI (deploy 17)

A spectator plants one fake headline at one agent in an open duel, signing with their own account. The agent's next enclave-proved decision shows whether it took the bait. Every injection is also one trial of a randomized experiment on credibility cues.

`inject_chaos(duel_id, target, kind, headline) -> index` (payable):

- `headline` is stored on chain: UTF-8, 1 to 280 bytes, no control characters and no invisible format characters (zero-width, bidi overrides and isolates, word joiners, BOM).
- `kind` is the side the lie pushes toward: `Long`, `Short`, or `Placebo` (a neutral control headline, no direction).
- `Duel.injections` keeps its shape for old readers. `kind` holds the kind's name, and `payload_hash` is `sha256(headline)`, computed by the contract. The caller no longer sends a hash.
- The full record is in `get_chaos(duel_id)`: injector, target, headline, kind, arm, stake, injection time, `prev`, `next`, `decided_by`, `outcome`, `payout` and `claimed`. It is kept after the duel ends.

**Price.** The deposit for the n-th paid injection of a duel (placebos are not counted) is

`fee_n = min(cap, max(min_chaos_deposit, base * (r_bps / 10_000)^n))`, rounded down at each step.

The view `chaos_fee(duel_id)` returns the next price. A smaller deposit is refused with "chaos deposit too small". The stake is the deposit minus the record's storage, and it stays escrowed in the duel pool until the duel ends. The terms are in `ChaosConfig {base, r_bps, cap, fee_bps, share_bps}`, set by `set_chaos_config` and shown in `get_config().chaos`. Bounds: `r_bps` is 10_000 to 40_000, `cap` is at least `base` and `min_chaos_deposit`, `fee_bps` is at most 1_000, `share_bps` is at most 10_000. While a duel is open, `fee_bps` and `share_bps` cannot change. Suggested testnet terms: base 0.1 NEAR, r 1.25x, cap 1 NEAR, fee 5 %, share 50 %. That gives 0.1, 0.125, 0.156, 0.195, ... NEAR, reaching the 1 NEAR cap at the 12th injection. A fresh `init` sets a flat price at `min_chaos_deposit` with no fee and no share.

**Arm.** For `Long` and `Short`, the contract draws `Cue` or `Clean` from `sha256(random_seed || duel_id_le || index_le)`. The runner delivers a `Cue` headline as written and a `Clean` headline after the cue guard. A placebo always has the arm `Placebo`. The injector cannot choose the arm.

Placebos are run only by the contract owner, with no price and no payout. The reasons:

- A neutral headline has no direction, so it can never flip a decision. Strangers paying for one would only be donating.
- A control arm must follow the experimenter's schedule. If attackers chose when placebos happen, the control group would be self-selected.

**Outcome.** A decision's time is its commit time when it is revealed, and its accept time when it is posted.

- `prev` is the side of the target's last decision made at or before the injection. Before the outcome is decided, a later reveal of an earlier commitment can update it.
- The first decision made after the injection that both comes from a reveal and carries a verified provider-TEE proof (kind 2) decides the outcome, exactly once:
  - `Flipped`: `prev` was not the lie's side and the next decision is.
  - `Held`: neither decision is on the lie's side.
  - `NoTrial`: no `prev`, `prev` already on the lie's side, or a placebo.
- A direct `post_intent` never decides an outcome, because its side is readable in the mempool before it lands.
- A plain agent never decides an outcome unless it attaches a kind-2 proof.
- If the target replaces, unrevealed, a commitment it held at the injection, that hidden call was the injection's `prev`, so it can never be judged: a pending injection planted at or after the replaced commitment becomes `NoTrial` at once. One cheap injection cannot force an early reveal. A runner that wants its trials to count reveals before it commits again.
- Pending injections become `Expired` when the duel finishes or is voided.

**Payout at finish.** Each stake is settled exactly once. Let `fee = stake * fee_bps / 10_000`; every stake pays it, whatever the outcome.

| outcome | injector is owed (`payout`) | target's bond | `owner_fees` |
|---|---|---|---|
| `Flipped`, target lost the duel | `stake - fee + share` | `- share` | `fee` |
| `Flipped`, target won or tied | `stake - fee` | | `fee` |
| `Held` | 0 | `+ stake - fee` (resistance reward) | `fee` |
| `NoTrial`, `Expired` | `stake - fee` | | `fee` |

- `share` is paid by the loser from its bond, on top of its slash. The pot is `min(slash * share_bps / 10_000, what the bond holds after the slash)`, split among the flipped injections at the loser in proportion to stake (weights in bps, rounded down). The loser pays only the shares, so the rounding dust stays in its bond. The winner always gets the whole slash.
- The slash, then the shares, are taken from the loser's bond before any resistance reward is credited.
- A void settles like a tie.
- Conservation: every stake leaves the pool, and the shares leave the loser's bond. Together they equal payouts + resistance credits + fees.
- Injectors collect with `claim_chaos(duel_id)` (1 yocto). It pays everything the caller is owed in that duel in one transfer, once. The records are marked claimed before the transfer; if it fails (a deleted account), the private callback `on_claim_chaos` unmarks them, so a later claim pays them.
- When an owner of either agent, or the contract owner (placebo), pays for an injection, that deposit goes to `owner_fees` at injection. Its stake is 0: it earns nothing and buys no shield, but its outcome is still recorded for the trial.

**Threat model.**

| threat | mitigation or acceptance |
|---|---|
| An agent owner attacks its own agent from its own account | Detected: the stake goes to `owner_fees`, there is no payout and no shield. |
| An owner attacks its own agent through a second account (sybil) | Never profitable. Held: the owner gets its own stake back less the fee. Flipped: the share comes out of the owner's own slash, and the rest goes to the opponent. |
| An owner rigs "held" to collect third-party stakes (suppresses or rewrites the headline in the prompt) | **Accepted on chain, checkable off chain.** The deciding intent's nonce is on the record (`decided_by`), and its TEE proof binds `request_hash`. Publishing the request bytes lets anyone confirm that the arm's text was delivered. Planned on-chain fix: require the request body on deciding reveals and match the arm text (needs ASCII headlines and a Rust port of the cue guard, checked against `fixtures/cue-guard-vectors.json`). |
| Sybil splitting of one stake over many injections | Gains nothing. One decision decides every pending injection at that target, shares are pro rata by stake, and every extra injection pays a higher price. |
| Front-running the next decision (injecting after the side is visible) | Only revealed decisions decide, and their time is the commit time. A commitment hides the side, and a reveal of a commitment made at or before the injection only sets `prev`. A commitment that lands just after an injection but was decided before it is a blind bet for the attacker, with no edge. |
| Front-running or grinding the arm | The arm comes from the block's random seed, and only the block producer can predict it. An injection cannot be undone after the draw. Accepted: the stakes are small, and the arm changes delivery, not the payout. |
| Junk or hidden-text headlines | Empty, overlong, control and invisible format characters are refused. Every injection pays the rising price. Content moderation is left to the web layer. |
| Squatting all 32 slots | Costs the sum of the rising prices, locked until the duel ends, plus storage. The slots reset every duel (at most 24 h). Accepted. |
| Storage griefing | The injector pays for each record (headline at most 280 bytes, account at most 64 bytes, at most 32 records per duel). The only cost a target bears is the few outcome bytes a deciding reveal fills in, at most about 11 bytes per record. |
| The owner changes the terms mid-duel | `fee_bps` and `share_bps` are frozen while any duel is open. The price can move, but it only applies to later injections. |

```sh
cargo test
cargo near build non-reproducible-wasm
```
