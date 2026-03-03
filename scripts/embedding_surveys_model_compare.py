#!/usr/bin/env python3
"""
Side-by-side multilingual embedding validation for survey translations.

Primary input target: Crowdin surveys CSV fallback used by dashboard:
https://raw.githubusercontent.com/levante-framework/levante_translations/l10n_pending/translations/surveys.csv
"""

from __future__ import annotations

import argparse
import csv
import html
import io
import json
import re
import statistics
import urllib.request
from pathlib import Path
from typing import Dict, List, Sequence

import numpy as np
from sentence_transformers import SentenceTransformer


DEFAULT_SURVEYS_URL = (
    "https://raw.githubusercontent.com/levante-framework/levante_translations/"
    "l10n_pending/translations/surveys.csv"
)
DEFAULT_MODELS = [
    "intfloat/multilingual-e5-base",
    "intfloat/multilingual-e5-large",
    "sentence-transformers/LaBSE",
]

LANG_COL_RE = re.compile(r"^[a-z]{2}(?:[-_][A-Za-z]{2})?$", re.I)
HTML_TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")


def normalize_text(value: str, strip_html: bool = True) -> str:
    text = html.unescape(str(value or ""))
    if strip_html:
        text = HTML_TAG_RE.sub(" ", text)
    return SPACE_RE.sub(" ", text).strip()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Compare multilingual embedding models on surveys CSV.")
    p.add_argument("--input-file", default="", help="Optional local surveys CSV path.")
    p.add_argument("--input-url", default=DEFAULT_SURVEYS_URL, help="Fallback/primary surveys CSV URL.")
    p.add_argument("--source-col", default="en", help="Source language column (default: en).")
    p.add_argument(
        "--target-cols",
        default="auto",
        help="Comma-separated target columns, or 'auto' to infer all non-English language columns.",
    )
    p.add_argument(
        "--models",
        default=",".join(DEFAULT_MODELS),
        help="Comma-separated SentenceTransformer models to compare.",
    )
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"], help="Inference device.")
    p.add_argument("--batch-size", type=int, default=256, help="Batch size per encode call.")
    p.add_argument("--min-score", type=float, default=0.85, help="Pass threshold.")
    p.add_argument("--warn-score", type=float, default=0.78, help="Review threshold lower bound.")
    p.add_argument("--max-rows-per-lang", type=int, default=0, help="Optional cap per target language.")
    p.add_argument("--no-strip-html", action="store_true", help="Disable HTML stripping before embeddings.")
    p.add_argument(
        "--output-prefix",
        default="data/validation/surveys-embedding-model-compare",
        help="Output prefix; writes <prefix>-summary.csv/json and <prefix>-details.csv",
    )
    return p.parse_args()


def fetch_csv_text(input_file: str, input_url: str) -> str:
    if input_file:
        path = Path(input_file).expanduser().resolve()
        return path.read_text(encoding="utf-8-sig")
    with urllib.request.urlopen(input_url, timeout=90) as resp:
        raw = resp.read()
    return raw.decode("utf-8-sig", errors="replace")


def resolve_target_columns(fieldnames: Sequence[str], source_col: str, target_cols_arg: str) -> List[str]:
    if target_cols_arg.strip().lower() != "auto":
        return [c.strip() for c in target_cols_arg.split(",") if c.strip()]
    targets: List[str] = []
    for col in fieldnames:
        if not LANG_COL_RE.match(col or ""):
            continue
        col_l = col.lower()
        if col_l == source_col.lower():
            continue
        # Skip English variants for validation against English source.
        if col_l.startswith("en"):
            continue
        targets.append(col)
    return targets


def categorize(score: float, min_score: float, warn_score: float) -> str:
    if score >= min_score:
        return "pass"
    if score >= warn_score:
        return "review"
    return "fail"


def model_inputs_for_name(model_name: str, texts: Sequence[str], prefix: str) -> List[str]:
    if "e5" not in model_name.lower():
        return list(texts)
    return [f"{prefix}: {t}" for t in texts]


def summarize_scores(scores: List[float], min_score: float, warn_score: float) -> Dict[str, float]:
    arr = np.array(scores, dtype=np.float32)
    pass_count = int(np.sum(arr >= min_score))
    review_count = int(np.sum((arr >= warn_score) & (arr < min_score)))
    fail_count = int(np.sum(arr < warn_score))
    return {
        "count": int(len(scores)),
        "pass_count": pass_count,
        "review_count": review_count,
        "fail_count": fail_count,
        "pass_rate": float(pass_count / len(scores)),
        "mean": float(np.mean(arr)),
        "median": float(np.median(arr)),
        "p10": float(np.percentile(arr, 10)),
        "p25": float(np.percentile(arr, 25)),
        "p75": float(np.percentile(arr, 75)),
        "p90": float(np.percentile(arr, 90)),
        "min": float(np.min(arr)),
        "max": float(np.max(arr)),
        "stdev": float(np.std(arr)),
    }


