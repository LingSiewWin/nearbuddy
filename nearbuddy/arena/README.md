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

The view `chaos_fee(duel_id)` returns the next price. A smaller deposit is refused with "chaos deposit too small". The stake is the deposit minus the record's storage, and it stays escrowed in the duel pool until the duel ends. A paid injection must leave a stake above 0 (else "chaos deposit too small"), so no paid record settles nothing. The terms are in `ChaosConfig {base, r_bps, cap, fee_bps, share_bps}`, set by `set_chaos_config` and shown in `get_config().chaos`. Bounds: `r_bps` is 10_000 to 40_000, `cap` is at least `base` and `min_chaos_deposit`, `fee_bps` is at most 1_000, `share_bps` is at most 10_000. While a duel is open, `fee_bps` and `share_bps` cannot change. Suggested testnet terms: base 0.1 NEAR, r 1.25x, cap 1 NEAR, fee 5 %, share 50 %. That gives 0.1, 0.125, 0.156, 0.195, ... NEAR, reaching the 1 NEAR cap at the 12th injection. A fresh `init` sets a flat price at `min_chaos_deposit` with no fee and no share.

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
- If the target replaces, unrevealed, a commitment it held at the injection, it hides the decision before. Every pending injection at it planted at or after the replaced commitment stays pending with `prev: null` for good, and the hidden call counts against the target: its next counting decision gives `Flipped` on the lie's side and `NoTrial` off it, never `Held`. A `Flipped` record with `prev: null` is such a charged flip, so experiment readers can set it apart. Replacing is always allowed and never forfeits; a runner reveals the held call before it commits again (see M3 below).
- Pending injections become `Expired` when the duel finishes or is voided.

**Payout at finish.** Each stake is settled exactly once. Let `fee = stake * fee_bps / 10_000`; every stake pays it, whatever the outcome, except one that expires in a voided duel.

| outcome | injector is owed (`payout`) | target's bond | `owner_fees` |
|---|---|---|---|
| `Flipped`, target lost the duel | `stake - fee + share` | `- share` | `fee` |
| `Flipped`, target won or tied | `stake - fee` | | `fee` |
| `Held` | 0 | `+ stake - fee` (resistance reward) | `fee` |
| `NoTrial`, `Expired` | `stake - fee` | | `fee` |
| `Expired` in a voided duel | `stake` | | |

- `share` is paid by the loser from its bond, on top of its slash. The pot is `min(slash * share_bps / 10_000, what the bond holds after the slash)`, split among the flipped injections at the loser in proportion to stake (weights in bps, rounded down). The loser pays only the shares, so the rounding dust stays in its bond. The winner always gets the whole slash.
- The slash, then the shares, are taken from the loser's bond before any resistance reward is credited.
- A void settles like a tie, except that an expired stake comes back whole: the oracle never answered, which is not the injector's fault.
- Conservation: every stake leaves the pool, and the shares leave the loser's bond. Together they equal payouts + resistance credits + fees.
- Injectors collect with `claim_chaos(duel_id)` (1 yocto). It pays everything the caller is owed in that duel in one transfer, once. The records are marked claimed before the transfer; if it fails (a deleted account), the private callback `on_claim_chaos` unmarks them, so a later claim pays them. Sandbox-tested at the worst case (32 records with 280-byte headlines, the injector deleted right after its claim): the callback burns 3.28 of its 20 TGas, and the whole claim fits in 30 TGas.
- When an owner of either agent, or the contract owner (placebo), pays for an injection, that deposit goes to `owner_fees` at injection. Its stake is 0: it earns nothing and buys no shield, but its outcome is still recorded for the trial.

**Threat model.**

