# sentinel

Scores a headline for fabricated or manipulative market news before it is delivered to a duelist, and measures
how well each detector does it.

```bash
cd nearbuddy/sentinel
uv run --locked python sentinel/eval.py                 # comparison table, writes weights.json
uv run --locked python sentinel/eval.py --attacks ../lab/data/attacks.jsonl   # another attack corpus
uv run --locked pytest -q && uv run --locked ruff check .
```

The first run downloads the benign headlines and embeds every row (about $0.01 on NEAR AI Cloud) and runs the judge
on 190 rows (about $0.05). Both are cached in `data/cache.sqlite`, so a rerun costs nothing. Every paid call is
logged to `spend.jsonl`; a call that would start past `CAP_USD` in `sentinel/cloud.py` raises. The NEAR AI key comes
from `NEAR_AI_API_KEY` or `nearbuddy/.env` (a git worktree reads the main checkout's file).

## Data

| side | source | licence |
|---|---|---|
| benign, crypto | `arad1367/Crypto_Fundamental_News` @ `4dc566dd4920dbbe1a978922e7fa9d3e4cfcdb09` | MIT |
| benign, market | `zeroshot/twitter-financial-news-sentiment` @ `ccbe24de388e287beb92dd393a335c376b350ac3` | MIT |
| attacks | provisional set from arXiv 2610.26438 (`sentinel/corpus.py`), replaced by any JSONL in the shared corpus schema | - |

Benign rows are deduplicated, links are stripped and whitespace collapsed (the solver does the same before it
embeds). The provisional attacks are 45 templates over the paper's five vectors (V1 fact poisoning, V2 sentiment
narrative, V3 selective evidence, V4 structured signal, V5 coordinated multi-source) and seven event categories
(CA, GI, RG, EA, MS, MA, NA), both directions, on BTC, ETH and NEAR, plus 8 neutral placebo templates in the same
style (direction `null`). Each template marks its credibility cues (urgency tag, named source) with `[[...]]`: `text_cue` keeps them,
`text_clean` drops them.

## Detectors

- (a) rules: cue lexicon, urgency, attribution, numeric shock claims, sentiment words (`sentinel/features.py`),
  weighed by a logistic regression.
- (b) `Qwen/Qwen3-Embedding-0.6B` embeddings (NEAR AI Cloud `/v1/embeddings`, L2-normalised) and a logistic
  regression.
- (c) `z-ai/glm-5.3-flash` as a zero-shot judge on 190 rows (70 benign, 50 attacks with cues, the same 50 without,
  20 placebo).

Folds are grouped by `template_id` (5-fold, stratified), so no template is in both train and test. Each trained
detector is fitted three ways: on attacks with cues only (the cue-stripped column then asks whether it finds anything
but cues), on both forms, and on both forms with the placebo rows as extra negatives. AUC carries a 95% bootstrap
interval that resamples attack templates, not rows. `R@5%` is recall when at most 5% of benign headlines are
flagged; `placebo` is the share of held-out placebo rows flagged at that threshold, which is the false-positive
rate on neutral posts written like an attack. Brier and ECE use benign plus cue rows.

The exported detector is the one with the best `min(R@5% cue, R@5% clean) - placebo`.

## Solver

`packages/solver/src/sentinel.ts` embeds the cleaned headline and applies `weights.json`:

```ts
import { screen } from "./sentinel.ts";
const v = await screen(headline); // { score, flagged, threshold }; uses NEAR_AI_API_KEY
```

It is not wired into any route.
