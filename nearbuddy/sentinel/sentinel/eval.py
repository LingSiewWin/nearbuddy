"""Compare the headline detectors and export the best one.

    uv run --locked python sentinel/eval.py [--attacks PATH] [--no-judge]

Rows: benign headlines (label 0), attack headlines with cues (`cue`, label 1), the same attacks with the cues
stripped (`clean`, label 1), and neutral placebo headlines written in the attack style (`placebo`, label 0).
Folds are grouped by template_id, so no template is in both train and test; every score below is out-of-fold.
Each trained detector is fitted three ways: on cue attacks only (does it find anything but cues?), on cue + clean,
and on cue + clean with the placebo rows as extra negatives (does it learn the claim or just the attack style?).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Callable
from pathlib import Path

import cloud
import corpus
import features
import metrics
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.pipeline import Pipeline, make_pipeline
from sklearn.preprocessing import StandardScaler

WEIGHTS = Path(__file__).resolve().parent.parent / "weights.json"
FPR = 0.05
C = {"rules": 1.0, "embed": 0.1}  # fixed before looking at results; no tuning on test folds
REGIMES = (("cue",), ("cue", "clean"), ("cue", "clean", "placebo"))


def build_rows(benign: list[dict], attacks: list[dict]) -> dict[str, np.ndarray]:
    out = [(b["text"], "benign", b["id"], b["source"]) for b in benign]
    for a in attacks:
        if a["direction"] is None:
            out.append((a["text_cue"], "placebo", a["template_id"], "placebo"))
        else:
            out += [(a[f"text_{k}"], k, a["template_id"], a["vector"]) for k in ("cue", "clean")]
    texts, kind, group, source = (list(c) for c in zip(*out, strict=True))
    return {
        "text": np.array([corpus.clean_text(t) for t in texts], dtype=object),
        "kind": np.array(kind),
        "group": np.array(group),
        "source": np.array(source),
        "y": np.isin(kind, ["cue", "clean"]).astype(int),
    }


def assign_folds(y: np.ndarray, group: np.ndarray, k: int = 5, seed: int = 0) -> np.ndarray:
    fold = np.empty(len(y), dtype=int)
    for f, (_, test) in enumerate(StratifiedGroupKFold(k, shuffle=True, random_state=seed).split(y, y, group)):
        fold[test] = f
    return fold


def model(c: float) -> Pipeline:
    return make_pipeline(StandardScaler(), LogisticRegression(C=c, max_iter=5000))


def oof(X: np.ndarray, rows: dict, fold: np.ndarray, train_kinds: list[str], c: float) -> np.ndarray:
    out = np.full(len(fold), np.nan)
    for f in np.unique(fold):
        tr = (fold != f) & np.isin(rows["kind"], ["benign", *train_kinds])
        te = fold == f
        out[te] = model(c).fit(X[tr], rows["y"][tr]).predict_proba(X[te])[:, 1]
    return out


def summarize(name: str, train: str, s: np.ndarray, rows: dict, mask: np.ndarray, calibrated: bool, boot: int) -> dict:
    kind, group = rows["kind"], rows["group"]
    ok = mask & ~np.isnan(s)
    neg = s[ok & (kind == "benign")]
    missing = int((mask & np.isnan(s)).sum())
    out: dict = {"detector": name, "train": train, "n_benign": int(len(neg)), "missing": missing}
    for k in ("cue", "clean"):
        m = ok & (kind == k)
        out[f"n_{k}"] = int(m.sum())
        out[f"auc_{k}"] = metrics.auc(neg, s[m])
        out[f"ci_{k}"] = metrics.auc_ci(neg, s[m], group[m], boot)
        out[f"recall_{k}"] = metrics.recall_at_fpr(neg, s[m], FPR)
    plc = ok & (kind == "placebo")
    out["placebo_flagged"] = float(np.mean(s[plc] > metrics.threshold(neg, FPR))) if plc.any() else math.nan
    cal = ok & np.isin(kind, ["benign", "cue"])
    out["brier"] = metrics.brier(s[cal], rows["y"][cal]) if calibrated else math.nan
    out["ece"] = metrics.ece(s[cal], rows["y"][cal]) if calibrated else math.nan
    return out


def table(results: list[dict]) -> str:
    head = (
        f"{'detector':<26}{'train':<19}{'benign':>7}{'pos':>5}  {'AUC cue [95% CI]':<22}{'R@5%':>6}"
        f"  {'AUC clean [95% CI]':<22}{'R@5%':>6}{'placebo':>9}{'Brier':>8}{'ECE':>7}{'J':>7}"
    )
    lines = [head, "-" * len(head)]

    def num(x: float, d: int = 3) -> str:
        return "-" if math.isnan(x) else f"{x:.{d}f}"

    for r in results:
        ci = {k: f"{r[f'auc_{k}']:.3f} [{r[f'ci_{k}'][0]:.3f}, {r[f'ci_{k}'][1]:.3f}]" for k in ("cue", "clean")}
        lines.append(
            f"{r['detector']:<26}{r['train']:<19}{r['n_benign']:>7}{r['n_cue']:>5}  {ci['cue']:<22}"
            f"{r['recall_cue']:>6.2f}  {ci['clean']:<22}{r['recall_clean']:>6.2f}{num(r['placebo_flagged'], 2):>9}"
            f"{num(r['brier']):>8}{num(r['ece']):>7}{num(merit(r), 2):>7}"
        )
    lines += [f"  {r['detector']}: {r['missing']} rows without a score, left out" for r in results if r["missing"]]
    return "\n".join(lines)


def judge_sample(rows: dict, n_benign: int = 70, n_attack: int = 50, n_placebo: int = 20, seed: int = 0) -> np.ndarray:
    """Row mask for the judge, at most 190 items: benign split evenly by source; attack rows spread over every
    template (the cue and clean text of each picked row); placebo rows."""
    rng = np.random.default_rng(seed)
    kind, group, source = rows["kind"], rows["group"], rows["source"]
    pick: list[int] = []
    for src in ("crypto", "market"):
        idx = np.flatnonzero((kind == "benign") & (source == src))
        pick += list(rng.choice(idx, min(n_benign // 2, len(idx)), replace=False))
    cue = np.flatnonzero(kind == "cue")
    first = [rng.choice(cue[group[cue] == g]) for g in rng.permutation(np.unique(group[cue]))]
    rest = rng.permutation(np.setdiff1d(cue, first))
    chosen = np.r_[first, rest][:n_attack]
    clean = np.flatnonzero(kind == "clean")
    # the clean twin of a cue row: same template, same position among that template's rows
    for i in chosen:
        g = group[i]
        twin = clean[group[clean] == g][list(cue[group[cue] == g]).index(i)]
        pick += [int(i), int(twin)]
    plc = np.flatnonzero(kind == "placebo")
    pick += list(rng.choice(plc, min(n_placebo, len(plc)), replace=False))
    mask = np.zeros(len(kind), dtype=bool)
    mask[pick] = True
    return mask


def fold_weights(pipe: Pipeline) -> tuple[np.ndarray, float]:
    """StandardScaler + LogisticRegression as one linear map on the raw input: logit = w . x + b."""
    scaler, lr = pipe.steps[0][1], pipe.steps[1][1]
    w = lr.coef_[0] / scaler.scale_
    return w, float(lr.intercept_[0] - np.sum(w * scaler.mean_))


def selftest_vector(dim: int) -> np.ndarray:
    """A fixed input both languages can build: sin(1..dim), L2-normalised. sentinel.test.ts uses the same vector."""
    v = np.sin(np.arange(1, dim + 1, dtype=np.float64))
    return v / np.linalg.norm(v)


def merit(r: dict) -> float:
    """Youden's J against the placebo: the worse of the two recalls at 5% benign FPR, minus the share of neutral
    attack-style headlines flagged at that threshold. A detector that flags the attack style scores 0."""
    return min(r["recall_cue"], r["recall_clean"]) - r["placebo_flagged"]


def export(path: Path, X: np.ndarray, rows: dict, kinds: list[str], thr: float, result: dict, prov: dict) -> dict:
    train = np.isin(rows["kind"], ["benign", *kinds])
    w, b = fold_weights(model(C["embed"]).fit(X[train], rows["y"][train]))
    w = np.array([float(f"{x:.7g}") for x in w])
    b = float(f"{b:.12g}")
    z = float(selftest_vector(len(w)) @ w + b)
    doc = {
        "detector": "embed-logistic",
        "model": cloud.EMBED_MODEL,
        "dim": len(w),
        "preprocess": "strip http(s) links, collapse whitespace, embed, L2-normalise",
        "score": "sigmoid(weights . x + bias); flag when score > threshold",
        "threshold": thr,
        "threshold_note": f"{FPR:.0%} of out-of-fold benign scores lie above it",
        "bias": b,
        "trained_on": {**prov, "rows": {k: int((rows["kind"] == k).sum()) for k in ["benign", *kinds]}},
        "metrics_out_of_fold": {k: result[k] for k in ("auc_cue", "ci_cue", "recall_cue", "auc_clean", "ci_clean",
                                                       "recall_clean", "placebo_flagged", "brier", "ece")},
        "selftest": {"input": "sin(1..dim), L2-normalised", "logit": z, "score": 1 / (1 + math.exp(-z))},
        "weights": w.tolist(),
    }  # fmt: skip
    path.write_text(json.dumps(doc, indent=1) + "\n")
    return doc


def shown(path: Path) -> str:
    """A path as recorded in the export: relative to nearbuddy/ when it is inside it."""
    return str(path.resolve().relative_to(cloud.ROOT)) if path.resolve().is_relative_to(cloud.ROOT) else str(path)


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--attacks", type=Path, help="attack corpus JSONL (default: the provisional paper-derived set)")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--boot", type=int, default=1000)
    ap.add_argument("--no-judge", action="store_true")
    ap.add_argument("--export", type=Path, default=WEIGHTS)
    args = ap.parse_args(argv)

    attacks_path = args.attacks or corpus.write_provisional(corpus.DATA / "attacks-provisional.jsonl")
    benign, attacks = corpus.load_benign(), corpus.load_corpus(attacks_path)
    rows = build_rows(benign, attacks)
    fold = assign_folds(rows["y"], rows["group"], args.folds)
    cache, spend = cloud.Cache(), cloud.Spend()
    spent_before = spend.total()

    provenance = {
        "benign": [{k: s[k] for k in ("dataset", "revision", "licence", "files")} for s in corpus.BENIGN_SOURCES],
        "attacks": {"path": shown(attacks_path), "sha256": corpus.file_sha256(attacks_path)},
    }
    n = {k: int((rows["kind"] == k).sum()) for k in ("benign", "cue", "clean", "placebo")}
    templates = len(set(rows["group"][rows["y"] == 1]))
    print(f"rows {n}; attack templates {templates}; {args.folds} folds grouped by template_id")
    for s in provenance["benign"]:
        print(f"benign: {s['dataset']}@{s['revision'][:12]} ({s['licence']})")
    print(f"attacks: {shown(attacks_path)} sha256 {provenance['attacks']['sha256'][:16]}")

    emb = cloud.embed(list(rows["text"]), cache, spend)
    emb = emb / np.linalg.norm(emb, axis=1, keepdims=True)
    X = {"rules": features.matrix(list(rows["text"])), "embed": emb}
    everything = np.ones(len(fold), dtype=bool)
    words = np.array([len(t.split()) for t in rows["text"]], dtype=float)

    scores: dict[tuple[str, str], np.ndarray] = {("baseline: word count", "none"): words}
    for name, label in (("rules", "(a) rules + logistic"), ("embed", "(b) Qwen3-emb + logistic")):
        for kinds in REGIMES:
            scores[(label, "+".join(kinds))] = oof(X[name], rows, fold, list(kinds), C[name])

    def run(mask: np.ndarray, extra: Callable[[], list[dict]] = list) -> list[dict]:
        return [
            summarize(name, train, s, rows, mask, train != "none", args.boot) for (name, train), s in scores.items()
        ] + extra()

    results = run(everything)
    print("\nAll rows, out-of-fold (pos = attack rows per test set; R@5% = recall at 5% FPR on benign; placebo = "
          f"share of the {n['placebo']} placebo rows flagged there; Brier/ECE on benign + cue;\n"
          "J = min(R@5% cue, R@5% clean) - placebo)")  # fmt: skip
    print(table(results))

    if not args.no_judge:
        sample = judge_sample(rows)
        j = np.full(len(fold), np.nan)
        idx = np.flatnonzero(sample)
        j[idx] = [math.nan if p is None else p for p in cloud.judge(list(rows["text"][idx]), cache, spend)]
        scores[("(c) GLM-5.3-flash judge", "zero-shot")] = j
        print(f"\nJudge sample only (n={sample.sum()}): every detector scored on the same rows")
        print(table(run(sample)))

    best = max((r for r in results if "clean" in r["train"]), key=lambda r: (merit(r), r["auc_clean"]))
    print(f"\nbest trainable detector by J: {best['detector']} / {best['train']}"
          f" ({merit(best):.2f})")  # fmt: skip
    if best["detector"].startswith("(b)"):
        s = scores[(best["detector"], best["train"])]
        thr = metrics.threshold(s[rows["kind"] == "benign"], FPR)
        doc = export(args.export, X["embed"], rows, best["train"].split("+"), thr, best, provenance)
        print(f"exported {shown(args.export)}: dim {doc['dim']}, threshold {thr:.6f}, selftest logit "
              f"{doc['selftest']['logit']:.6f}")  # fmt: skip
    else:
        print("not exported: the solver port covers the embedding detector only")
    print(f"NEAR AI spend this run ${spend.total() - spent_before:.4f}, total ${spend.total():.4f} (cap ${spend.cap})")


if __name__ == "__main__":
    main(sys.argv[1:])
