#!/usr/bin/env python3
"""
Train a weak-label needs-review risk model from shared validation results.

Weak labels:
- positive: needsReview == true
- negative: needsReview != true (down-weighted due to possible label noise)

No third-party dependencies required.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
from pathlib import Path
from typing import Dict, List, Optional, Tuple


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train weak-label needs-review model.")
    p.add_argument(
        "--validation-json",
        default="data/validation/validation_results.shared.json",
        help="Validation JSON path (root or {validation_results:{...}}).",
    )
    p.add_argument("--lang-code", default="es-AR", help="Language to train/evaluate.")
    p.add_argument("--negative-weight", type=float, default=0.35, help="Weight for assumed negatives.")
    p.add_argument("--positive-weight", type=float, default=1.0, help="Weight for positives.")
    p.add_argument("--holdout-frac", type=float, default=0.25, help="Holdout fraction for evaluation.")
    p.add_argument("--seed", type=int, default=42, help="Random seed.")
    p.add_argument("--iters", type=int, default=1200, help="Gradient descent iterations.")
    p.add_argument("--lr", type=float, default=0.08, help="Learning rate.")
    p.add_argument("--l2", type=float, default=0.001, help="L2 regularization.")
    p.add_argument(
        "--output-prefix",
        default="data/validation/weak-needs-review-es-AR",
        help="Output prefix path (without suffix).",
    )
    return p.parse_args()


def canonical_lang(code: str) -> str:
    c = str(code or "").strip().replace("_", "-").lower()
    aliases = {
        "en": "en",
        "en-us": "en-US",
        "en-gb": "en-GB",
        "en-gh": "en-GH",
        "de": "de",
        "de-de": "de-DE",
        "de-ch": "de-CH",
        "es": "es",
        "es-co": "es-CO",
        "es-ar": "es-AR",
        "fr": "fr",
        "fr-ca": "fr-CA",
        "pt": "pt",
        "pt-pt": "pt-PT",
        "pt-br": "pt-BR",
        "nl": "nl",
    }
    return aliases.get(c, code or "")


def to_pct(v) -> Optional[float]:
    try:
        n = float(v)
    except Exception:
        return None
    if n != n:
        return None
    if n <= 1.0:
        n *= 100.0
    return max(0.0, min(100.0, n))


def sigmoid(z: float) -> float:
    if z >= 0:
        ez = math.exp(-z)
        return 1.0 / (1.0 + ez)
    ez = math.exp(z)
    return ez / (1.0 + ez)


def score_band(score: Optional[float]) -> str:
    if score is None:
        return "pending"
    if score >= 90:
        return "pass_90_100"
    if score >= 80:
        return "review_80_89"
    if score >= 70:
        return "warning_70_79"
    return "fail_lt_70"


def load_rows(validation_path: Path, lang_code: str, pos_w: float, neg_w: float) -> List[dict]:
    payload = json.loads(validation_path.read_text(encoding="utf-8"))
    root = payload.get("validation_results", payload)
    out: List[dict] = []
    target = canonical_lang(lang_code)
    for item_id, by_lang in (root or {}).items():
        if not isinstance(by_lang, dict):
            continue
        result = None
        for lc, r in by_lang.items():
            if canonical_lang(lc) == target:
                result = r
                break
        if not isinstance(result, dict):
            continue

        final = to_pct(result.get("score"))
        comp = to_pct(result.get("compositeScore"))
        if comp is None:
            comp = to_pct(result.get("baselineScore"))
        ai = to_pct(result.get("aiScore"))
        if ai is None and result.get("aiUsed"):
            ai = final
        sem = to_pct(result.get("semanticScore"))
        lex = to_pct(result.get("lexicalScore"))
        y = 1 if result.get("needsReview") is True else 0

        # Feature defaults: avoid dropping rows due to sparse metadata.
        final_f = (final if final is not None else 50.0) / 100.0
        comp_f = (comp if comp is not None else final if final is not None else 50.0) / 100.0
        ai_f = (ai if ai is not None else comp if comp is not None else final if final is not None else 50.0) / 100.0
        sem_f = (sem if sem is not None else comp if comp is not None else 50.0) / 100.0
        lex_f = (lex if lex is not None else comp if comp is not None else 50.0) / 100.0
        diff_ai_comp = abs(ai_f - comp_f)

        out.append(
            {
                "item_id": str(item_id),
                "lang_code": target,
                "y": y,
                "weight": pos_w if y == 1 else neg_w,
                "final_score": final,
                "composite_score": comp,
                "ai_score": ai,
                "semantic_score": sem,
                "lexical_score": lex,
                "score_source": str(result.get("scoreSource", "") or ""),
                "updated": str(result.get("updated", result.get("timestamp", "")) or ""),
                "score_band": score_band(final),
                "x": [
                    1.0,  # bias
                    1.0 - final_f,
                    1.0 - comp_f,
                    1.0 - ai_f,
                    1.0 - sem_f,
                    1.0 - lex_f,
                    diff_ai_comp,
                    1.0 if str(result.get("scoreSource", "")).lower() == "ai" else 0.0,
                    1.0 if sem is None else 0.0,
                    1.0 if lex is None else 0.0,
                    1.0 if ai is None else 0.0,
                ],
            }
        )
    return out


def split_train_holdout(rows: List[dict], holdout_frac: float, seed: int) -> Tuple[List[dict], List[dict]]:
    by_class = {0: [], 1: []}
    for r in rows:
        by_class[int(r["y"])].append(r)
    rng = random.Random(seed)
    train: List[dict] = []
    holdout: List[dict] = []
    for cls, arr in by_class.items():
        rng.shuffle(arr)
        n_hold = int(round(len(arr) * holdout_frac))
        holdout.extend(arr[:n_hold])
        train.extend(arr[n_hold:])
    rng.shuffle(train)
    rng.shuffle(holdout)
    return train, holdout


def fit_standardizer(train: List[dict], feature_count: int) -> Tuple[List[float], List[float]]:
    means = [0.0] * feature_count
    stds = [1.0] * feature_count
    # Skip bias index 0
    for j in range(1, feature_count):
        vals = [r["x"][j] for r in train]
        if not vals:
            continue
        m = sum(vals) / len(vals)
        var = sum((v - m) ** 2 for v in vals) / max(1, len(vals))
        s = math.sqrt(var)
        means[j] = m
        stds[j] = s if s > 1e-8 else 1.0
    return means, stds


def apply_standardizer(rows: List[dict], means: List[float], stds: List[float]) -> None:
    for r in rows:
        x = r["x"]
        z = [x[0]]
        for j in range(1, len(x)):
            z.append((x[j] - means[j]) / stds[j])
        r["z"] = z


def train_weighted_logreg(train: List[dict], feature_count: int, lr: float, iters: int, l2: float) -> List[float]:
    w = [0.0] * feature_count
    if not train:
        return w
    for _ in range(iters):
        grad = [0.0] * feature_count
        weight_sum = 0.0
        for r in train:
            x = r["z"]
            y = float(r["y"])
            wt = float(r["weight"])
            z = sum(w[j] * x[j] for j in range(feature_count))
            p = sigmoid(z)
            err = (p - y) * wt
            weight_sum += wt
            for j in range(feature_count):
                grad[j] += err * x[j]
        if weight_sum <= 0:
            break
        for j in range(feature_count):
            reg = l2 * w[j] if j != 0 else 0.0
            w[j] -= lr * ((grad[j] / weight_sum) + reg)
    return w


def predict_prob(w: List[float], x: List[float]) -> float:
    return sigmoid(sum(w[j] * x[j] for j in range(len(w))))


def weighted_metrics(rows: List[dict], threshold: float) -> dict:
    tp = fp = tn = fn = 0.0
    for r in rows:
        y = int(r["y"])
        wt = float(r["weight"])
        pred = 1 if r["p_review"] >= threshold else 0
        if pred == 1 and y == 1:
            tp += wt
        elif pred == 1 and y == 0:
            fp += wt
        elif pred == 0 and y == 0:
            tn += wt
        else:
            fn += wt
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0
    acc = (tp + tn) / (tp + tn + fp + fn) if (tp + tn + fp + fn) > 0 else 0.0
    return {
        "threshold": threshold,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "accuracy": acc,
        "weighted_confusion": {"tp": tp, "fp": fp, "tn": tn, "fn": fn},
    }


def choose_threshold(rows: List[dict]) -> Tuple[float, dict]:
    # Prefer strong recall first, then F1.
    # Scan actual score distribution so we still get signal when all p are small.
    values = sorted({round(float(r.get("p_review", 0.0)), 6) for r in rows})
    if not values:
        return 0.5, weighted_metrics(rows, 0.5)
    candidates = sorted(set([0.0, 0.01, 0.02, 0.05, 0.1] + values))
    best = None
    best_t = candidates[0]
    for t in candidates:
        m = weighted_metrics(rows, t)
        key = (1 if m["recall"] >= 0.80 else 0, m["f1"], m["precision"])
        if best is None or key > best:
            best = key
            best_t = t
    return best_t, weighted_metrics(rows, best_t)


def write_predictions_csv(path: Path, rows: List[dict], threshold: float) -> None:
    headers = [
        "item_id",
        "lang_code",
        "y_weak_label",
        "weight",
        "p_review",
        "pred_review",
        "score_band",
        "final_score",
        "composite_score",
        "ai_score",
        "semantic_score",
        "lexical_score",
        "score_source",
        "updated",
        "split",
    ]
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for r in rows:
            w.writerow(
                {
                    "item_id": r["item_id"],
                    "lang_code": r["lang_code"],
                    "y_weak_label": r["y"],
                    "weight": round(float(r["weight"]), 4),
                    "p_review": round(float(r["p_review"]), 6),
                    "pred_review": 1 if r["p_review"] >= threshold else 0,
                    "score_band": r["score_band"],
                    "final_score": "" if r["final_score"] is None else round(float(r["final_score"]), 3),
                    "composite_score": "" if r["composite_score"] is None else round(float(r["composite_score"]), 3),
                    "ai_score": "" if r["ai_score"] is None else round(float(r["ai_score"]), 3),
                    "semantic_score": "" if r["semantic_score"] is None else round(float(r["semantic_score"]), 6),
                    "lexical_score": "" if r["lexical_score"] is None else round(float(r["lexical_score"]), 6),
                    "score_source": r["score_source"],
                    "updated": r["updated"],
                    "split": r.get("split", ""),
                }
            )


def main() -> int:
    args = parse_args()
    validation_path = Path(args.validation_json)
    output_prefix = Path(args.output_prefix)
    output_prefix.parent.mkdir(parents=True, exist_ok=True)
    lang_code = canonical_lang(args.lang_code)

    rows = load_rows(validation_path, lang_code, args.positive_weight, args.negative_weight)
    if len(rows) < 20:
        raise SystemExit("Not enough rows to train weak model. Check validation JSON/lang code.")

    train, holdout = split_train_holdout(rows, args.holdout_frac, args.seed)
    feature_count = len(rows[0]["x"])
    means, stds = fit_standardizer(train, feature_count)
    apply_standardizer(train, means, stds)
    apply_standardizer(holdout, means, stds)

    w = train_weighted_logreg(train, feature_count, args.lr, args.iters, args.l2)
    for r in train:
        r["p_review"] = predict_prob(w, r["z"])
        r["split"] = "train"
    for r in holdout:
        r["p_review"] = predict_prob(w, r["z"])
        r["split"] = "holdout"

    t_star, holdout_metrics = choose_threshold(holdout)
    train_metrics = weighted_metrics(train, t_star)
    all_rows = train + holdout

    # Useful ops thresholds
    metrics_at = {
        "0.40": weighted_metrics(holdout, 0.40),
        "0.50": weighted_metrics(holdout, 0.50),
        "0.60": weighted_metrics(holdout, 0.60),
    }

    # Rank candidates for incremental manual review
    top_queue = sorted(holdout, key=lambda r: r["p_review"], reverse=True)[:100]

    preds_csv = output_prefix.with_name(output_prefix.name + "-predictions.csv")
    summary_json = output_prefix.with_name(output_prefix.name + "-summary.json")
    write_predictions_csv(preds_csv, all_rows, t_star)

    summary = {
        "status": "ok",
        "lang_code": lang_code,
        "inputs": {
            "validation_json": str(validation_path),
            "positive_weight": args.positive_weight,
            "negative_weight": args.negative_weight,
            "holdout_frac": args.holdout_frac,
            "seed": args.seed,
        },
        "counts": {
            "rows_total": len(rows),
            "positives": sum(1 for r in rows if r["y"] == 1),
            "negatives_assumed": sum(1 for r in rows if r["y"] == 0),
            "train_rows": len(train),
            "holdout_rows": len(holdout),
        },
        "model": {
            "feature_count": feature_count,
            "weights": w,
            "features": [
                "bias",
                "risk_from_final",
                "risk_from_composite",
                "risk_from_ai",
                "risk_from_semantic",
                "risk_from_lexical",
                "ai_composite_disagreement",
                "score_source_is_ai",
                "semantic_missing",
                "lexical_missing",
                "ai_missing",
            ],
            "recommended_threshold": t_star,
        },
        "metrics": {
            "holdout_at_recommended": holdout_metrics,
            "train_at_recommended": train_metrics,
            "holdout_at_common_thresholds": metrics_at,
        },
        "top_holdout_review_queue": [
            {
                "item_id": r["item_id"],
                "p_review": round(float(r["p_review"]), 6),
                "weak_label": int(r["y"]),
                "final_score": r["final_score"],
                "composite_score": r["composite_score"],
                "ai_score": r["ai_score"],
                "score_source": r["score_source"],
            }
            for r in top_queue
        ],
        "outputs": {
            "predictions_csv": str(preds_csv),
            "summary_json": str(summary_json),
        },
        "notes": [
            "This is weak supervision: negatives are assumed and down-weighted.",
            "Use for prioritization and threshold tuning, not as a final ground-truth classifier.",
            "Refresh weekly as new human-reviewed data arrives.",
        ],
    }
    summary_json.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"wrote {preds_csv}")
    print(f"wrote {summary_json}")
    print(f"lang={lang_code} rows={len(rows)} positives={summary['counts']['positives']} negatives={summary['counts']['negatives_assumed']}")
    print(f"recommended_threshold={t_star:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

