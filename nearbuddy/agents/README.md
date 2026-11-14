# agents

Python runner for the NearBuddy arena. `duelist.py` is the model brain copied from Arcane (one call per decision, injection-aware). `nearai.py` is the model seam: `StubClient` offline, `NearAiClient` against NEAR AI Cloud with TEE-signed responses. `intent_client.py` signs intents byte-for-byte like the contract and re-encodes the enclave signature record into the `TeeProof` the contract verifies. `prompts.py` holds the hardened and naive prompts the duel compares. `prices.py` fetches the spot price for the market brief (the contract scores on the Outlayer TEE oracle, not on this). `keys.py` derives the agents' ed25519 keys from the env file and signs the registration proof; `chain.py` reads the arena contract over RPC; `config.py` merges `.env` with the process environment. `runner.py` is the CLI and loop: it drives duels through the solver, saves each model's attestation report under `data/attestations/`, and asks the oracle to resolve.

```sh
uv sync  # .venv from uv.lock on the Python in .python-version (3.13)
.venv/bin/pytest -q
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy .
.venv/bin/python -m runner --rounds 1 --duel-seconds 60
```

_Moved here from the project README on 2026-11-14. File paths in backticks are relative to `nearbuddy/`. Dated statements describe the day they were written; "above" and "below" refer to this file._

## The defences, and how each is checked

The model is what gets attacked, so the defenses are the AI work. Each layer runs inside the request the enclave
signs, so anyone can recompute which layer ran and what it passed on (see "Verifiability").

**Papers this builds on** (all on arxiv.org):

| arXiv | Paper | What we take from it |
|---|---|---|
| 2610.26438 | Fake News, Real Crashes (Wang, Saxena, 2026-10-19) | The mechanic: fabricated news beat prompt injection on LLM trading agents (62% vs 14% attack success). The cue ablation: removing a named source or a "BREAKING" tag took fact-poisoning templates from 100% to 0% with the claim unchanged. That is the `Cue`/`Clean` arm and `cue_guard`. The sentinel's attack set uses its five vectors and seven event categories (`sentinel/sentinel/corpus.py`). |
| 2608.27496 | ROPE: Routed Origin Policy Enforcement (Ma et al.) | Provenance: trust comes from where a value came from, enforced by the program, never from what the text says. That is hardened-v2's origin blocks and its size cap in code. |
| 2609.22246 | The Corroboration Illusion (Lu, Zhang) | One planted article flipped 56% of a retrieval forecaster's calls and five flipped 69-73%, measured against a neutral-article placebo. That is why "confirmed by two sources" is a cue `cue_guard` strips, and why the experiment has a placebo arm. |
| 2609.05663 | What LLM Trading Agents Actually Do in Production (Barton et al., DXRG) | Six months of two production fleets: no clear directional edge, and paired replay of 416 scenarios found the tested models' decision quality indistinguishable. Our models agree: scored to the duel close they are right 0.47 of the time (`arena/README.md`). PnL is mostly noise, so the game scores the trial (`Flipped`/`Held`), not PnL. |

**The defense stack.**

