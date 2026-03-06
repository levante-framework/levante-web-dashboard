#!/usr/bin/env python3
"""
Compare multilingual embedding models across surveys and item bank datasets.

This script is a multi-dataset extension of `embedding_surveys_model_compare.py`.
It can run surveys, item bank, or both in one command and writes separate outputs
per dataset plus a rollup summary when multiple datasets are requested.
"""

from __future__ import annotations

import argparse
import csv
import html
import io
import json
import re
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Sequence

import numpy as np


DEFAULT_SURVEYS_URL = (
    "https://raw.githubusercontent.com/levante-framework/levante_translations/"
    "l10n_pending/translations/surveys.csv"
)
DEFAULT_ITEMBANK_FILE = "public/translation_master.csv"
DEFAULT_MODELS = [
    "intfloat/multilingual-e5-base",
    "intfloat/multilingual-e5-large",
    "sentence-transformers/LaBSE",
]

LANG_COL_RE = re.compile(r"^[a-z]{2}(?:[-_][A-Za-z]{2})?$", re.I)
HTML_TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")


def get_sentence_transformer() -> Any:
    try:
        from sentence_transformers import SentenceTransformer
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Missing dependency: sentence-transformers. "
            "Install with: pip install sentence-transformers numpy"
        ) from exc
    return SentenceTransformer


def normalize_text(value: str, strip_html: bool = True) -> str:
    text = html.unescape(str(value or ""))
    if strip_html:
        text = HTML_TAG_RE.sub(" ", text)
    return SPACE_RE.sub(" ", text).strip()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Compare multilingual embedding models across surveys/itembank CSVs."
    )
    p.add_argument(
        "--dataset",
        default="both",
        choices=["surveys", "itembank", "both"],
        help="Dataset to run (default: both).",
    )
    p.add_argument(
        "--surveys-input-file",
        default="",
        help="Optional local surveys CSV path (overrides URL when provided).",
    )
    p.add_argument(
        "--surveys-input-url",
        default=DEFAULT_SURVEYS_URL,
        help="Surveys CSV URL fallback/primary source.",
    )
    p.add_argument(
        "--itembank-input-file",
        default=DEFAULT_ITEMBANK_FILE,
        help="Local item bank CSV path (default: public/translation_master.csv).",
    )
    p.add_argument(
        "--itembank-input-url",
        default="",
        help="Optional item bank CSV URL fallback if local file does not exist.",
    )
    p.add_argument("--source-col", default="en", help="Source language column (default: en).")
    p.add_argument(
        "--target-cols",
        default="auto",
        help="Comma-separated target columns, or 'auto' to infer non-English language columns.",
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
        default="data/validation/embedding-model-compare",
        help=(
            "Output prefix. For one dataset, writes <prefix>-summary/json/details. "
            "For both, writes <prefix>-<dataset>-summary/json/details and rollup files."
        ),
    )
    return p.parse_args()


def fetch_csv_text(input_file: str, input_url: str, label: str) -> str:
    if input_file:
        path = Path(input_file).expanduser().resolve()
        if path.exists():
            return path.read_text(encoding="utf-8-sig")
    if input_url:
        with urllib.request.urlopen(input_url, timeout=120) as resp:
            raw = resp.read()
        return raw.decode("utf-8-sig", errors="replace")
    raise RuntimeError(f"No readable input for dataset '{label}'.")


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


