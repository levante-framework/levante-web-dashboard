#!/usr/bin/env python3
"""
Compute same-file hard-negative margins for translation validation.

For each item:
  pos_sim = cosine(emb(source_en), emb(target_lang_current_item))
  hard_neg_sim = max cosine(emb(source_en), emb(target_lang_other_item_in_same_file))
  margin = pos_sim - hard_neg_sim

Low margin means the source is nearly as close to another target in the same file,
which is a useful risk signal for consistency/confusion issues.
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
from typing import Dict, List, Optional, Tuple

import numpy as np
from sentence_transformers import SentenceTransformer


HTML_TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")
EXCLUDED_VALIDATION_PREFIXES = ["main/Z_LEGACY_DO_NOT_TRANSLATE/"]


@dataclass
class Row:
    row_index: int
    item_id: str
    path_prefix: str
    source: str
    target: str
    source_len: int
    target_len: int


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Compute hard-negative embedding margins.")
    p.add_argument("--input-csv", default="data/validation/crowdin-xliff-merged.csv")
    p.add_argument("--source-col", default="en")
    p.add_argument("--target-col", default="es-AR")
    p.add_argument("--id-col", default="identifier")
    p.add_argument("--path-col", default="_path")
    p.add_argument("--validation-json", default="data/validation/validation_results.shared.json")
    p.add_argument("--model", default="sentence-transformers/LaBSE")
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    p.add_argument("--batch-size", type=int, default=128)
    p.add_argument("--min-group-size", type=int, default=3, help="Min same-file rows for hard-negative search.")
    p.add_argument("--max-rows", type=int, default=0)
    p.add_argument("--output-prefix", default="data/validation/embedding-hard-negative-margin-es-AR")
    return p.parse_args()


def normalize_text(value: str, strip_html: bool = True) -> str:
    text = html.unescape(str(value or ""))
    if strip_html:
        text = HTML_TAG_RE.sub(" ", text)
    text = SPACE_RE.sub(" ", text).strip()
    return text


def maybe_prefix_for_e5(model_name: str, texts: List[str], prefix: str) -> List[str]:
    if "e5" not in model_name.lower():
        return texts
    return [f"{prefix}: {t}" for t in texts]


def canonical_lang(code: str) -> str:
    c = str(code or "").strip().replace("_", "-").lower()
    aliases = {
        "en": "en",
        "en-us": "en-US",
        "de": "de",
        "de-de": "de-DE",
        "de-ch": "de-CH",
        "es": "es",
        "es-co": "es-CO",
        "es-ar": "es-AR",
        "fr": "fr",
        "fr-ca": "fr-CA",
        "pt": "pt",
        "pt-br": "pt-BR",
        "pt-pt": "pt-PT",
        "nl": "nl",
    }
    return aliases.get(c, code or "")


def is_excluded_item_id(item_id: str) -> bool:
    norm = str(item_id or "").strip().lower()
    if not norm:
        return False
    return any(norm.startswith(p.lower()) for p in EXCLUDED_VALIDATION_PREFIXES)


def item_path_prefix(item_id: str, fallback_path: str) -> str:
    if fallback_path:
        return str(fallback_path).strip()
    raw = str(item_id or "")
    return raw.split("::", 1)[0] if "::" in raw else raw


def load_rows(args: argparse.Namespace) -> List[Row]:
    path = Path(args.input_csv)
    if not path.exists():
        raise FileNotFoundError(f"input csv not found: {path}")
    rows: List[Row] = []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        rd = csv.DictReader(f)
        for idx, r in enumerate(rd, start=2):
            item_id = normalize_text(r.get(args.id_col, ""), strip_html=False)
            if not item_id or is_excluded_item_id(item_id):
                continue
            source = normalize_text(r.get(args.source_col, ""))
            target = normalize_text(r.get(args.target_col, ""))
            if not source or not target:
                continue
            pref = item_path_prefix(item_id, normalize_text(r.get(args.path_col, ""), strip_html=False))
            rows.append(
                Row(
                    row_index=idx,
                    item_id=item_id,
                    path_prefix=pref,
                    source=source,
                    target=target,
                    source_len=len(source),
                    target_len=len(target),
                )
            )
            if args.max_rows > 0 and len(rows) >= args.max_rows:
                break
    return rows


def load_human_flags(validation_json: Path, lang_code: str) -> Set[str]:
    if not validation_json.exists():
        return set()
    payload = json.loads(validation_json.read_text(encoding="utf-8"))
    root = payload.get("validation_results", payload)
    lang = canonical_lang(lang_code)
    flagged = set()
    for item_id, by_lang in (root or {}).items():
        if is_excluded_item_id(item_id) or not isinstance(by_lang, dict):
            continue
        for lc, result in by_lang.items():
            if canonical_lang(lc) != lang or not isinstance(result, dict):
                continue
            if result.get("needsReview") is True:
                flagged.add(str(item_id))
            break
    return flagged


def percentile(values: List[float], q: float) -> float:
    if not values:
        return 0.0
    arr = np.array(values, dtype=np.float32)
    return float(np.percentile(arr, q))


def main() -> int:
    args = parse_args()
    rows = load_rows(args)
    if not rows:
        raise SystemExit("No usable rows after filtering.")

    device = None if args.device == "auto" else args.device
    model = SentenceTransformer(args.model, device=device)

    src_inputs = maybe_prefix_for_e5(args.model, [r.source for r in rows], "query")
    tgt_inputs = maybe_prefix_for_e5(args.model, [r.target for r in rows], "passage")

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

    # Group indices by path/file for hard-negative search.
    by_path: Dict[str, List[int]] = {}
    for i, r in enumerate(rows):
        by_path.setdefault(r.path_prefix, []).append(i)

    out = []
    margins: List[float] = []
    for i, r in enumerate(rows):
        grp = by_path.get(r.path_prefix, [])
        pos = float(np.dot(src_emb[i], tgt_emb[i]))

        hard_neg = None
        hard_neg_item = ""
        if len(grp) >= max(2, args.min_group_size):
            best = -2.0
            best_j = -1
            for j in grp:
                if j == i:
                    continue
                s = float(np.dot(src_emb[i], tgt_emb[j]))
                if s > best:
                    best = s
                    best_j = j
            if best_j >= 0:
                hard_neg = best
                hard_neg_item = rows[best_j].item_id

        margin = (pos - hard_neg) if hard_neg is not None else None
        if margin is not None:
            margins.append(margin)
        out.append(
            {
                "row_index": r.row_index,
                "item_id": r.item_id,
                "path_prefix": r.path_prefix,
                "source_text": r.source,
                "target_text": r.target,
                "pos_sim": round(pos, 6),
                "hard_neg_sim": "" if hard_neg is None else round(hard_neg, 6),
                "hard_neg_item_id": hard_neg_item,
                "margin": "" if margin is None else round(margin, 6),
                "source_len": r.source_len,
                "target_len": r.target_len,
            }
        )

    # Join with human flags for quick utility check.
    human = load_human_flags(Path(args.validation_json), args.target_col)
    for row in out:
        row["human_needs_review"] = 1 if row["item_id"] in human else 0

    valid_margin_rows = [r for r in out if isinstance(r.get("margin"), float)]
    valid_margin_rows.sort(key=lambda r: r["margin"])  # low margin => high risk

    k = min(len(human), len(valid_margin_rows))
    top_k = valid_margin_rows[:k]
    overlap_top_k = sum(1 for r in top_k if r["human_needs_review"] == 1)
    precision_top_k = (overlap_top_k / k) if k else 0.0
    recall_top_k = (overlap_top_k / len(human)) if human else 0.0

    out_prefix = Path(args.output_prefix)
    out_prefix.parent.mkdir(parents=True, exist_ok=True)
    out_csv = out_prefix.with_name(out_prefix.name + "-details.csv")
    out_json = out_prefix.with_name(out_prefix.name + "-summary.json")

    headers = [
        "row_index",
        "item_id",
        "path_prefix",
        "pos_sim",
        "hard_neg_sim",
        "margin",
        "hard_neg_item_id",
        "human_needs_review",
        "source_len",
        "target_len",
        "source_text",
        "target_text",
    ]
    with out_csv.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        w.writerows(out)

    margin_values = [float(r["margin"]) for r in valid_margin_rows]
    summary = {
        "input_csv": args.input_csv,
        "validation_json": args.validation_json,
        "target_col": args.target_col,
        "model": args.model,
        "counts": {
            "rows_scored": len(out),
            "rows_with_margin": len(valid_margin_rows),
            "human_needs_review_count": len(human),
        },
        "margin_distribution": {
            "min": min(margin_values) if margin_values else 0.0,
            "p10": percentile(margin_values, 10) if margin_values else 0.0,
            "p25": percentile(margin_values, 25) if margin_values else 0.0,
            "median": statistics.median(margin_values) if margin_values else 0.0,
            "p75": percentile(margin_values, 75) if margin_values else 0.0,
            "p90": percentile(margin_values, 90) if margin_values else 0.0,
            "max": max(margin_values) if margin_values else 0.0,
            "mean": statistics.mean(margin_values) if margin_values else 0.0,
        },
        "top_k_overlap_where_k_equals_human_count": {
            "k": k,
            "overlap_count": overlap_top_k,
            "precision": precision_top_k,
            "recall": recall_top_k,
        },
        "outputs": {
            "details_csv": str(out_csv),
            "summary_json": str(out_json),
        },
        "notes": [
            "Low margin indicates potential semantic confusion with another target in the same file.",
            "Use margin with other signals (reason text, score disagreement, consistency clusters).",
        ],
    }
    out_json.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"wrote {out_csv}")
    print(f"wrote {out_json}")
    print(json.dumps(summary["top_k_overlap_where_k_equals_human_count"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