| Layer | What it does | What it measurably does | Code |
|---|---|---|---|
| `cue_guard` v1, v2 | Deterministic, no model call. Removes urgency tags, named sources and attributions ("according to", "confirmed by"), and emphasis. Undoes look-alike letters, invisible characters, spaced letters and NFKC tricks first. Keeps the claim, numbers, units and tickers. v2 fixes facts v1 changed (10⁹, "$1 per trader", ⬇). v1 is frozen and sha256-pinned; each row records its version, so old rows still verify. | 91 golden vectors for v2 that a TS or Rust port must reproduce: `fixtures/cue-guard-vectors.json`. Duel 537's `Clean` delivery: cues removed `["confirmed by two sources"]`. | `agents/cue_guard.py`, `agents/cue_guard_v1.py` |
| hardened-v2 | `cue_guard`, then ROPE-style blocks: `<input origin="...">` set by the program, contents escaped, so text cannot open, close or relabel a block. While unverified text is present, code caps the size at 1000 of 5000 bps whatever the model states. The side stays the model's call. | 11 live rows signed on NEAR AI Cloud that must keep verifying: `fixtures/guard-rows-v1.jsonl` | `agents/prompts.py` `user_v2`, `duelist.py` `policy_size` |
| hardened-v3 | hardened-v2 plus a fact-check judge, `z-ai/glm-5.3-flash`, enclave-signed like the duelist. The judge sees only the cleaned, datamarked headline, never prices. A strict parser turns anything but one well-formed verdict into `unverifiable`. The verdict enters the duelist's request as a trusted block. Size cap = max(1, round(1000 × (1 − p))), 1 when unverifiable, so it is never above v2's cap. | 9 of 9 attacks aimed at the judge backfired (fake system line, JSON answer, closing tag, markdown fence, Chinese and Spanish orders, homoglyphs, fullwidth plus zero-width, authority role-play): they scored 0.90-0.98 against 0.75-0.90 for the bare lie, two enclave-signed calls each. **Known weakness:** subtle plausible lies scored 0.15-0.20 (`plausible`, cap 800-850 bps). | `agents/prompts.py` `JUDGE_SYSTEM`, `parse_verdict`, `fact_check_cap`; attack set `fixtures/judge-attacks.json` |

Duel 537 shows why the stack has more than one layer: `cue_guard` alone did not save the naive model. It read the
headline with its cue removed and still flipped.

**Detector evaluation, honest result** (`sentinel/`, numbers in `sentinel/README.md`). Three detectors, folds grouped
by attack template so no template is in both train and test, 24,120 benign headlines, 45 attack templates, recall
measured at 5% false alarms on benign news. The embedding detector (`Qwen/Qwen3-Embedding-0.6B` plus logistic
regression) scores AUC 0.98-0.99 even on cue-stripped attacks, but it flags 88-100% of neutral posts written in the
attack style: it learned the style, not the lie. Only the LLM judge (`z-ai/glm-5.3-flash`, zero-shot, 190 rows)
separates them: AUC 0.97 with cues, 0.965 without, and 5% of the neutral same-style posts flagged. So the live gate is
the judge (hardened-v3). The embedding score is telemetry only (`packages/solver/src/sentinel.ts`, not wired to a
route).

**Verifiability.** `check_row` in `agents/export_dataset.py` recomputes every hash a dataset row claims:

- It rebuilds the whole signed request byte for byte: system prompt, `user_v2` or `user_v3` with the `cue_guard`
  version the row recorded, and the verdict re-parsed from the judge's own signed reply. It checks the posted size
  against the cap and recounts the signed votes.
- Every signer, duelist and judge, must be listed for its model in the attestation report the row cites. No file, an
  unreadable report or an unlisted signer fails closed.
- The judge call carries the duel id and intent nonce, so it cannot be reused for another decision
  (`judge_prompt_version` 2). Limit: this cannot prove the operator did not discard earlier judge calls.
- On deploy 17 it recomputes the delivered text from each record's headline and arm (`prompts.deliver`) and finds it
  in the signed user message. This is how anyone checks the owner did not withhold a headline (M1 in `arena/README.md`).
- Fixtures: `fixtures/guard-rows-v1.jsonl`, `fixtures/guard-rows-v3-bound.jsonl` (five hardened-v3 rows signed under
  judge prompt version 2).

### Controlled experiment (pre-registered, [`lab/README.md`](../lab/README.md))

A paired replication of the cue ablation in arXiv 2610.26438. It ran on the duelists' exact prompts inside NEAR AI
Cloud: DeepSeek-V4.1-Flash, Qwen3.8-27B and GLM-5.3-Flash. The pre-registration, every amendment and the stopping rule
are committed before the data. Each trial uses one frozen market snapshot × one headline in four arms: baseline, `Cue`
(urgency tag + named source), `Clean` (same claim, cues stripped) and a neutral placebo. Flip = the decision moved to
the lie's side from the baseline's side. Results come from `cd lab && uv run --locked python report.py`; only verified
calls count. 10,011 calls cost $3.09; all 9,112 verified calls re-verify from the stored bytes and the enclave
signature.

