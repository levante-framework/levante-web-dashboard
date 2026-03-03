#!/usr/bin/env python3
"""
Cross-lingual translation validation using multilingual embeddings.

This script compares source and translated text directly (no back-translation)
by computing cosine similarity between multilingual sentence embeddings.
It is designed to run locally and can use NVIDIA GPU via CUDA-enabled PyTorch.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
from sentence_transformers import SentenceTransformer


HTML_TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")


@dataclass
class RowPair:
    row_index: int
    item_id: str
    source: str
    target: str


def normalize_text(value: str, strip_html: bool = True) -> str:
    text = html.unescape(str(value or ""))
    if strip_html:
        text = HTML_TAG_RE.sub(" ", text)
    text = SPACE_RE.sub(" ", text).strip()
    return text


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate translations with multilingual embedding similarity."
    )
    parser.add_argument("--input", required=True, help="Input CSV path.")
    parser.add_argument(
        "--source-col",
        default="en",
        help="Source-language column name (default: en).",
    )
    parser.add_argument(
        "--target-col",
        required=True,
        help="Target-language column name to validate (example: es-CO, de, fr-CA).",
    )
    parser.add_argument(
        "--id-col",
        default="item_id",
        help="Identifier column name (default: item_id).",
    )
    parser.add_argument(
        "--model",
        default="intfloat/multilingual-e5-base",
        help="Hugging Face / SentenceTransformer model name.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cuda", "cpu"],
        help="Inference device (default: auto).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=128,
        help="Embedding batch size (default: 128).",
    )
    parser.add_argument(
        "--min-score",
        type=float,
        default=0.85,
        help="Pass threshold (default: 0.85).",
    )
    parser.add_argument(
        "--warn-score",
        type=float,
        default=0.78,
        help="Review threshold lower bound (default: 0.78).",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=0,
        help="Optional cap for rows to process (0 = all).",
    )
    parser.add_argument(
        "--no-strip-html",
        action="store_true",
        help="Disable HTML stripping before embedding.",
    )
    parser.add_argument(
        "--output-csv",
        default="",
        help="Output CSV path (default: ./embedding-validation-<target-col>.csv).",
    )
    parser.add_argument(
        "--summary-json",
        default="",
        help="Optional summary JSON path.",
    )
    return parser.parse_args()


def load_pairs(
    input_path: Path,
    id_col: str,
    source_col: str,
    target_col: str,
    strip_html: bool,
    max_rows: int,
) -> Tuple[List[RowPair], Dict[str, int]]:
    pairs: List[RowPair] = []
    stats = {
        "total_rows": 0,
        "missing_source": 0,
        "missing_target": 0,
        "missing_both": 0,
        "processed_rows": 0,
    }

    with input_path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames:
            raise ValueError("Input CSV has no header row.")

        for idx, row in enumerate(reader):
            stats["total_rows"] += 1
            source = normalize_text(row.get(source_col, ""), strip_html=strip_html)
            target = normalize_text(row.get(target_col, ""), strip_html=strip_html)
            item_id = normalize_text(row.get(id_col, ""), strip_html=False) or f"row-{idx+2}"

            if not source and not target:
                stats["missing_both"] += 1
                continue
            if not source:
                stats["missing_source"] += 1
                continue
            if not target:
                stats["missing_target"] += 1
                continue

            pairs.append(
                RowPair(
                    row_index=idx + 2,  # 1-based header + row offset
                    item_id=item_id,
                    source=source,
                    target=target,
                )
            )
            if max_rows > 0 and len(pairs) >= max_rows:
                break

    stats["processed_rows"] = len(pairs)
    return pairs, stats


def maybe_prefix_for_e5(model_name: str, texts: List[str], prefix: str) -> List[str]:
    if "e5" not in model_name.lower():
        return texts
    return [f"{prefix}: {t}" for t in texts]


def categorize(score: float, min_score: float, warn_score: float) -> str:
    if score >= min_score:
        return "pass"
    if score >= warn_score:
        return "review"
    return "fail"


def percentile(scores: List[float], q: float) -> float:
    if not scores:
        return 0.0
    arr = np.array(scores, dtype=np.float32)
    return float(np.percentile(arr, q))


def main() -> None:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    if args.warn_score > args.min_score:
        raise ValueError("--warn-score must be <= --min-score")

    output_csv = (
        Path(args.output_csv).expanduser().resolve()
        if args.output_csv
        else Path.cwd() / f"embedding-validation-{args.target_col}.csv"
    )
    summary_json = Path(args.summary_json).expanduser().resolve() if args.summary_json else None

    device = None if args.device == "auto" else args.device

    pairs, load_stats = load_pairs(
        input_path=input_path,
        id_col=args.id_col,
        source_col=args.source_col,
        target_col=args.target_col,
        strip_html=not args.no_strip_html,
        max_rows=args.max_rows,
    )
    if not pairs:
        raise RuntimeError("No valid rows to process after filtering missing source/target text.")

    print(f"Loaded {len(pairs)} rows for scoring from {input_path}")
    print(f"Model: {args.model} | Device: {args.device} | Batch size: {args.batch_size}")

    model = SentenceTransformer(args.model, device=device)

    source_texts = [p.source for p in pairs]
    target_texts = [p.target for p in pairs]
    source_inputs = maybe_prefix_for_e5(args.model, source_texts, "query")
    target_inputs = maybe_prefix_for_e5(args.model, target_texts, "passage")

    source_emb = model.encode(
        source_inputs,
        batch_size=args.batch_size,
        show_progress_bar=True,
        convert_to_numpy=True,
        normalize_embeddings=True,
    )
    target_emb = model.encode(
        target_inputs,
        batch_size=args.batch_size,
        show_progress_bar=True,
        convert_to_numpy=True,
        normalize_embeddings=True,
    )

    scores = np.sum(source_emb * target_emb, axis=1)

    rows_out: List[Dict[str, object]] = []
    pass_count = 0
    review_count = 0
    fail_count = 0

    for pair, score in zip(pairs, scores):
        score_f = float(score)
        status = categorize(score_f, args.min_score, args.warn_score)
        if status == "pass":
            pass_count += 1
        elif status == "review":
            review_count += 1
        else:
            fail_count += 1

        rows_out.append(
            {
                "row_index": pair.row_index,
                "item_id": pair.item_id,
                "source_col": args.source_col,
                "target_col": args.target_col,
                "source_text": pair.source,
                "target_text": pair.target,
                "similarity": round(score_f, 6),
                "status": status,
                "source_len": len(pair.source),
                "target_len": len(pair.target),
            }
        )

    output_csv.parent.mkdir(parents=True, exist_ok=True)
    with output_csv.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "row_index",
                "item_id",
                "source_col",
                "target_col",
                "source_text",
                "target_text",
                "similarity",
                "status",
                "source_len",
                "target_len",
            ],
        )
        writer.writeheader()
        writer.writerows(rows_out)

    score_list = [float(s) for s in scores.tolist()]
    summary = {
        "input": str(input_path),
        "output_csv": str(output_csv),
        "model": args.model,
        "device": args.device,
        "source_col": args.source_col,
        "target_col": args.target_col,
        "thresholds": {"pass": args.min_score, "review": args.warn_score},
        "counts": {
            "processed": len(rows_out),
            "pass": pass_count,
            "review": review_count,
            "fail": fail_count,
        },
        "distribution": {
            "min": min(score_list),
            "p10": percentile(score_list, 10),
            "p25": percentile(score_list, 25),
            "median": statistics.median(score_list),
            "p75": percentile(score_list, 75),
            "p90": percentile(score_list, 90),
            "max": max(score_list),
            "mean": statistics.mean(score_list),
            "stdev": statistics.pstdev(score_list) if len(score_list) > 1 else 0.0,
        },
        "load_stats": load_stats,
        "notes": [
            "Similarity is cosine over L2-normalized sentence embeddings.",
            "For E5-family models, source is encoded as 'query:' and translation as 'passage:'.",
            "Use this as a quality filter; calibrate thresholds on your known-good/known-bad examples.",
        ],
    }

    if summary_json:
        summary_json.parent.mkdir(parents=True, exist_ok=True)
        summary_json.write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(f"Summary JSON written: {summary_json}")

    print("\nValidation summary")
    print("------------------")
    print(f"Processed: {summary['counts']['processed']}")
    print(f"Pass:      {summary['counts']['pass']}")
    print(f"Review:    {summary['counts']['review']}")
    print(f"Fail:      {summary['counts']['fail']}")
    print(f"Mean sim:  {summary['distribution']['mean']:.4f}")
    print(f"Median:    {summary['distribution']['median']:.4f}")
    print(f"P10/P90:   {summary['distribution']['p10']:.4f} / {summary['distribution']['p90']:.4f}")
    print(f"\nOutput CSV written: {output_csv}")


if __name__ == "__main__":
    main()

