#!/usr/bin/env python3
"""
Build a starter human-label dataset for calibration from shared validation results.

Default behavior:
- positives: all rows where needsReview=true for selected language
- controls: matched rows where needsReview!=true (same language), sampled by score band and path prefix

Outputs:
- CSV with fields ready for human outcome/tag labeling
"""

from __future__ import annotations

import argparse
import csv
import json
import random
from pathlib import Path
from typing import Dict, List, Optional, Tuple


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build human review seed CSV for calibration.")
    p.add_argument(
        "--validation-json",
        default="data/validation/validation_results.shared.json",
        help="Validation JSON (root object or {validation_results:{...}}).",
    )
    p.add_argument(
        "--translations-csv",
        default="data/validation/crowdin-xliff-merged.csv",
        help="Merged translation CSV used to enrich rows with source/target text.",
    )
    p.add_argument("--lang-code", default="es-AR", help="Target language code.")
    p.add_argument(
        "--controls-per-positive",
        type=int,
        default=1,
        help="How many non-needsReview controls to include per positive.",
    )
    p.add_argument("--seed", type=int, default=42, help="Random seed for reproducible sampling.")
    p.add_argument(
        "--output-csv",
        default="data/validation/human-review-seed-es-AR.csv",
        help="Output CSV path.",
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


def to_pct(value) -> Optional[float]:
    try:
        n = float(value)
    except Exception:
        return None
    if n != n:
        return None
    if n <= 1.0:
        n *= 100.0
    return max(0.0, min(100.0, n))


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


def path_prefix(item_id: str) -> str:
    raw = str(item_id or "")
    if "::" in raw:
        raw = raw.split("::", 1)[0]
    parts = [p for p in raw.split("/") if p]
    if len(parts) >= 3:
        return "/".join(parts[:3])
    if parts:
        return "/".join(parts)
    return "unknown"


def load_validation_rows(validation_path: Path, lang_code: str) -> List[dict]:
    payload = json.loads(validation_path.read_text(encoding="utf-8"))
    root = payload.get("validation_results", payload)
    out: List[dict] = []
    target = canonical_lang(lang_code)

    for item_id, by_lang in (root or {}).items():
        if not isinstance(by_lang, dict):
            continue
        result = None
        # Try exact lang first, then canonical/aliases
        for lc, r in by_lang.items():
            if canonical_lang(lc) == target:
                result = r
                break
        if not isinstance(result, dict):
            continue

        final_score = to_pct(result.get("score"))
        composite = to_pct(result.get("compositeScore"))
        if composite is None:
            composite = to_pct(result.get("baselineScore"))
        ai_score = to_pct(result.get("aiScore"))
        semantic = to_pct(result.get("semanticScore"))
        lexical = to_pct(result.get("lexicalScore"))

        out.append(
            {
                "item_id": str(item_id),
                "lang_code": target,
                "needs_review": bool(result.get("needsReview") is True),
                "reason": str(result.get("reason", "") or ""),
                "back_translation": str(result.get("backTranslation", "") or ""),
                "notes": str(result.get("notes", "") or ""),
                "updated": str(result.get("updated", result.get("timestamp", "")) or ""),
                "final_score": final_score,
                "composite_score": composite,
                "ai_score": ai_score,
                "semantic_score": semantic,
                "lexical_score": lexical,
                "score_source": str(result.get("scoreSource", "") or ""),
                "scoring_version": str(result.get("scoringVersion", "") or ""),
                "path_prefix": path_prefix(item_id),
                "score_band": score_band(final_score),
            }
        )
    return out


def load_translations(path: Path) -> Dict[str, dict]:
    if not path.exists():
        return {}
    out: Dict[str, dict] = {}
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            key = str(row.get("identifier") or row.get("item_id") or "").strip()
            if key:
                out[key] = row
    return out


def pick_matched_controls(positives: List[dict], controls: List[dict], controls_per_positive: int, seed: int) -> List[dict]:
    random.seed(seed)
    pool_by_bucket: Dict[Tuple[str, str], List[dict]] = {}
    for c in controls:
        k = (c["score_band"], c["path_prefix"])
        pool_by_bucket.setdefault(k, []).append(c)

    # Shuffle each bucket for deterministic but unbiased pops.
    for rows in pool_by_bucket.values():
        random.shuffle(rows)

    selected: List[dict] = []
    used_ids = set()

    def take_from_bucket(bucket_key) -> Optional[dict]:
        rows = pool_by_bucket.get(bucket_key, [])
        while rows:
            r = rows.pop()
            if r["item_id"] in used_ids:
                continue
            used_ids.add(r["item_id"])
            return r
        return None

    control_fallback = controls[:]
    random.shuffle(control_fallback)

    for p in positives:
        needed = max(0, controls_per_positive)
        for _ in range(needed):
            candidate = (
                take_from_bucket((p["score_band"], p["path_prefix"]))
                or take_from_bucket((p["score_band"], "unknown"))
            )
            if candidate is None:
                # fallback: same score band, any path
                for k in list(pool_by_bucket.keys()):
                    if k[0] != p["score_band"]:
                        continue
                    candidate = take_from_bucket(k)
                    if candidate is not None:
                        break
            if candidate is None:
                # final fallback: any remaining control
                while control_fallback:
                    r = control_fallback.pop()
                    if r["item_id"] in used_ids:
                        continue
                    used_ids.add(r["item_id"])
                    candidate = r
                    break
            if candidate is None:
                break
            selected.append(candidate)
    return selected


def enrich_row(base: dict, translations: Dict[str, dict], lang_code: str, cohort: str) -> dict:
    t = translations.get(base["item_id"], {})
    return {
        "cohort": cohort,  # positive_needs_review | matched_control
        "item_id": base["item_id"],
        "lang_code": lang_code,
        "path_prefix": base["path_prefix"],
        "score_band": base["score_band"],
        "final_score": "" if base["final_score"] is None else round(base["final_score"], 2),
        "composite_score": "" if base["composite_score"] is None else round(base["composite_score"], 2),
        "ai_score": "" if base["ai_score"] is None else round(base["ai_score"], 2),
        "semantic_score": "" if base["semantic_score"] is None else round(base["semantic_score"], 4),
        "lexical_score": "" if base["lexical_score"] is None else round(base["lexical_score"], 4),
        "needs_review_flag": "1" if base["needs_review"] else "0",
        "reason": base["reason"],
        "back_translation": base["back_translation"],
        "notes": base["notes"],
        "updated": base["updated"],
        "source_en": str(t.get("en", "") or ""),
        "translation_current": str(t.get(lang_code, "") or ""),
        # Human-label fields (to fill)
        "human_outcome": "",  # pass | review | fail
        "human_reason_tags": "",  # pipe-separated tags from taxonomy
        "human_notes": "",
    }


def main() -> int:
    args = parse_args()
    lang_code = canonical_lang(args.lang_code)
    validation_path = Path(args.validation_json)
    translations_path = Path(args.translations_csv)
    output_path = Path(args.output_csv)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    rows = load_validation_rows(validation_path, lang_code)
    positives = [r for r in rows if r["needs_review"]]
    controls = [r for r in rows if not r["needs_review"]]
    matched = pick_matched_controls(positives, controls, args.controls_per_positive, args.seed)
    translations = load_translations(translations_path)

    out_rows = []
    for r in positives:
        out_rows.append(enrich_row(r, translations, lang_code, "positive_needs_review"))
    for r in matched:
        out_rows.append(enrich_row(r, translations, lang_code, "matched_control"))

    # Keep positives first, then controls sorted by item id for readability.
    out_rows.sort(key=lambda r: (0 if r["cohort"] == "positive_needs_review" else 1, r["item_id"]))

    headers = [
        "cohort",
        "item_id",
        "lang_code",
        "path_prefix",
        "score_band",
        "final_score",
        "composite_score",
        "ai_score",
        "semantic_score",
        "lexical_score",
        "needs_review_flag",
        "reason",
        "back_translation",
        "notes",
        "updated",
        "source_en",
        "translation_current",
        "human_outcome",
        "human_reason_tags",
        "human_notes",
    ]
    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        writer.writerows(out_rows)

    print(f"wrote {output_path}")
    print(f"language={lang_code}")
    print(f"positives={len(positives)} controls_selected={len(matched)} total_rows={len(out_rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

