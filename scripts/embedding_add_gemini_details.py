#!/usr/bin/env python3
"""
Add Gemini embedding similarities to bake-off details corpus.

Reads one or more existing details CSVs (any model) to collect unique
source/target pairs, calls semantic scoring API (Gemini-backed), and writes
details CSV rows matching the existing bake-off schema.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Tuple


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate Gemini details CSV for embedding bake-off.")
    p.add_argument(
        "--input-details-csvs",
        default=(
            "data/validation/embedding-model-compare-bakeoff-itembank-details.csv,"
            "data/validation/embedding-model-compare-bakeoff-dashboard-details.csv,"
            "data/validation/embedding-model-compare-bakeoff-surveys-details.csv"
        ),
        help="Comma-separated details CSVs used to build unique text pairs.",
    )
    p.add_argument("--target-col", default="es-AR")
    p.add_argument(
        "--semantic-api-url",
        default="https://levante-cockpit.vercel.app/api/translation-semantic-score",
        help="Semantic scoring endpoint URL.",
    )
    p.add_argument(
        "--model-label",
        default="gemini-embedding-001",
        help="Model label to stamp into output rows.",
    )
    p.add_argument("--max-workers", type=int, default=6, help="Concurrent API calls.")
    p.add_argument("--timeout-sec", type=int, default=45, help="Per-request timeout.")
    p.add_argument("--retries", type=int, default=3, help="Retry attempts per row.")
    p.add_argument(
        "--output-csv",
        default="data/validation/embedding-model-compare-bakeoff-gemini-details.csv",
        help="Output details CSV path.",
    )
    return p.parse_args()


def parse_csv_paths(raw: str) -> List[Path]:
    out = []
    for tok in str(raw or "").split(","):
        tok = tok.strip()
        if tok:
            out.append(Path(tok))
    return out


def normalize_lang(value: str) -> str:
    token = str(value or "").strip().replace("_", "-")
    lowered = token.lower()
    if lowered == "es-ar":
        return "es-AR"
    if lowered == "es-co":
        return "es-CO"
    if lowered == "de":
        return "de"
    if lowered == "en":
        return "en"
    return token


def classify_status(similarity_0_to_1: float, min_score: float = 0.85, warn_score: float = 0.78) -> str:
    if similarity_0_to_1 >= min_score:
        return "pass"
    if similarity_0_to_1 >= warn_score:
        return "review"
    return "fail"


def call_semantic_api(
    url: str,
    original_text: str,
    back_translation: str,
    lang_code: str,
    timeout_sec: int,
    retries: int,
) -> Tuple[float, str]:
    payload = {
        "originalText": str(original_text or ""),
        "backTranslation": str(back_translation or ""),
        "langCode": str(lang_code or ""),
    }
    last_error: Exception | None = None
    for attempt in range(max(1, retries)):
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if not data or data.get("ok") is not True:
                reason = data.get("reason") if isinstance(data, dict) else "unknown"
                raise RuntimeError(f"semantic api skipped/failed: {reason}")
            raw_score = data.get("semantic_score")
            if not isinstance(raw_score, (int, float)):
                raise RuntimeError("semantic_score missing or invalid")
            similarity = max(0.0, min(1.0, float(raw_score) / 100.0))
            model_used = str(data.get("modelUsed") or "").strip()
            return similarity, model_used
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < retries - 1:
                time.sleep(0.8 * (2 ** attempt))
            continue
    raise RuntimeError(str(last_error) if last_error else "semantic api failed")


def main() -> int:
    args = parse_args()
    paths = parse_csv_paths(args.input_details_csvs)
    target_col = normalize_lang(args.target_col)
    if not paths:
        raise SystemExit("No input details CSV paths provided.")

    # Collect unique pairs using dataset+identifier granularity.
    pairs: Dict[Tuple[str, str, str], Dict[str, str]] = {}
    for p in paths:
        with p.open("r", encoding="utf-8", newline="") as f:
            rd = csv.DictReader(f)
            for r in rd:
                if normalize_lang(r.get("target_col", "")) != target_col:
                    continue
                dataset = str(r.get("dataset", "") or "").strip()
                identifier = str(r.get("identifier", "") or "").strip()
                source_text = str(r.get("source_text", "") or "")
                target_text = str(r.get("target_text", "") or "")
                if not dataset or not identifier or not source_text or not target_text:
                    continue
                key = (dataset, target_col, identifier)
                if key not in pairs:
                    pairs[key] = {
                        "dataset": dataset,
                        "target_col": target_col,
                        "identifier": identifier,
                        "source_text": source_text,
                        "target_text": target_text,
                    }

    if not pairs:
        raise SystemExit(f"No rows found for target_col={target_col}.")

    keys = list(pairs.keys())
    out_rows: List[Dict[str, object]] = []
    failures: List[str] = []
    resolved_label = str(args.model_label or "").strip() or "gemini-embedding-001"

    print(f"Scoring {len(keys)} unique pairs with Gemini endpoint...")
    with ThreadPoolExecutor(max_workers=max(1, args.max_workers)) as ex:
        fut_map = {}
        for key in keys:
            row = pairs[key]
            fut = ex.submit(
                call_semantic_api,
                args.semantic_api_url,
                row["source_text"],
                row["target_text"],
                row["target_col"],
                args.timeout_sec,
                args.retries,
            )
            fut_map[fut] = key

        completed = 0
        for fut in as_completed(fut_map):
            key = fut_map[fut]
            row = pairs[key]
            completed += 1
            if completed % 200 == 0 or completed == len(keys):
                print(f"  progress: {completed}/{len(keys)}")
            try:
                similarity, model_used = fut.result()
                model_name = model_used or resolved_label
                out_rows.append(
                    {
                        "dataset": row["dataset"],
                        "model": model_name,
                        "target_col": row["target_col"],
                        "identifier": row["identifier"],
                        "similarity": round(float(similarity), 6),
                        "status": classify_status(float(similarity)),
                        "source_text": row["source_text"],
                        "target_text": row["target_text"],
                    }
                )
            except Exception as exc:  # noqa: BLE001
                failures.append(f"{row['identifier']}: {exc}")

    if failures:
        print(f"WARNING: {len(failures)} rows failed.")
        for msg in failures[:10]:
            print("  ", msg)
        if len(failures) > 10:
            print(f"  ... and {len(failures) - 10} more")

    # Keep deterministic output ordering.
    out_rows.sort(key=lambda r: (str(r["dataset"]), str(r["identifier"])))

    output_csv = Path(args.output_csv)
    output_csv.parent.mkdir(parents=True, exist_ok=True)
    headers = ["dataset", "model", "target_col", "identifier", "similarity", "status", "source_text", "target_text"]
    with output_csv.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        w.writerows(out_rows)

    print(f"wrote {output_csv} rows={len(out_rows)}")
    if failures:
        print("NOTE: bake-off will use only successful rows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

