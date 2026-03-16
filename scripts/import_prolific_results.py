#!/usr/bin/env python3
"""
Import Prolific responses and convert to calibration-friendly seed labels.
"""

from __future__ import annotations

import argparse
import csv
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List


EQUIV_SAME = "same_meaning"
EQUIV_MOSTLY = "mostly_same"
EQUIV_DIFF = "different_meaning"
EQUIV_CANNOT = "cannot_judge"
VALID_EQUIV = {EQUIV_SAME, EQUIV_MOSTLY, EQUIV_DIFF, EQUIV_CANNOT}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Import Prolific translation evaluation results.")
    p.add_argument("--responses-csv", required=True)
    p.add_argument("--translations-csv", default="data/validation/crowdin-xliff-merged.csv")
    p.add_argument("--target-col", default="es-AR")
    p.add_argument("--source-col", default="en")
    p.add_argument("--output-prefix", default="data/validation/prolific-es-AR")
    p.add_argument("--min-valid-votes", type=int, default=2)
    p.add_argument("--diff-threshold", type=float, default=0.34)
    return p.parse_args()


def path_prefix(item_id: str) -> str:
    raw = str(item_id or "")
    if "::" in raw:
        raw = raw.split("::", 1)[0]
    parts = [p for p in raw.split("/") if p]
    if len(parts) >= 3:
        return "/".join(parts[:3])
    return "/".join(parts) if parts else "unknown"


def load_translation_index(path: Path, source_col: str, target_col: str) -> Dict[str, dict]:
    out = {}
    with path.open("r", encoding="utf-8", newline="") as f:
        rd = csv.DictReader(f)
        for r in rd:
            item_id = str(r.get("identifier") or r.get("item_id") or "").strip()
            if not item_id:
                continue
            out[item_id] = {
                "source_en": str(r.get(source_col, "") or "").strip(),
                "translation_target": str(r.get(target_col, "") or "").strip(),
                "content_type": str(r.get("contentType", "") or "general").strip().lower() or "general",
                "path_prefix": path_prefix(item_id),
            }
    return out


def parse_float(v, default=None):
    try:
        return float(v)
    except Exception:
        return default


def parse_int(v, default=0):
    try:
        return int(v)
    except Exception:
        return default


def normalize_equiv(v: str) -> str:
    s = str(v or "").strip().lower().replace(" ", "_")
    mapping = {
        "same": EQUIV_SAME,
        "same_meaning": EQUIV_SAME,
        "mostly": EQUIV_MOSTLY,
        "mostly_same": EQUIV_MOSTLY,
        "different": EQUIV_DIFF,
        "different_meaning": EQUIV_DIFF,
        "cannot": EQUIV_CANNOT,
        "cannot_judge": EQUIV_CANNOT,
    }
    s = mapping.get(s, s)
    return s if s in VALID_EQUIV else EQUIV_CANNOT