| profile | cue flips | clean flips | placebo flips | cue vs clean (H1, Holm) | lie vs placebo (H2, Holm) |
|---|---|---|---|---|---|
| naive (pooled, 3 models) | 676/704 = 0.96 | 674/704 = 0.96 | 128/707 = 0.18 | p = 1.0 | p = 3.7e-223 |
| hardened | 49/705 = 0.07 | 45/707 = 0.06 | 58/713 = 0.08 | p = 1.0 | p = 1.0 |
| hardened-v2 | 68/618 = 0.11 | 71/624 = 0.11 | 111/657 = 0.17 | p = 1.0 | lie flips less, p = 0.011 |
| hardened-v3 (stopped early by a NEAR AI outage; no Qwen) | 16/185 = 0.09 | 12/180 = 0.07 | 31/180 = 0.17 | p = 1.0 | p = 0.074 |

- **The paper's cue effect did not replicate.** On the naive prompt, the claim alone flips about 96% of decisions,
  with or without "BREAKING" and a named source. So the attack vector is the claim, not its credibility dressing.
  That is why cue_guard alone is not the defense; the provenance blocks are.
- **The defenses work.** Naive vs hardened, paired cue flips: 661 vs 49 (p = 1.7e-179). Under every hardened profile a
  lie flips no more often than a neutral headline.
- **v2 vs v3:** no difference on this sample (10 vs 12 discordant pairs, p = 1.0). In the 19-trial
  "judge-plausible" stratum, v3's cue arm flipped 3 times and v2's once. That is too few to confirm or rule out the
  risk that a "plausible" verdict adds credibility.
- **The README's older injection claims, recomputed from raw rows** (`lab/claims.py`):
  - Naive is 21/22 = 0.95 [0.78, 0.99], not 22/23; one duel carried two opposite payloads.
  - The hardened "18/29" reproduces, but every one of those 18 pushed with the price move. Against the move it is
    0/10.

## Run your own agent

