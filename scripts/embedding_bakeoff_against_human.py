#!/usr/bin/env python3
"""
Bake-off embedding models against human needs-review labels.

Uses precomputed embedding model compare details CSV and shared validation JSON.
Evaluates each model by ranking lowest-similarity items (highest risk) and measuring
overlap with human needsReview=true set.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Dict, List, Set

EXCLUDED_VALIDATION_PREFIXES = ["main/Z_LEGACY_DO_NOT_TRANSLATE/"]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Embedding bake-off vs human needs-review.")
    p.add_argument(
        "--details-csvs",
        default=(
            "data/validation/embedding-model-compare-full-itembank-details.csv,"
            "data/validation/embedding-model-compare-full-dashboard-details.csv,"
            "data/validation/embedding-model-compare-full-surveys-details.csv"
        ),
        help="Comma-separated detail CSVs from embedding model compare runs.",
    )
    p.add_argument(
        "--labels-csv",
        default="data/validation/human-review-seed-es-AR.csv",
        help="Human seed labels CSV.",
    )
    p.add_argument("--target-col", default="es-AR")
    p.add_argument("--output-prefix", default="data/validation/embedding-bakeoff-es-AR")
    p.add_argument("--k-values", default="43,86,129,172", help="Comma-separated K values for top-K overlap.")
    return p.parse_args()


def canonical_lang(code: str) -> str:
    c = str(code or "").strip().replace("_", "-").lower()
    aliases = {
        "es-ar": "es-AR",
        "es-co": "es-CO",
        "es": "es",
        "de": "de",
        "de-de": "de-DE",
        "de-ch": "de-CH",
        "fr-ca": "fr-CA",
        "pt-br": "pt-BR",
        "pt-pt": "pt-PT",
        "nl": "nl",
        "en": "en",
        "en-us": "en-US",
    }
    return aliases.get(c, code or "")


def is_excluded_item_id(item_id: str) -> bool:
    norm = str(item_id or "").strip().lower()
    if not norm:
        return False
    return any(norm.startswith(p.lower()) for p in EXCLUDED_VALIDATION_PREFIXES)


def parse_k_values(raw: str) -> List[int]:
    out = []
    for tok in str(raw or "").split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            k = int(tok)
            if k > 0:
                out.append(k)
        except Exception:
            continue
    return sorted(set(out))


def parse_paths_csv(raw: str) -> List[Path]:
    paths = []
    for tok in str(raw or "").split(","):
        tok = tok.strip()
        if tok:
            paths.append(Path(tok))
    return paths


def load_human_ids_from_seed(labels_csv: Path, target_col: str) -> Set[str]:
    lang = canonical_lang(target_col)
    out: Set[str] = set()
    with labels_csv.open("r", encoding="utf-8", newline="") as f:
        rd = csv.DictReader(f)
        for r in rd:
            lc = canonical_lang(r.get("lang_code", ""))
            if lc != lang:
                continue
            item_id = str(r.get("item_id", "") or "").strip()
            if not item_id or is_excluded_item_id(item_id):
                continue
            cohort = str(r.get("cohort", "") or "").strip().lower()
            needs_flag = str(r.get("needs_review_flag", "") or "").strip()
            if cohort == "positive_needs_review" or needs_flag in {"1", "true", "True"}:
                out.add(item_id)
    return out


def load_human_ids(validation_json: Path, target_col: str) -> Set[str]:
    payload = json.loads(validation_json.read_text(encoding="utf-8"))
    root = payload.get("validation_results", payload)
    lang = canonical_lang(target_col)
    out: Set[str] = set()
    for item_id, by_lang in (root or {}).items():
        if is_excluded_item_id(item_id):
            continue
        if not isinstance(by_lang, dict):
            continue
        found = None
        for lc, r in by_lang.items():
            if canonical_lang(lc) == lang and isinstance(r, dict):
                found = r
                break
        if found and found.get("needsReview") is True:
            out.add(str(item_id))
    return out


def main() -> int:
    args = parse_args()
    detail_paths = parse_paths_csv(args.details_csvs)
    labels_csv = Path(args.labels_csv)
    output_prefix = Path(args.output_prefix)
    output_prefix.parent.mkdir(parents=True, exist_ok=True)
    target_col = canonical_lang(args.target_col)
    k_values = parse_k_values(args.k_values)
    if not k_values:
        raise SystemExit("No valid k-values.")

    human_ids = load_human_ids_from_seed(labels_csv, target_col)
    if not human_ids:
        raise SystemExit(f"No human needs-review ids found for {target_col} in {labels_csv}.")

    by_model: Dict[str, List[dict]] = {}
    by_model_dataset: Dict[str, List[dict]] = {}
    for details_csv in detail_paths:
        with details_csv.open("r", encoding="utf-8", newline="") as f:
            rd = csv.DictReader(f)
            for r in rd:
                tgt = canonical_lang(r.get("target_col", ""))
                if tgt != target_col:
                    continue
                item_id = str(r.get("identifier", "") or "").strip()
                if not item_id or is_excluded_item_id(item_id):
                    continue
                try:
                    sim = float(r.get("similarity"))
                except Exception:
                    continue
                model = str(r.get("model", "") or "").strip()
                dataset = str(r.get("dataset", "") or "").strip()
                if not model:
                    continue
                row = {"item_id": item_id, "similarity": sim, "dataset": dataset, "model": model}
                by_model.setdefault(model, []).append(row)
                by_model_dataset.setdefault(f"{model}::{dataset}", []).append(row)

    def evaluate_bucket(name: str, rows: List[dict]) -> List[dict]:
        # Deduplicate by item id, keep minimum similarity (most risky score).
        min_sim_by_item = {}
        for r in rows:
            iid = r["item_id"]
            sim = float(r["similarity"])
            prev = min_sim_by_item.get(iid)
            if prev is None or sim < prev:
                min_sim_by_item[iid] = sim
        ranked = sorted(min_sim_by_item.items(), key=lambda kv: kv[1])  # low similarity first
        ranked_ids = [iid for iid, _ in ranked]

        scored_ids = set(ranked_ids)
        human_scored = human_ids & scored_ids

        out = []
        total = len(ranked_ids)
        for k in k_values:
            kk = min(k, total)
            top = set(ranked_ids[:kk])
            overlap = len(top & human_ids)
            overlap_scored = len(top & human_scored)
            precision = (overlap / kk) if kk else 0.0
            recall = (overlap / len(human_ids)) if human_ids else 0.0
            recall_scored = (overlap_scored / len(human_scored)) if human_scored else 0.0
            out.append(
                {
                    "bucket": name,
                    "k": kk,
                    "ranked_count": total,
                    "human_count": len(human_ids),  # total human labels in target lang
                    "human_scored_count": len(human_scored),  # subset covered by scored corpus
                    "overlap_count": overlap,
                    "overlap_scored_count": overlap_scored,
                    "precision": precision,
                    "recall": recall,
                    "recall_scored": recall_scored,
                }
            )
        return out

    rows_out: List[dict] = []
    for model, rows in by_model.items():
        rows_out.extend(evaluate_bucket(f"model::{model}", rows))
    for key, rows in by_model_dataset.items():
        rows_out.extend(evaluate_bucket(f"model_dataset::{key}", rows))

    # Add baseline random expectation for transparency.
    # Expected overlap for random top-k without replacement: k * (H / N)
    for r in rows_out:
        N = float(r["ranked_count"] or 1)
        H = float(r["human_scored_count"] or 0)
        k = float(r["k"] or 0)
        expected = k * (H / N) if N > 0 else 0.0
        r["random_expected_overlap"] = expected
        r["lift_vs_random"] = (r["overlap_count"] / expected) if expected > 0 else 0.0

    rows_out.sort(key=lambda r: (r["bucket"], r["k"]))

    out_csv = output_prefix.with_name(output_prefix.name + "-topk.csv")
    out_json = output_prefix.with_name(output_prefix.name + "-summary.json")
    headers = [
        "bucket",
        "k",
        "ranked_count",
        "human_count",
        "human_scored_count",
        "overlap_count",
        "overlap_scored_count",
        "precision",
        "recall",
        "recall_scored",
        "random_expected_overlap",
        "lift_vs_random",
    ]
    with out_csv.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        w.writerows(rows_out)

    # Best model at primary k = first k value.
    primary_k = k_values[0]
    model_rows = [r for r in rows_out if r["bucket"].startswith("model::") and r["k"] == primary_k]
    model_rows.sort(key=lambda r: (r["overlap_count"], r["precision"], r["recall"]), reverse=True)
    summary = {
        "target_col": target_col,
        "human_count": len(human_ids),
        "k_values": k_values,
        "details_csvs": [str(p) for p in detail_paths],
        "labels_csv": str(labels_csv),
        "best_models_at_primary_k": model_rows[:5],
        "outputs": {
            "topk_csv": str(out_csv),
            "summary_json": str(out_json),
        },
    }
    out_json.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"wrote {out_csv}")
    print(f"wrote {out_json}")
    if model_rows:
        print("top model @k=", primary_k, "=>", model_rows[0]["bucket"], "overlap", model_rows[0]["overlap_count"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

