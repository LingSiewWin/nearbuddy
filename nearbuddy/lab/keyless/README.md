# lab/keyless: can a keeper re-roll a keyless agent's decision?

In a keyless agent the contract builds the chat request bytes and accepts a NEAR AI Cloud completion only with the
model enclave's signature over `model_id:sha256(request):sha256(response)`. Anyone may submit that completion (a
keeper). The enclave signs every completion it serves, so a keeper can send the same bytes k times and submit the
reply it prefers. This lab measures how often that gives a choice.

The prompts are real. Each one is the exact request body of a decision the arena posted on chain, taken from the
arena dataset, and its duel's open and close prices come from `get_duel`. Each body is replayed byte for byte, so
every reply is enclave-signed against the bytes we sent.

## Rerun

```sh
cd nearbuddy/lab
uv sync --locked
uv run --locked python keyless/reroll.py select --dataset ../agents/data/decisions.jsonl  # free; writes data/prompts.jsonl
uv run --locked python keyless/reroll.py run --phase pilot --n 1 --limit 5 --conditions t0_seed  # 5 paid calls
uv run --locked python keyless/reroll.py run --n 8 --conditions default,t0,seed,t0_seed --cap 3  # 1440 paid calls
uv run --locked python keyless/reroll.py sigs    # free: one Long and one Short signature per split prompt
uv run --locked python keyless/reroll.py report  # free: results/summary.json and the table below
```

- `select` needs the arena dataset (`agents/data/`, gitignored). The 45 prompts it chose are committed in
  `data/prompts.jsonl`, so `run`, `sigs` and `report` need only the NEAR AI key, read through `agents/config.py`.
- `run` resumes. A call already in `results/calls.jsonl` is skipped, and a failed call is retried.
- Every paid call is logged to `spend.jsonl` through `harness.Budget`. A call is refused when its worst case would
  take the logged spend past `--cap`.

## Design

- **Prompts.** 15 per model: 10 unattacked and 5 with a headline injected. Each is a single-call profile (`naive`,
  `hardened`, A, B or C), posted on chain, from a duel that resolved with a price move, and sampled with seed 20261111.
- **Models.**
  - The arena's pair 1: `deepseek-ai/DeepSeek-V4.1-Flash-1017` and `Qwen/Qwen3.8-27B`.
  - `z-ai/glm-5.3-flash` from pair 2.
  - `Qwen/Qwen3.6-35B-A3B-FP8` (pair 2) appears only in the response-size table, from the dataset.
- **Settings.** 8 calls each, interleaved in random order across prompts, models and settings, 8 at a time:
  - `default`: the recorded bytes (no `temperature`, no `seed`);
  - `t0`: plus `"temperature":0`;
  - `seed`: plus `"seed":20261111`;
  - `t0_seed`: plus both.
  - `GET /v1/models` lists `seed` as supported for Qwen3.8 and GLM-5.3-flash. It lists nothing for
    DeepSeek-V4.1-Flash (`results/models-sampling-params.txt`). Every setting returned HTTP 200 on all three.
- **Decision.** The arena's own parser (`duelist.parse_decision`) reads the reply. A reply it cannot read is an
  abstention: no position and pnl 0. It is a third outcome a keeper may also choose to submit.
- **Re-roll measures, per prompt, then averaged.** Probabilities for k < 8 are exact draws without replacement from
  the 8 observed replies.
  - Both sides: a Long and a Short among the 8.
  - `P(both) k`: the chance that k calls hold both sides.
  - Best-of-k win: a keeper that knew the close submits a winning reply if it drew one. This is an upper bound on
    what a re-roller gains. Without hindsight, choosing a side is only as good as the keeper's own forecast.
  - Worst-of-k: a griefer submits a losing reply if it drew one.
  - pnl: in bps of a full 5000 bps position, ±|move|/2 per duel.
  - Attacked prompts:
    - single = the share of replies that took the headline's side;
    - injector best-of-8 = the chance that at least one of 8 took it;
    - owner = the chance that none of 8 held, so the owner cannot avoid the flip.

## Results (2026-11-10: 1440 calls plus a 5-call pilot and 1 retry, $0.393)

