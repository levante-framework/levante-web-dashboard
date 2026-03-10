#!/usr/bin/env python3
"""
Pre-calibration report for translation validation without human labels.

Goals:
- summarize score distributions and status bands
- highlight deterministic vs AI disagreements
- produce a prioritized review queue for next week's human review

Input:
- validation JSON export containing `validation_results` (or that map directly)
- optional embedding advisory artifact

Output:
- <prefix>-summary.json
- <prefix>-details.csv
- <prefix>-disagreements.csv
- <prefix>-review-queue.csv
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple


PASS_THRESHOLD = 90.0
REVIEW_THRESHOLD = 80.0


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Pre-calibrate translation validation without human labels.")
    p.add_argument(
        "--validation-json",
        default="",
        help="Path to validation JSON export (expects `validation_results` map). Auto-discovers when omitted.",
    )
    p.add_argument(
        "--embedding-json",
        default="data/validation/embedding-advisory.json",
        help="Optional embedding advisory artifact path.",
    )
    p.add_argument(
        "--output-prefix",
        default="data/validation/precalibration",
        help="Output file prefix.",
    )
    p.add_argument(
        "--disagreement-threshold",
        type=float,
        default=15.0,
        help="Absolute point difference between AI and deterministic score to flag disagreement.",
    )
    return p.parse_args()


def canonical_lang(code: str) -> str:
    c = str(code or "").strip().replace("_", "-").lower()
    aliases = {
        "en": "en",
        "en-us": "en-US",
        "en-gb": "en-GB",
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


def parse_float(value) -> Optional[float]:
    try:
        n = float(value)
        if n != n:
            return None
        return n
    except Exception:
        return None


def to_pct_score(value) -> Optional[float]:
    n = parse_float(value)
    if n is None:
        return None
    if n <= 1.0:
        n = n * 100.0
    return max(0.0, min(100.0, n))


def status_rank(score: Optional[float]) -> str:
    if score is None:
        return ""
    if score >= PASS_THRESHOLD:
        return "pass"
    if score >= REVIEW_THRESHOLD:
        return "review"
    return "fail"


def percentile(values: List[float], pct: float) -> Optional[float]:
    if not values:
        return None
    if pct <= 0:
        return min(values)
    if pct >= 100:
        return max(values)
    vals = sorted(values)
    pos = (len(vals) - 1) * (pct / 100.0)
    lo = int(pos)
    hi = min(lo + 1, len(vals) - 1)
    frac = pos - lo
    return vals[lo] * (1 - frac) + vals[hi] * frac


def extract_item_keys(item_id: str) -> List[str]:
    raw = str(item_id or "").strip()
    if not raw:
        return []
    keys = {raw, raw.lower()}
    if "::" in raw:
        tail = raw.split("::")[-1]
        keys.add(tail)
        keys.add(tail.lower())
    return list(keys)


def load_embedding_index(path: Path) -> Dict[Tuple[str, str], float]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    entries = payload.get("entries", [])
    out: Dict[Tuple[str, str], float] = {}
    for row in entries:
        item_id = str(row.get("itemId", "")).strip()
        lang_code = canonical_lang(row.get("langCode", ""))
        score = to_pct_score(row.get("score"))
        if not item_id or not lang_code or score is None:
            continue
        for k in extract_item_keys(item_id):
            out[(k, lang_code)] = score
    return out


def looks_like_validation_map(payload) -> bool:
    if not isinstance(payload, dict):
        return False
    sample_items = list(payload.items())[:20]
    if not sample_items:
        return False
    for _, lang_map in sample_items:
        if not isinstance(lang_map, dict):
            continue
        for _, result in list(lang_map.items())[:10]:
            if isinstance(result, dict) and (
                "score" in result
                or "compositeScore" in result
                or "aiScore" in result
                or "scoringVersion" in result
            ):
                return True
    return False


def discover_validation_json() -> Tuple[Optional[Path], str]:
    root = Path("data/validation")
    if not root.exists():
        return None, "data/validation not found"
    candidates = sorted(root.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in candidates:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(payload, dict) and "validation_results" in payload and isinstance(payload["validation_results"], dict):
            return path, "found validation_results root"
        if looks_like_validation_map(payload):
            return path, "found direct validation map"
    return None, "no JSON in data/validation matches translation validation export shape"


def load_validation_rows(path: Path, embedding_index: Dict[Tuple[str, str], float]) -> List[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    root = payload.get("validation_results", payload)
    if not isinstance(root, dict):
        return []

    rows: List[dict] = []
    for item_id, lang_map in root.items():
        if not isinstance(lang_map, dict):
            continue
        for lang_code_raw, result in lang_map.items():
            if not isinstance(result, dict):
                continue
            lang_code = canonical_lang(lang_code_raw)
            if not lang_code:
                continue

            final_score = to_pct_score(result.get("score"))
            composite = to_pct_score(result.get("compositeScore"))
            if composite is None:
                composite = to_pct_score(result.get("baselineScore"))
            semantic = to_pct_score(result.get("semanticScore"))
            lexical = to_pct_score(result.get("lexicalScore"))
            ai_score = to_pct_score(result.get("aiScore"))
            if ai_score is None and result.get("aiUsed"):
                ai_score = final_score

            emb_score = None
            for k in extract_item_keys(item_id):
                emb_score = embedding_index.get((k, lang_code))
                if emb_score is not None:
                    break

            diff_ai_calc = None
            if ai_score is not None and composite is not None:
                diff_ai_calc = abs(ai_score - composite)

            rows.append(
                {
                    "item_id": str(item_id),
                    "lang_code": lang_code,
                    "final_score": final_score,
                    "composite_score": composite,
                    "ai_score": ai_score,
                    "semantic_score": semantic,
                    "lexical_score": lexical,
                    "embedding_score": emb_score,
                    "score_source": str(result.get("scoreSource", "") or ""),
                    "scoring_version": str(result.get("scoringVersion", "") or ""),
                    "ai_item_type": str(result.get("aiItemType", "") or ""),
                    "ai_model": str(result.get("aiModel", "") or ""),
                    "semantic_model": str(result.get("semanticModel", "") or ""),
                    "diff_ai_vs_calc": diff_ai_calc,
                    "final_rank": status_rank(final_score),
                    "calc_rank": status_rank(composite),
                    "ai_rank": status_rank(ai_score),
                    "embedding_rank": status_rank(emb_score),
                }
            )
    return rows


def summarize_scores(rows: List[dict], field: str) -> dict:
    vals = [r[field] for r in rows if parse_float(r.get(field)) is not None]
    vals = [float(v) for v in vals]
    if not vals:
        return {"count": 0}
    out = {
        "count": len(vals),
        "mean": sum(vals) / len(vals),
        "min": min(vals),
        "p05": percentile(vals, 5),
        "p25": percentile(vals, 25),
        "p50": percentile(vals, 50),
        "p75": percentile(vals, 75),
        "p95": percentile(vals, 95),
        "max": max(vals),
    }
    out["bands"] = {
        "pass": sum(1 for v in vals if v >= PASS_THRESHOLD),
        "review": sum(1 for v in vals if REVIEW_THRESHOLD <= v < PASS_THRESHOLD),
        "fail": sum(1 for v in vals if v < REVIEW_THRESHOLD),
    }
    return out


def build_review_queue(rows: List[dict], disagreement_threshold: float, limit: int = 1000) -> List[dict]:
    queue = []
    for r in rows:
        risk = 0
        reasons = []

        d = parse_float(r.get("diff_ai_vs_calc"))
        if d is not None and d >= disagreement_threshold:
            risk += 4 if d >= 25 else 3
            reasons.append(f"ai_calc_disagreement={d:.1f}")

        f = parse_float(r.get("final_score"))
        if f is not None and REVIEW_THRESHOLD <= f < PASS_THRESHOLD:
            risk += 2
            reasons.append("borderline_final_score")

        c = parse_float(r.get("composite_score"))
        if c is not None and REVIEW_THRESHOLD <= c < PASS_THRESHOLD:
            risk += 1
            reasons.append("borderline_composite_score")

        sem_model = str(r.get("semantic_model", "") or "").lower()
        if "fallback" in sem_model:
            risk += 1
            reasons.append("semantic_fallback_used")

        if not r.get("ai_item_type"):
            risk += 1
            reasons.append("missing_ai_item_type")

        if risk <= 0:
            continue

        queue.append(
            {
                **r,
                "risk_score": risk,
                "risk_reasons": ";".join(reasons),
            }
        )

    queue.sort(
        key=lambda x: (
            -int(x.get("risk_score", 0)),
            -float(parse_float(x.get("diff_ai_vs_calc")) or 0),
            float(parse_float(x.get("final_score")) or 100),
        )
    )
    return queue[:limit]


def by_language(rows: List[dict]) -> dict:
    langs = sorted({r["lang_code"] for r in rows if r.get("lang_code")})
    out = {}
    for lang in langs:
        lr = [r for r in rows if r["lang_code"] == lang]
        out[lang] = {
            "rows": len(lr),
            "final": summarize_scores(lr, "final_score"),
            "composite": summarize_scores(lr, "composite_score"),
            "ai": summarize_scores(lr, "ai_score"),
            "embedding": summarize_scores(lr, "embedding_score"),
            "high_disagreement_count": sum(
                1 for r in lr if parse_float(r.get("diff_ai_vs_calc")) is not None and float(r["diff_ai_vs_calc"]) >= 15.0
            ),
        }
    return out


def write_csv(path: Path, rows: List[dict], headers: List[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for r in rows:
            writer.writerow({k: r.get(k, "") for k in headers})


def main() -> int:
    args = parse_args()
    out_prefix = Path(args.output_prefix)
    out_prefix.parent.mkdir(parents=True, exist_ok=True)

    validation_path = Path(args.validation_json) if args.validation_json else None
    discovery_note = ""
    if validation_path is None:
        validation_path, discovery_note = discover_validation_json()
    if validation_path is not None and not validation_path.exists():
        validation_path = None
        discovery_note = "provided validation path does not exist"

    embedding_path = Path(args.embedding_json) if args.embedding_json else None
    embedding_index = load_embedding_index(embedding_path) if embedding_path and embedding_path.exists() else {}

    rows: List[dict] = []
    if validation_path is not None:
        try:
            rows = load_validation_rows(validation_path, embedding_index)
        except Exception as exc:
            discovery_note = f"failed to parse validation export: {exc}"
            rows = []

    details_csv = out_prefix.with_name(out_prefix.name + "-details.csv")
    disagreements_csv = out_prefix.with_name(out_prefix.name + "-disagreements.csv")
    queue_csv = out_prefix.with_name(out_prefix.name + "-review-queue.csv")
    summary_json = out_prefix.with_name(out_prefix.name + "-summary.json")

    detail_headers = [
        "item_id",
        "lang_code",
        "final_score",
        "composite_score",
        "ai_score",
        "semantic_score",
        "lexical_score",
        "embedding_score",
        "diff_ai_vs_calc",
        "final_rank",
        "calc_rank",
        "ai_rank",
        "embedding_rank",
        "score_source",
        "scoring_version",
        "ai_item_type",
        "ai_model",
        "semantic_model",
    ]
    write_csv(details_csv, rows, detail_headers)

    disagreements = [
        r
        for r in rows
        if parse_float(r.get("diff_ai_vs_calc")) is not None
        and float(r["diff_ai_vs_calc"]) >= args.disagreement_threshold
    ]
    disagreements.sort(key=lambda r: -float(r["diff_ai_vs_calc"]))
    write_csv(disagreements_csv, disagreements, detail_headers)

    queue_rows = build_review_queue(rows, args.disagreement_threshold)
    queue_headers = ["risk_score", "risk_reasons"] + detail_headers
    write_csv(queue_csv, queue_rows, queue_headers)

    summary = {
        "status": "ok" if rows else "needs_validation_export",
        "note": discovery_note,
        "inputs": {
            "validation_json": str(validation_path) if validation_path else "",
            "embedding_json": str(embedding_path) if embedding_path else "",
        },
        "thresholds": {
            "pass": PASS_THRESHOLD,
            "review": REVIEW_THRESHOLD,
            "disagreement": args.disagreement_threshold,
        },
        "rows": len(rows),
        "coverage": {
            "composite": sum(1 for r in rows if r.get("composite_score") is not None),
            "ai": sum(1 for r in rows if r.get("ai_score") is not None),
            "embedding": sum(1 for r in rows if r.get("embedding_score") is not None),
        },
        "overall": {
            "final": summarize_scores(rows, "final_score"),
            "composite": summarize_scores(rows, "composite_score"),
            "ai": summarize_scores(rows, "ai_score"),
            "embedding": summarize_scores(rows, "embedding_score"),
        },
        "languageBreakdown": by_language(rows),
        "disagreements": {
            "count": len(disagreements),
            "top5": disagreements[:5],
        },
        "reviewQueue": {
            "count": len(queue_rows),
            "top20": queue_rows[:20],
        },
        "outputs": {
            "details_csv": str(details_csv),
            "disagreements_csv": str(disagreements_csv),
            "review_queue_csv": str(queue_csv),
            "summary_json": str(summary_json),
        },
        "nextSteps": [
            "Share review-queue CSV with reviewers first; start with highest risk_score rows.",
            "Collect human labels for at least 200-500 rows across languages and item types.",
            "Then run scripts/compare_validation_signals.py for threshold calibration against human labels.",
        ],
    }
    summary_json.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"wrote {details_csv}")
    print(f"wrote {disagreements_csv}")
    print(f"wrote {queue_csv}")
    print(f"wrote {summary_json}")
    if not rows:
        print("note: no translation validation rows found; provide/export validation_results JSON to get full analysis.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

