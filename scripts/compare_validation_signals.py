#!/usr/bin/env python3
"""
Compare human labels against calculated/AI/embedding validation signals.

Inputs:
- human CSV with at least: item_id, lang_code, and one of:
  - human_score (0-100), or
  - human_label (pass/review/fail)
- dashboard validation JSON (expects `validation_results` map)
- embedding advisory JSON (optional; expects `entries` array with itemId/langCode/score)

Outputs:
- detailed CSV (per-row joined view)
- summary JSON (coverage, kendall tau, threshold suggestions)
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Compare validation signals against human labels.")
    p.add_argument("--human-csv", required=True, help="CSV with human labels/scores.")
    p.add_argument("--validation-json", required=True, help="Dashboard validation JSON export.")
    p.add_argument("--embedding-json", default="", help="Optional embedding advisory artifact JSON.")
    p.add_argument("--output-prefix", default="data/validation/validation-signals-compare", help="Output file prefix.")
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


def normalize_label(raw: str) -> str:
    v = str(raw or "").strip().lower()
    if not v:
        return ""
    if v in {"pass", "good", "excellent", "ok", "accept"}:
        return "pass"
    if v in {"review", "warning", "warn", "needs_review", "needs-review"}:
        return "review"
    if v in {"fail", "poor", "reject", "bad"}:
        return "fail"
    return v


def label_to_score(label: str) -> Optional[float]:
    mapping = {
        "pass": 95.0,
        "review": 80.0,
        "fail": 60.0,
    }
    return mapping.get(normalize_label(label))


def parse_float(value) -> Optional[float]:
    try:
        n = float(value)
        if n != n:
            return None
        return n
    except Exception:
        return None


def rank_signal(score: Optional[float], pass_threshold: float = 90.0, review_threshold: float = 80.0) -> str:
    if score is None:
        return ""
    if score >= pass_threshold:
        return "pass"
    if score >= review_threshold:
        return "review"
    return "fail"


def kendall_tau(xs: List[float], ys: List[float]) -> Optional[float]:
    n = min(len(xs), len(ys))
    if n < 2:
        return None
    conc = 0
    disc = 0
    ties_x = 0
    ties_y = 0
    for i in range(n):
        for j in range(i + 1, n):
            dx = xs[i] - xs[j]
            dy = ys[i] - ys[j]
            if dx == 0 and dy == 0:
                continue
            if dx == 0:
                ties_x += 1
                continue
            if dy == 0:
                ties_y += 1
                continue
            if dx * dy > 0:
                conc += 1
            else:
                disc += 1
    denom = ((conc + disc + ties_x) * (conc + disc + ties_y)) ** 0.5
    if denom == 0:
        return None
    return (conc - disc) / denom


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


def load_validation_index(path: Path) -> Dict[Tuple[str, str], dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    root = payload.get("validation_results", payload)
    out: Dict[Tuple[str, str], dict] = {}
    if not isinstance(root, dict):
        return out
    for item_id, lang_map in root.items():
        if not isinstance(lang_map, dict):
            continue
        for lang_code, result in lang_map.items():
            if not isinstance(result, dict):
                continue
            key = (str(item_id), canonical_lang(lang_code))
            out[key] = result
            out[(str(item_id), str(lang_code))] = result
    return out


def load_embedding_index(path: Path) -> Dict[Tuple[str, str], float]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    entries = payload.get("entries", [])
    out: Dict[Tuple[str, str], float] = {}
    for row in entries:
        item_id = str(row.get("itemId", "")).strip()
        lang_code = canonical_lang(row.get("langCode", ""))
        score = parse_float(row.get("score"))
        if not item_id or not lang_code or score is None:
            continue
        score_pct = max(0.0, min(100.0, score * 100 if score <= 1.0 else score))
        for k in extract_item_keys(item_id):
            out[(k, lang_code)] = score_pct
    return out


def best_threshold_for_pass(signal_scores: List[float], human_scores: List[float]) -> Optional[int]:
    if len(signal_scores) < 10 or len(signal_scores) != len(human_scores):
        return None
    best_t = None
    best_acc = -1.0
    for t in range(60, 99):
        correct = 0
        for s, h in zip(signal_scores, human_scores):
            pred = s >= t
            truth = h >= 90
            if pred == truth:
                correct += 1
        acc = correct / len(signal_scores)
        if acc > best_acc:
            best_acc = acc
            best_t = t
    return best_t


def main() -> int:
    args = parse_args()
    human_path = Path(args.human_csv)
    validation_path = Path(args.validation_json)
    embedding_path = Path(args.embedding_json) if args.embedding_json else Path("")
    output_prefix = Path(args.output_prefix)
    output_prefix.parent.mkdir(parents=True, exist_ok=True)

    validation_index = load_validation_index(validation_path)
    embedding_index = load_embedding_index(embedding_path) if args.embedding_json else {}

    detailed_rows = []
    with human_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            item_id = str(row.get("item_id", row.get("itemId", ""))).strip()
            lang_code_raw = str(row.get("lang_code", row.get("langCode", ""))).strip()
            lang_code = canonical_lang(lang_code_raw)
            if not item_id or not lang_code:
                continue

            human_score = parse_float(row.get("human_score"))
            if human_score is None:
                human_score = label_to_score(row.get("human_label", ""))
            human_label = normalize_label(row.get("human_label", "")) or rank_signal(human_score)

            result = None
            for key_item in extract_item_keys(item_id):
                result = validation_index.get((key_item, lang_code)) or validation_index.get((key_item, lang_code_raw))
                if result:
                    break
            calc_score = parse_float(result.get("compositeScore")) if result else None
            if calc_score is None and result:
                calc_score = parse_float(result.get("baselineScore"))
            if calc_score is None and result:
                raw_score = parse_float(result.get("score"))
                if raw_score is not None:
                    calc_score = raw_score * 100 if raw_score <= 1 else raw_score

            ai_score = parse_float(result.get("aiScore")) if result else None
            if ai_score is None and result and result.get("aiUsed"):
                merged = parse_float(result.get("score"))
                if merged is not None:
                    ai_score = merged * 100 if merged <= 1 else merged

            emb_score = None
            for key_item in extract_item_keys(item_id):
                emb_score = embedding_index.get((key_item, lang_code))
                if emb_score is not None:
                    break

            detailed_rows.append({
                "item_id": item_id,
                "lang_code": lang_code,
                "human_label": human_label,
                "human_score": human_score,
                "calculated_score": calc_score,
                "ai_score": ai_score,
                "embedding_score": emb_score,
                "calculated_rank": rank_signal(calc_score),
                "ai_rank": rank_signal(ai_score),
                "embedding_rank": rank_signal(emb_score),
                "score_source": result.get("scoreSource", "") if result else "",
                "scoring_version": result.get("scoringVersion", "") if result else "",
            })

    detail_csv = output_prefix.with_name(output_prefix.name + "-details.csv")
    headers = [
        "item_id", "lang_code",
        "human_label", "human_score",
        "calculated_score", "ai_score", "embedding_score",
        "calculated_rank", "ai_rank", "embedding_rank",
        "score_source", "scoring_version",
    ]
    with detail_csv.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        writer.writerows(detailed_rows)

    summary = {
        "rows": len(detailed_rows),
        "coverage": {
            "calculated": sum(1 for r in detailed_rows if r["calculated_score"] is not None),
            "ai": sum(1 for r in detailed_rows if r["ai_score"] is not None),
            "embedding": sum(1 for r in detailed_rows if r["embedding_score"] is not None),
        },
        "kendallTau": {},
        "recommendedThresholdsByLanguage": {},
    }

    for signal in ("calculated_score", "ai_score", "embedding_score"):
        pairs = [(r["human_score"], r[signal]) for r in detailed_rows if r["human_score"] is not None and r[signal] is not None]
        if len(pairs) >= 2:
            xs = [p[0] for p in pairs]
            ys = [p[1] for p in pairs]
            summary["kendallTau"][signal] = kendall_tau(xs, ys)
        else:
            summary["kendallTau"][signal] = None

    langs = sorted({r["lang_code"] for r in detailed_rows if r.get("lang_code")})
    for lang in langs:
        rows = [r for r in detailed_rows if r["lang_code"] == lang and r["human_score"] is not None]
        out = {}
        for signal in ("calculated_score", "ai_score", "embedding_score"):
            pairs = [(r[signal], r["human_score"]) for r in rows if r[signal] is not None]
            if len(pairs) < 10:
                continue
            sig = [p[0] for p in pairs]
            human = [p[1] for p in pairs]
            pass_t = best_threshold_for_pass(sig, human)
            if pass_t is None:
                continue
            review_t = max(50, pass_t - 10)
            out[signal] = {
                "passThreshold": pass_t,
                "reviewThreshold": review_t,
                "samples": len(pairs),
            }
        if out:
            summary["recommendedThresholdsByLanguage"][lang] = out

    summary_json = output_prefix.with_name(output_prefix.name + "-summary.json")
    summary_json.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"wrote {detail_csv}")
    print(f"wrote {summary_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