def main() -> int:
    args = parse_args()
    responses_csv = Path(args.responses_csv)
    translations_csv = Path(args.translations_csv)
    out_prefix = Path(args.output_prefix)
    out_prefix.parent.mkdir(parents=True, exist_ok=True)

    tindex = load_translation_index(translations_csv, args.source_col, args.target_col)

    by_item: Dict[str, List[dict]] = defaultdict(list)
    with responses_csv.open("r", encoding="utf-8", newline="") as f:
        rd = csv.DictReader(f)
        for r in rd:
            item_id = str(r.get("item_id", "")).strip()
            if not item_id:
                continue
            lang_code = str(r.get("lang_code", "")).strip() or args.target_col
            if lang_code != args.target_col:
                continue
            qc = str(r.get("rater_passed_qc", "1")).strip().lower()
            qc_pass = qc not in {"0", "false", "no", "fail"}
            if not qc_pass:
                continue
            by_item[item_id].append(r)

    aggregated = []
    seed_rows = []
    for item_id, votes in by_item.items():
        equiv = [normalize_equiv(v.get("equivalence_rating", "")) for v in votes]
        clarity = [parse_float(v.get("child_clarity_rating"), None) for v in votes]
        clarity = [c for c in clarity if c is not None]
        counts = Counter(equiv)
        valid_votes = counts[EQUIV_SAME] + counts[EQUIV_MOSTLY] + counts[EQUIV_DIFF]
        diff_ratio = (counts[EQUIV_DIFF] / valid_votes) if valid_votes else 0.0
        concern_ratio = ((counts[EQUIV_DIFF] + counts[EQUIV_MOSTLY]) / valid_votes) if valid_votes else 0.0
        agreement = (max(counts.values()) / len(votes)) if votes else 0.0
        avg_clarity = (sum(clarity) / len(clarity)) if clarity else None

        enough_votes = valid_votes >= args.min_valid_votes
        needs_review = 0
        reason_tags = []
        if enough_votes:
            if diff_ratio >= args.diff_threshold:
                needs_review = 1
                reason_tags.append("prolific:different_meaning")
            elif concern_ratio > 0.5:
                needs_review = 1
                reason_tags.append("prolific:mostly_or_different_majority")
            elif avg_clarity is not None and avg_clarity < 3.0:
                needs_review = 1
                reason_tags.append("prolific:low_child_clarity")
        else:
            reason_tags.append("prolific:insufficient_votes")

        trow = tindex.get(item_id, {})
        summary_note = (
            f"votes same={counts[EQUIV_SAME]} mostly={counts[EQUIV_MOSTLY]} "
            f"different={counts[EQUIV_DIFF]} cannot={counts[EQUIV_CANNOT]}; "
            f"agreement={agreement:.2f}; avg_clarity={avg_clarity:.2f}" if avg_clarity is not None
            else f"votes same={counts[EQUIV_SAME]} mostly={counts[EQUIV_MOSTLY]} "
            f"different={counts[EQUIV_DIFF]} cannot={counts[EQUIV_CANNOT]}; agreement={agreement:.2f}"
        )

        aggregated.append(
            {
                "item_id": item_id,
                "lang_code": args.target_col,
                "n_votes": len(votes),
                "valid_votes": valid_votes,
                "votes_same_meaning": counts[EQUIV_SAME],
                "votes_mostly_same": counts[EQUIV_MOSTLY],
                "votes_different_meaning": counts[EQUIV_DIFF],
                "votes_cannot_judge": counts[EQUIV_CANNOT],
                "different_ratio": round(diff_ratio, 4),
                "concern_ratio": round(concern_ratio, 4),
                "agreement_rate": round(agreement, 4),
                "avg_child_clarity": round(avg_clarity, 4) if avg_clarity is not None else "",
                "prolific_needs_review": needs_review,
                "reason_tags": ",".join(reason_tags),
                "path_prefix": trow.get("path_prefix", path_prefix(item_id)),
                "content_type": trow.get("content_type", "general"),
                "source_en": trow.get("source_en", ""),
                "translation_current": trow.get("translation_target", ""),
                "summary_note": summary_note,
            }
        )

        seed_rows.append(
            {
                "cohort": "positive_needs_review" if needs_review else "control_non_review",
                "item_id": item_id,
                "lang_code": args.target_col,
                "path_prefix": trow.get("path_prefix", path_prefix(item_id)),
                "score_band": "prolific",
                "final_score": "",
                "composite_score": "",
                "ai_score": "",
                "semantic_score": "",
                "lexical_score": "",
                "needs_review_flag": needs_review,
                "reason": ",".join(reason_tags),
                "back_translation": "",
                "notes": summary_note,
                "updated": "",
                "source_en": trow.get("source_en", ""),
                "translation_current": trow.get("translation_target", ""),
                "human_outcome": "needs_review" if needs_review else "acceptable",
                "human_reason_tags": ",".join(reason_tags),
                "human_notes": summary_note,
                "n_votes": len(votes),
                "agreement_rate": round(agreement, 4),
                "avg_child_clarity": round(avg_clarity, 4) if avg_clarity is not None else "",
            }
        )

    aggregated.sort(key=lambda r: (r["prolific_needs_review"] * -1, r["item_id"]))
    seed_rows.sort(key=lambda r: (r["needs_review_flag"] * -1, r["item_id"]))

    aggregated_csv = out_prefix.with_name(out_prefix.name + "-aggregated.csv")
    seed_csv = out_prefix.with_name(out_prefix.name + "-seed.csv")

    def write_csv(path: Path, rows: List[dict]) -> None:
        if not rows:
            return
        with path.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)

    write_csv(aggregated_csv, aggregated)
    write_csv(seed_csv, seed_rows)
    print(f"wrote {aggregated_csv} rows={len(aggregated)}")
    print(f"wrote {seed_csv} rows={len(seed_rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