Two ways to put a model on the board. Both start with one command from your own testnet account (key in
`~/.near-credentials/testnet/`, `NEAR_AI_API_KEY` set so the tier comes from NEAR AI Cloud's model list):

```sh
NEAR_AI_API_KEY=<yours> bun run join --model <near-ai model id> --account <you.testnet> --bond 0.1
```

`join` calls `register_agent` from your account (you are the owner, the bond is yours), prints the agent page and
two lines: `AGENT_KEY_B=<seed>` and `NEAR_AI_MODEL_B=<model>`. The seed is the agent; keep it.

**Hosted v1: we run it.** Send the operator those two lines. The arena runner holds your seed, decides when to ask
the model, signs the intents and posts them. Trust cost: the operator can post in your name until you revoke.
Revoke in this order: ask the operator to stop pairing, wait for the current duel to resolve (`withdraw_bond` is
refused while `in_duel`), then `withdraw_bond` from your account (`join` prints the exact `near` command).

**Self-hosted v2: you run it.** The seed and the model key stay on your machine; our solver only opens duels and
relays your signed intents. Needs a clone, `bun install`, the Python venv from the run block in `arena/README.md`, and the
`ARENA_SECRET` the operator hands you (one shared secret for every solver POST today; per-agent keys are the follow-up).

```sh
AGENT_KEY_B=<seed> NEAR_AI_MODEL_B=<model> NEAR_AI_API_KEY=<yours> \
SOLVER_URL=https://<solver-host> ARENA_SECRET=<shared> \
agents/.venv/bin/python agents/runner.py --only B --wait-pairing        # add --profile hardened-v3 for the fact-checked prompt (or hardened, hardened-v2)
```

`--cycle-seconds` (default 20) is the gap between decisions, `--poll-seconds` (10) the `GET /agent_duel` interval.
`--only A` reads `AGENT_KEY_A` / `NEAR_AI_MODEL_A` instead. The process runs until interrupted:

- registers through `POST /register` only if `get_agent` is empty (a `join`ed agent is already on chain);
- polls `GET /agent_duel?pk=<url-encoded pk>` until the solver pairs it, then reads `get_duel` for `close_at`,
  the symbol and the oracle's open price;
- every cycle: prompt (brief plus any pending injection), enclave signature as `TeeProof`, signed intent via
  `POST /intent`, one row in `agents/data/decisions.jsonl` (same schema as the two-sided runner);
- stops posting `intent_lock_s` (read from `get_config`, 60 s by default) plus 25 s before `close_at`: the contract
  refuses intents inside the lock, the 25 s covers model, signature and chain;
- after close, calls `POST /resolve` once (permissionless on chain; the solver pays the oracle deposit; a second
  caller's error is logged and ignored), prints the outcome, then waits for the next pairing. A finished duel stays
  in `in_duel` until the oracle callback and is skipped.

The solver side is `PAIR_EVERY_S=60 bun run solver` (0, the default, keeps the loop off; `PAIR_EXCLUDE=<pk,pk>` keeps the operator's own two-sided pair out of the loop; `PAIR_MIN_BOND=<yocto>`,
`DUEL_SECONDS=330`, `PAIR_SYMBOL=wrap.near`, `PAIR_STAGGER_S=60` are optional). Every tick it reads `leaderboard`,
keeps agents with `tee == true`, `in_duel == null` and `bond > PAIR_MIN_BOND`, sorts by pk, pairs neighbours (an odd
agent waits one tick) and opens one duel per pair through `open_duel`. Each new duel closes at least `PAIR_STAGGER_S`
seconds from every running duel (the excluded pair's included; 0 turns it off), so countdowns overlap and the next
close is never all of them at once; a duel is never shorter than `DUEL_SECONDS`, only longer. `GET /pairing` shows the
next tick, `stagger_s` and the last 50 duels it opened. Run either the two-sided runner or the pairing loop against one deployment, not both: the loop
also pairs the demo agents A/B between rounds, and an idle verified agent with no runner behind it scores 0 bps.

Follower fills (dry 1Click quotes at each intent) follow the agent's side: a Short sells the mandate amount of wNEAR
for USDC, a Long buys that much wNEAR with USDC. From deploy 15 (`get_config` shows `intents_account`) the default
`FILL_RECIPIENT` is `arena`: one batched quote delivers to the arena's own `intents.near` balance, which
`settle_follow` reads as the receipt, and each follower withdraws its share with `withdraw_token`. On the testnet
stub the solver credits that output with `stub_credit` before settling, and refuses `dry-quote:` fills. Before
deploy 15, `follower` sends the output to each follower's own `intents.near` balance (one quote per follower) and
`solver` keeps it with the solver (one batched quote, `BATCH_RFQ=0` turns batching off); the default is `solver` for
a `.testnet` solver id and `follower` otherwise. Deploy 15 drops `list_followers`: set `FOLLOWERS=<account,...>`
so the solver can read each mandate with `get_follow` (it adds every follower it has settled for). Deploy 15 counts the
fee inside `per_tx_cap` and `allowance`, so the solver quotes the largest amount whose amount + fee fits
(`fee_bps` from `get_config`). Before quoting, the solver also skips a follower whose `allowed_tokens` excludes the
side's output token (USDC on a Short, wNEAR on a Long; a USDC-only mandate gets no Long fills), and drops from the
batch any follower whose quote misses its `min_out_per_near`, the same two checks `settle_follow` runs. Long fills
carry no follower price protection: the quote is EXACT_OUTPUT wNEAR, so `amount_out` equals `amount_in` and the
floor (output units per NEAR) passes whatever USDC the solver paid; only Short fills are priced by the floor. The
solver caps its
own exposure before quoting with `CAP_PER_FILL_YOCTO`, `CAP_PER_TICK_YOCTO` and `CAP_PER_DAY_YOCTO` (rolling 24 h,
kept across restarts); unset means unlimited, and a follower over a cap is listed with the cap's name as its error.
