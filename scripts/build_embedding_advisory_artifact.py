#!/usr/bin/env python3
"""
Build advisory-only embedding artifact for dashboard consumption.

Inputs:
- Summary CSV(s) and details CSV(s) produced by
  scripts/embedding_multidataset_model_compare.py

Output:
- JSON artifact with one advisory row per item/language (best model per language).
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
from pathlib import Path
from typing import Dict, List, Tuple


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build embedding advisory artifact JSON.")
    p.add_argument(
        "--input-prefix",
        default="data/validation/embedding-model-compare-full",
        help="Input compare prefix (default: data/validation/embedding-model-compare-full).",
    )
    p.add_argument(
        "--output-json",
        default="data/validation/embedding-advisory.json",
        help="Output advisory JSON path.",
    )
    p.add_argument(
        "--datasets",
        default="surveys,itembank,dashboard",
        help="Comma-separated datasets to include (default: surveys,itembank,dashboard).",
    )
    p.add_argument("--min-score", type=float, default=0.85, help="Pass threshold for advisory status.")
    p.add_argument("--warn-score", type=float, default=0.78, help="Review threshold lower bound.")
    return p.parse_args()


def advisory_status(score: float, min_score: float, warn_score: float) -> str:
    if score >= min_score:
        return "pass"
    if score >= warn_score:
        return "review"
    return "fail"


def read_csv_rows(path: Path) -> List[Dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def pick_best_model_by_lang(summary_rows: List[Dict[str, str]]) -> Dict[str, str]:
    best: Dict[str, Tuple[float, float, str]] = {}
    for row in summary_rows:
        lang = str(row.get("target_col", "")).strip()
        model = str(row.get("model", "")).strip()
        if not lang or not model:
            continue
        pass_rate = float(row.get("pass_rate") or 0.0)
        mean = float(row.get("mean") or 0.0)
        current = best.get(lang)
        if current is None or (pass_rate, mean) > (current[0], current[1]):
            best[lang] = (pass_rate, mean, model)
    return {lang: triple[2] for lang, triple in best.items()}


def main() -> None:
    args = parse_args()
    input_prefix = Path(args.input_prefix).expanduser().resolve()
    output_json = Path(args.output_json).expanduser().resolve()
    output_json.parent.mkdir(parents=True, exist_ok=True)
    datasets = [d.strip() for d in args.datasets.split(",") if d.strip()]

    # Aggregate duplicates by (itemId, langCode, dataset), keeping the lowest score
    # as a conservative advisory signal.
    dedup: Dict[Tuple[str, str, str], Dict[str, object]] = {}
    coverage: Dict[str, Dict[str, int]] = {}
    best_models_by_dataset: Dict[str, Dict[str, str]] = {}

    for dataset in datasets:
        summary_path = Path(str(input_prefix) + f"-{dataset}-summary.csv")
        details_path = Path(str(input_prefix) + f"-{dataset}-details.csv")
        summary_rows = read_csv_rows(summary_path)
        details_rows = read_csv_rows(details_path)
        if not summary_rows or not details_rows:
            print(f"Skipping dataset={dataset}: missing summary/details.")
            continue

        best_models = pick_best_model_by_lang(summary_rows)
        best_models_by_dataset[dataset] = best_models
        coverage[dataset] = {"rows": 0, "langs": len(best_models)}

        for row in details_rows:
            lang = str(row.get("target_col", "")).strip()
            model = str(row.get("model", "")).strip()
            if not lang or not model:
                continue
            if best_models.get(lang) != model:
                continue
            item_id = str(row.get("identifier", "")).strip()
            if not item_id:
                continue
            score = float(row.get("similarity") or 0.0)
            key = (item_id, lang, dataset)
            candidate = {
                "itemId": item_id,
                "langCode": lang,
                "dataset": dataset,
                "model": model,
                "score": round(score, 6),
                "status": advisory_status(score, args.min_score, args.warn_score),
                "source": "embedding_offline",
                "advisoryOnly": True,
                "occurrenceCount": 1,
            }
            existing = dedup.get(key)
            if existing is None:
                dedup[key] = candidate
            else:
                existing_score = float(existing.get("score") or 0.0)
                if score < existing_score:
                    existing["score"] = round(score, 6)
                    existing["status"] = advisory_status(score, args.min_score, args.warn_score)
                existing["occurrenceCount"] = int(existing.get("occurrenceCount") or 1) + 1
            coverage[dataset]["rows"] += 1

    entries: List[Dict[str, object]] = list(dedup.values())
    artifact = {
        "schemaVersion": "embedding_advisory_v1",
        "advisoryOnly": True,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "thresholds": {"pass": args.min_score, "review": args.warn_score},
        "inputPrefix": str(input_prefix),
        "datasets": datasets,
        "bestModelByDatasetAndLang": best_models_by_dataset,
        "coverage": coverage,
        "entries": entries,
    }
    output_json.write_text(json.dumps(artifact, indent=2), encoding="utf-8")
    print(f"Advisory artifact written: {output_json}")
    print(f"Entries: {len(entries)}")


if __name__ == "__main__":
    main()