def write_csv(path: Path, rows: List[Dict[str, object]]) -> None:
    if not rows:
        return
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def run_dataset(
    dataset: str,
    csv_text: str,
    args: argparse.Namespace,
    models: List[str],
    device: str | None,
    strip_html: bool,
) -> Dict[str, object]:
    rows = list(csv.DictReader(io.StringIO(csv_text)))
    if not rows:
        raise RuntimeError(f"No rows found for dataset '{dataset}'.")
    fieldnames = list(rows[0].keys())
    source_col = args.source_col
    if source_col not in fieldnames:
        raise RuntimeError(f"Source column '{source_col}' not found for dataset '{dataset}'.")

    target_cols = resolve_target_columns(fieldnames, source_col, args.target_cols)
    if not target_cols:
        raise RuntimeError(f"No target columns resolved for dataset '{dataset}'.")

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
            rid = (
                normalize_text(row.get("identifier", ""), strip_html=False)
                or normalize_text(row.get("item_id", ""), strip_html=False)
                or normalize_text(row.get("id", ""), strip_html=False)
                or normalize_text(row.get("key", ""), strip_html=False)
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

    print(f"\n=== Dataset: {dataset} ===")
    print(f"Rows: {len(rows)} | Targets: {target_cols}")
    for model_name in models:
        print(f"\nLoading model: {model_name}")
        SentenceTransformer = get_sentence_transformer()
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
                    "dataset": dataset,
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
                        "dataset": dataset,
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

    best_by_target: Dict[str, Dict[str, object]] = {}
    for lang in target_cols:
        ranked = [r for r in summary_rows if r["target_col"] == lang]
        if not ranked:
            continue
        ranked.sort(key=lambda r: (float(r["pass_rate"]), float(r["mean"])), reverse=True)
        best_by_target[lang] = {
            "model": ranked[0]["model"],
            "pass_rate": ranked[0]["pass_rate"],
            "mean": ranked[0]["mean"],
            "count": ranked[0]["count"],
        }

    return {
        "dataset": dataset,
        "source_col": source_col,
        "target_cols": target_cols,
        "rows_per_target": {lang: len(per_lang_pairs[lang]["ids"]) for lang in target_cols},
        "summary_rows": summary_rows,
        "detail_rows": detail_rows,
        "best_by_target": best_by_target,
        "raw_row_count": len(rows),
    }


def main() -> None:
    args = parse_args()
    if args.warn_score > args.min_score:
        raise ValueError("--warn-score must be <= --min-score")

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    if not models:
        raise RuntimeError("No models specified.")

    datasets = ["surveys", "itembank"] if args.dataset == "both" else [args.dataset]
    output_prefix = Path(args.output_prefix).expanduser().resolve()
    output_prefix.parent.mkdir(parents=True, exist_ok=True)
    strip_html = not args.no_strip_html
    device = None if args.device == "auto" else args.device

    print(f"Datasets: {datasets}")
    print(f"Models:   {models}")
    print(f"Device:   {args.device}")

    dataset_results: Dict[str, Dict[str, object]] = {}
    all_summary_rows: List[Dict[str, object]] = []

    for dataset in datasets:
        if dataset == "surveys":
            csv_text = fetch_csv_text(args.surveys_input_file, args.surveys_input_url, "surveys")
            source_ref = (
                str(Path(args.surveys_input_file).expanduser().resolve())
                if args.surveys_input_file
                else args.surveys_input_url
            )
        else:
            csv_text = fetch_csv_text(args.itembank_input_file, args.itembank_input_url, "itembank")
            source_ref = (
                str(Path(args.itembank_input_file).expanduser().resolve())
                if args.itembank_input_file
                else args.itembank_input_url
            )

        result = run_dataset(dataset, csv_text, args, models, device, strip_html)
        result["input_source"] = source_ref
        dataset_results[dataset] = result
        all_summary_rows.extend(result["summary_rows"])  # type: ignore[arg-type]

    if len(datasets) == 1:
        dataset = datasets[0]
        result = dataset_results[dataset]
        summary_csv_path = Path(str(output_prefix) + "-summary.csv")
        summary_json_path = Path(str(output_prefix) + "-summary.json")
        details_csv_path = Path(str(output_prefix) + "-details.csv")
        write_csv(summary_csv_path, result["summary_rows"])  # type: ignore[arg-type]
        write_csv(details_csv_path, result["detail_rows"])  # type: ignore[arg-type]
        summary_json_path.write_text(
            json.dumps(
                {
                    "dataset": dataset,
                    "source": result["input_source"],
                    "models": models,
                    "targets": result["target_cols"],
                    "best_by_target": result["best_by_target"],
                    "rows_per_target": result["rows_per_target"],
                    "summary_rows": result["summary_rows"],
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print("\nOutputs")
        print("-------")
        print(f"Summary CSV: {summary_csv_path}")
        print(f"Summary JSON: {summary_json_path}")
        print(f"Details CSV: {details_csv_path}")
        return

    for dataset in datasets:
        result = dataset_results[dataset]
        summary_csv_path = Path(str(output_prefix) + f"-{dataset}-summary.csv")
        summary_json_path = Path(str(output_prefix) + f"-{dataset}-summary.json")
        details_csv_path = Path(str(output_prefix) + f"-{dataset}-details.csv")
        write_csv(summary_csv_path, result["summary_rows"])  # type: ignore[arg-type]
        write_csv(details_csv_path, result["detail_rows"])  # type: ignore[arg-type]
        summary_json_path.write_text(
            json.dumps(
                {
                    "dataset": dataset,
                    "source": result["input_source"],
                    "models": models,
                    "targets": result["target_cols"],
                    "best_by_target": result["best_by_target"],
                    "rows_per_target": result["rows_per_target"],
                    "summary_rows": result["summary_rows"],
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    rollup_csv_path = Path(str(output_prefix) + "-rollup-summary.csv")
    rollup_json_path = Path(str(output_prefix) + "-rollup-summary.json")
    write_csv(rollup_csv_path, all_summary_rows)
    rollup_json_path.write_text(
        json.dumps(
            {
                "datasets": datasets,
                "models": models,
                "results": {
                    dataset: {
                        "source": dataset_results[dataset]["input_source"],
                        "targets": dataset_results[dataset]["target_cols"],
                        "best_by_target": dataset_results[dataset]["best_by_target"],
                        "rows_per_target": dataset_results[dataset]["rows_per_target"],
                    }
                    for dataset in datasets
                },
                "summary_rows": all_summary_rows,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print("\nOutputs")
    print("-------")
    for dataset in datasets:
        print(f"{dataset} summary CSV:  {Path(str(output_prefix) + f'-{dataset}-summary.csv')}")
        print(f"{dataset} summary JSON: {Path(str(output_prefix) + f'-{dataset}-summary.json')}")
        print(f"{dataset} details CSV:  {Path(str(output_prefix) + f'-{dataset}-details.csv')}")
    print(f"Rollup CSV: {rollup_csv_path}")
    print(f"Rollup JSON: {rollup_json_path}")


if __name__ == "__main__":
    main()