def main() -> None:
    args = parse_args()
    if args.warn_score > args.min_score:
        raise ValueError("--warn-score must be <= --min-score")

    csv_text = fetch_csv_text(args.input_file, args.input_url)
    rows = list(csv.DictReader(io.StringIO(csv_text)))
    if not rows:
        raise RuntimeError("No rows found in survey CSV input.")
    fieldnames = list(rows[0].keys())
    source_col = args.source_col
    if source_col not in fieldnames:
        raise RuntimeError(f"Source column '{source_col}' not found. Available: {fieldnames}")

    target_cols = resolve_target_columns(fieldnames, source_col, args.target_cols)
    if not target_cols:
        raise RuntimeError("No target columns resolved for comparison.")

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    if not models:
        raise RuntimeError("No models specified.")

    output_prefix = Path(args.output_prefix).expanduser().resolve()
    output_prefix.parent.mkdir(parents=True, exist_ok=True)
    summary_csv_path = Path(str(output_prefix) + "-summary.csv")
    summary_json_path = Path(str(output_prefix) + "-summary.json")
    details_csv_path = Path(str(output_prefix) + "-details.csv")

    strip_html = not args.no_strip_html
    device = None if args.device == "auto" else args.device

    print(f"Survey rows: {len(rows)}")
    print(f"Targets: {target_cols}")
    print(f"Models: {models}")
    print(f"Device mode: {args.device}")

    per_lang_pairs: Dict[str, Dict[str, List[str]]] = {}
    for lang in target_cols:
        ids: List[str] = []
        src_texts: List[str] = []
        tgt_texts: List[str] = []
        for row in rows:
            src = normalize_text(row.get(source_col, ""), strip_html=strip_html)
            tgt = normalize_text(row.get(lang, ""), strip_html=strip_html)
            if not src or not tgt:
                continue
            rid = normalize_text(row.get("identifier", ""), strip_html=False) or normalize_text(
                row.get("item_id", ""), strip_html=False
            )
            if not rid:
                rid = f"row-{len(ids)+1}"
            ids.append(rid)
            src_texts.append(src)
            tgt_texts.append(tgt)
            if args.max_rows_per_lang > 0 and len(ids) >= args.max_rows_per_lang:
                break
        per_lang_pairs[lang] = {"ids": ids, "src": src_texts, "tgt": tgt_texts}

    summary_rows: List[Dict[str, object]] = []
    detail_rows: List[Dict[str, object]] = []

    for model_name in models:
        print(f"\nLoading model: {model_name}")
        model = SentenceTransformer(model_name, device=device)
        for lang in target_cols:
            data = per_lang_pairs[lang]
            ids = data["ids"]
            src_texts = data["src"]
            tgt_texts = data["tgt"]
            if not ids:
                print(f"  {lang}: no valid rows")
                continue

            src_inputs = model_inputs_for_name(model_name, src_texts, "query")
            tgt_inputs = model_inputs_for_name(model_name, tgt_texts, "passage")
            src_emb = model.encode(
                src_inputs,
                batch_size=args.batch_size,
                show_progress_bar=True,
                convert_to_numpy=True,
                normalize_embeddings=True,
            )
            tgt_emb = model.encode(
                tgt_inputs,
                batch_size=args.batch_size,
                show_progress_bar=True,
                convert_to_numpy=True,
                normalize_embeddings=True,
            )
            scores = np.sum(src_emb * tgt_emb, axis=1).astype(np.float32).tolist()
            stats = summarize_scores(scores, args.min_score, args.warn_score)

            summary_rows.append(
                {
                    "model": model_name,
                    "target_col": lang,
                    "count": stats["count"],
                    "pass_count": stats["pass_count"],
                    "review_count": stats["review_count"],
                    "fail_count": stats["fail_count"],
                    "pass_rate": round(stats["pass_rate"], 6),
                    "mean": round(stats["mean"], 6),
                    "median": round(stats["median"], 6),
                    "p10": round(stats["p10"], 6),
                    "p25": round(stats["p25"], 6),
                    "p75": round(stats["p75"], 6),
                    "p90": round(stats["p90"], 6),
                    "min": round(stats["min"], 6),
                    "max": round(stats["max"], 6),
                    "stdev": round(stats["stdev"], 6),
                    "min_score": args.min_score,
                    "warn_score": args.warn_score,
                }
            )

            for rid, src, tgt, score in zip(ids, src_texts, tgt_texts, scores):
                detail_rows.append(
                    {
                        "model": model_name,
                        "target_col": lang,
                        "identifier": rid,
                        "similarity": round(float(score), 6),
                        "status": categorize(float(score), args.min_score, args.warn_score),
                        "source_text": src,
                        "target_text": tgt,
                    }
                )
            print(
                f"  {lang}: n={stats['count']} mean={stats['mean']:.4f} "
                f"pass_rate={stats['pass_rate']:.2%}"
            )

    # write outputs
    if summary_rows:
        with summary_csv_path.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(summary_rows[0].keys()))
            writer.writeheader()
            writer.writerows(summary_rows)

    if detail_rows:
        with details_csv_path.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(detail_rows[0].keys()))
            writer.writeheader()
            writer.writerows(detail_rows)

    aggregate = {
        "input_source": str(Path(args.input_file).expanduser().resolve()) if args.input_file else args.input_url,
        "source_col": source_col,
        "target_cols": target_cols,
        "models": models,
        "thresholds": {"pass": args.min_score, "review": args.warn_score},
        "rows_per_target": {lang: len(per_lang_pairs[lang]["ids"]) for lang in target_cols},
        "summary_rows": summary_rows,
        "notes": [
            "Side-by-side summary for survey-only strings.",
            "English variants are excluded from target columns in auto mode.",
            "Use details CSV to inspect low-similarity rows per model/language.",
        ],
    }
    summary_json_path.write_text(json.dumps(aggregate, indent=2), encoding="utf-8")

    print("\nOutputs")
    print("-------")
    print(f"Summary CSV: {summary_csv_path}")
    print(f"Summary JSON: {summary_json_path}")
    print(f"Details CSV: {details_csv_path}")


if __name__ == "__main__":
    main()