| threat | mitigation or acceptance |
|---|---|
| An agent owner attacks its own agent from its own account | Detected: the stake goes to `owner_fees`, there is no payout and no shield. |
| An owner attacks its own agent through a second account (sybil) | Never profitable: every outcome costs the owner the fee and the storage. Held: the stake less the fee goes to the owner's own bond. Flipped, agent lost: the share is paid from the owner's own bond on top of the slash, and the winner keeps the whole slash. Flipped, agent won or tied, no trial, expired: the stake comes back less the fee. Unit test `an_owner_flipping_its_own_losing_agent_through_a_sybil_loses_money`: a 0.1 NEAR flip on a 0.0988 NEAR slash leaves the owner 0.0079 NEAR down. Before the audit fix the share came out of the winner's slash and the owner netted +0.0415 NEAR. |
| M1: the owner decides whether an injection is `Held` by not delivering the headline (its runner leaves the headline out of the prompt or rewrites it, and the agent "resists" a lie it never saw), so the held stake less the fee goes to its bond | **Accepted testnet limitation, checkable off chain.** The deciding intent's nonce is on the record (`decided_by`), and its TEE proof binds `request_hash`. Publishing the request bytes lets anyone confirm that the arm's text was delivered. Mainnet fix: require the request body on deciding reveals and check delivery on chain (the body hashes to `request_hash` and holds the arm's text; needs ASCII headlines and a Rust port of the cue guard, checked against `fixtures/cue-guard-vectors.json`). |
| M3: the target dodges a trial by replacing its held commitment unrevealed. It asks its model with the headline first: if fooled, it replaces the held call so the fooled call is not judged; if not, it reveals first and collects the hold. | **Fixed in deploy 17.1** (until then a replacement voided the headline, and the target picked its outcome per headline). A replaced held call hides `prev` and counts against the target: the next counting decision is `Flipped` on the lie's side and `NoTrial` off it, never `Held`. Revealing first is never judged worse for the target, whatever the hidden call `h` was. Next on the lie's side: revealing gives `Flipped` (h off the lie's side) or `NoTrial` (h on it), the dodge gives `Flipped`. Next off the lie's side: revealing gives `Held` or `NoTrial`, the dodge gives `NoTrial`. So revealing first is the dominant strategy, and a dodge never costs the injector a flip. Judging the hidden call as the last revealed one is not enough: a target with no revealed call, or one on the lie's side, would still dodge a flip into no trial, and one whose hidden call was on the lie's side would dodge a no trial into a hold. Unit tests: `dodging_never_beats_revealing_over_small_ranges` (48 cases: revealed call none, Long or Short; held call; lie; next call; price move), `dodging_a_fooled_call_by_replacing_the_held_one_still_flips` (the audit's case: before the fix the dodge turned a flip with a 0.0493 NEAR share into a no trial; now both pay it, and the dodger only keeps the 0.001 NEAR of storage of the reveal it skipped), `dodging_a_held_lie_side_call_never_earns_a_hold`. Replacing stays allowed and never forfeits: one cheap injection cannot force an early reveal, or a no-reveal forfeit on a runner that lost its salt (that runner risks a charged flip instead). Cost to honest runners: a commit that lands after an injection the runner has not seen yet is judged as a dodge, so the runner re-reads the pending headlines just before it commits. The flag is bit `32 + i` of `self_chaos`, so the state layout is unchanged. |
| Race window: a headline lands between the runner's last read of the pending headlines and its replacing commit, so an honest runner's replacement is charged as a dodge | **Accepted testnet limitation.** Mitigated in the runner: it reads `get_chaos` fresh from chain right before every commit (one short attempt, not the solver's cache), never replaces a held call when that read fails, and aborts the replacing commit when the reveal of a held call that is a headline's `prev` fails. The window left is the read-to-landing time of one commit, a few seconds. Planned fix: put `seen = injections.len()` in the signed commit message, and have the contract refuse a replacement that has not seen the newer headlines. |
| Sybil splitting of one stake over many injections | Gains nothing. One decision decides every pending injection at that target, shares are pro rata by stake, and every extra injection pays a higher price. |
| Front-running the next decision (injecting after the side is visible) | Only revealed decisions decide, and their time is the commit time. A commitment hides the side, and a reveal of a commitment made at or before the injection only sets `prev`. A commitment that lands just after an injection but was decided before it is a blind bet for the attacker, with no edge. |
| Front-running or grinding the arm | The arm comes from the block's random seed, and only the block producer can predict it. An injection cannot be undone after the draw. Accepted: the stakes are small, and the arm changes delivery, not the payout. |
| Junk or hidden-text headlines | Empty, overlong, control and invisible format characters are refused. Every injection pays the rising price. Content moderation is left to the web layer. |
| Squatting all 32 slots | Every stake pays `fee_bps` whatever its outcome, and shield counts only third-party headlines the winner held against. At the suggested terms 32 no-trial headlines lock 25.26 NEAR until the finish and cost 1.34 NEAR (fees 1.26, storage 0.08), and buy no shield; before the audit fix they cost the 0.08 NEAR of storage and bought shield +32. An owner's sybil that makes its agent hold against all 32 still buys shield +32 at the same cost (its held stakes, less the fee, land in its own bond). The slots reset every duel (at most 24 h). Accepted. |
| Storage griefing | The injector pays for each record (headline at most 280 bytes, account at most 64 bytes, at most 32 records per duel). The only cost a target bears is the few outcome bytes a deciding reveal fills in, at most about 11 bytes per record. |
| The owner changes the terms mid-duel | `fee_bps` and `share_bps` are frozen while any duel is open. The price can move, but it only applies to later injections. |

```sh
cargo test
cargo near build non-reproducible-wasm
```