| model | setting | prompts with both sides | byte-identical prompts | P(both) k=2 | win single / best-of-8 / worst-of-8 | pnl single / best / worst (bps) | flipped single / injector / owner |
|---|---|---|---|---|---|---|---|
| Qwen3.8-27B | default | 5/15 | 0/15 | 12% | 38% / 60% / 27% | 0.58 / 2.44 / -1.42 | 80% / 80% / 80% |
| Qwen3.8-27B | seed | 5/15 | 0/15 | 9% | 32% / 53% / 20% | -0.05 / 3.63 / -3.58 | 80% / 80% / 80% |
| Qwen3.8-27B | t0 | 2/15 | 0/15 | 5% | 35% / 40% / 27% | 0.73 / 1.42 / -0.51 | 80% / 80% / 80% |
| Qwen3.8-27B | t0_seed | 2/15 | 0/15 | 5% | 38% / 40% / 27% | 0.93 / 1.42 / -1.64 | 80% / 80% / 80% |
| DeepSeek-V4.1-Flash | default | 2/15 | 0/15 | 6% | 38% / 47% / 33% | -0.50 / 1.34 / -1.28 | 60% / 60% / 60% |
| DeepSeek-V4.1-Flash | seed | 2/15 | 0/15 | 6% | 38% / 47% / 33% | -1.01 / -0.24 / -1.28 | 60% / 60% / 60% |
| DeepSeek-V4.1-Flash | t0 | 1/15 | 3/15 | 3% | 35% / 40% / 33% | -1.24 / -1.04 / -1.28 | 57% / 60% / 60% |
| DeepSeek-V4.1-Flash | t0_seed | 2/15 | 0/15 | 6% | 38% / 47% / 33% | -0.86 / 0.97 / -1.28 | 57% / 60% / 60% |
| GLM-5.3-flash | default | 5/15 | 0/15 | 12% | 64% / 80% / 47% | 3.94 / 6.46 / 0.43 | 0% / 0% / 0% |
| GLM-5.3-flash | seed | 2/15 | 0/15 | 4% | 65% / 73% / 60% | 3.98 / 4.78 / 2.66 | 0% / 0% / 0% |
| GLM-5.3-flash | t0 | 5/15 | 0/15 | 9% | 65% / 80% / 47% | 4.07 / 6.46 / 0.23 | 0% / 0% / 0% |
| GLM-5.3-flash | t0_seed | 1/15 | 0/15 | 2% | 63% / 67% / 53% | 4.02 / 4.53 / 2.29 | 0% / 0% / 0% |

Pooled over the three models (Wilson 95%), prompts where 8 calls returned both sides:

| setting | prompts | share | 95% CI |
|---|---|---|---|
| `default` | 12/45 | 27% | 16-41% |
| `seed` | 9/45 | 20% | 11-34% |
| `t0` | 8/45 | 18% | 9-31% |
| `t0_seed` | 5/45 | 11% | 5-23% |

- **No setting is deterministic.** 8 calls gave byte-identical text on 3 of 180 prompt-settings, all DeepSeek `t0`, and
  on none under `t0_seed`. `seed` is accepted but does not make the output reproducible.
- **Re-roll is real and provable.** `sigs` fetched the enclave signature of one Long and one Short reply for every
  split prompt-setting. All 34 pairs (68 records) verify against the bytes we sent. Every signer is pinned on the live
  arena (`is_tee_signer` true). Today's contract would accept either reply.
- **`t0_seed` cuts the choice from 27% to 11% of prompts.** The hindsight bound on a keeper's gain falls from about +2.1
  to about +1.0 bps per decision, averaged over models.
- **Attacked prompts did not split.** 0 of 60 attacked prompt-settings returned both sides. The flip or hold was the
  same in all 8 calls apart from abstentions. With n = 15 per setting, the 95% upper bound is 20%.
- **Unparsed replies: 15 of 1440 (1%).** Some were truncated at `max_tokens` (`{"direction": "long`) and some were bare
  words (`SHORT`). The contract's parse rule decides what such a reply scores.

Response sizes per model:

| model | source | median bytes | max bytes |
|---|---|---|---|
| DeepSeek-V4.1-Flash | live (this lab) | 1042-1114 | 3188 |
| Qwen3.8-27B | live (this lab) | 1246-1290 | 2971 |
| GLM-5.3-flash | live (this lab) | 2030-2464 | 4098 |
| DeepSeek-V4.1-Flash | arena dataset, 931 rows | 1066 | 3227 |
| Qwen3.8-27B | arena dataset, 851 rows | 1242 | 2953 |
| GLM-5.3-flash | arena dataset, 234 rows | 2021 | 4230 |
| Qwen3.6-35B-A3B-FP8 (reasoning) | arena dataset, 204 rows | 3018 | 6251 |

Hashing the largest reply on chain costs 4.54 Ggas + 6251 × 24.1 Mgas = 0.155 Tgas. The live testnet values are in
`results/testnet-protocol-config.txt`: protocol 88, `sha256_base`, `sha256_byte`, `max_arguments_length` 4 MiB.

## Files

- `reroll.py`: select, run, sigs, report.
- `data/prompts.jsonl`: the 45 prompts with exact request bytes and duel prices.
- `results/calls.jsonl`: every call, with the reply text, side, size, hashes, usage and latency.
- `results/signatures.jsonl`: the 68 checked signature records.
- `results/summary.json`: per-prompt and per-group numbers.
- `spend.jsonl`: one line per paid call.

## Caveats

- 15 prompts per model is small. The per-model rows differ by one or two prompts, so read the pooled row.
- Calls ran within 25 minutes on one evening. Batch composition on NEAR AI's servers changes with load, and so may
  the split rate.
- The keyless template will differ from these prompts. Rerun `select` on keyless rows once they exist.
