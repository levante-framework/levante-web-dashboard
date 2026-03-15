#!/usr/bin/env python3
"""
Build rule-augmented review candidates from shared validation + weak policy.

Purpose:
- Keep all current human-selected needsReview items (never miss known work)
- Add extra candidates using lightweight rules that work with limited data
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Set, Tuple

EXCLUDED_VALIDATION_PREFIXES = ["main/Z_LEGACY_DO_NOT_TRANSLATE/"]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build rule-augmented review candidate list.")
    p.add_argument("--validation-json", default="data/validation/validation_results.shared.json")
    p.add_argument("--policy-csv", default="data/validation/weak-needs-review-es-AR-policy-decisions.csv")
    p.add_argument(
        "--margin-csv",
        default="data/validation/embedding-hard-negative-margin-es-AR-details.csv",
        help="Optional margin details CSV from embedding_hard_negative_margin.py",
    )
    p.add_argument("--lang-code", default="es-AR")
    p.add_argument("--output-prefix", default="data/validation/review-augmented-es-AR")
    p.add_argument("--max-siblings-per-anchor", type=int, default=6)
    p.add_argument(
        "--recent-days",
        type=int,
        default=7,
        help="Recent window for file-level propagation (based on human-flag updated timestamp).",
    )
    p.add_argument(
        "--max-file-propagation-per-file",
        type=int,
        default=4,
        help="Cap extra propagated candidates per anchored file.",
    )
    p.add_argument(
        "--margin-top-frac",
        type=float,
        default=0.0,
        help="Fraction of lowest-margin items to add as margin_low rule (0 disables).",
    )
    p.add_argument(
        "--sweep",
        action="store_true",
        help="Run parameter sweep and output comparison table instead of a single candidate file.",
    )
    p.add_argument(
        "--sweep-recent-days",
        default="7,14,30",
        help="Comma-separated recent-days values for sweep mode.",
    )
    p.add_argument(
        "--sweep-max-file-propagation",
        default="4,8,12,20",
        help="Comma-separated max-file-propagation-per-file values for sweep mode.",
    )
    return p.parse_args()


def is_excluded_item_id(item_id: str) -> bool:
    normalized = str(item_id or "").strip().lower()
    if not normalized:
        return False
    return any(normalized.startswith(p.lower()) for p in EXCLUDED_VALIDATION_PREFIXES)


def canonical_lang(code: str) -> str:
    c = str(code or "").strip().replace("_", "-").lower()
    aliases = {"es-ar": "es-AR", "es-co": "es-CO", "es": "es", "en-us": "en-US", "en": "en"}
    return aliases.get(c, code or "")


def to_pct(v):
    try:
        n = float(v)
    except Exception:
        return None
    if n <= 1.0:
        n *= 100.0
    return max(0.0, min(100.0, n))


def path_prefix(item_id: str) -> str:
    raw = str(item_id or "")
    if "::" in raw:
        raw = raw.split("::", 1)[0]
    return raw


def reason_has_consistency_signal(reason: str) -> bool:
    r = str(reason or "").lower()
    keywords = [
        "confirm",
        "consisten",
        "vs.",
        " vs ",
        "clarify",
        "discuss",
        "should this",
        "same word",
    ]
    return any(k in r for k in keywords)


def parse_iso_utc(ts: str):
    raw = str(ts or "").strip()
    if not raw:
        return None
    try:
        # Handle "Z" suffix explicitly.
        if raw.endswith("Z"):
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
        d = datetime.fromisoformat(raw)
        if d.tzinfo is None:
            return d.replace(tzinfo=timezone.utc)
        return d.astimezone(timezone.utc)
    except Exception:
        return None


def load_shared_rows(validation_json: Path, lang_code: str) -> Tuple[List[dict], Set[str]]:
    payload = json.loads(validation_json.read_text(encoding="utf-8"))
    root = payload.get("validation_results", payload)
    target = canonical_lang(lang_code)
    rows: List[dict] = []
    human: Set[str] = set()
    for item_id, by_lang in (root or {}).items():
        if is_excluded_item_id(item_id):
            continue
        if not isinstance(by_lang, dict):
            continue
        result = None
        for lc, rv in by_lang.items():
            if canonical_lang(lc) == target:
                result = rv
                break
        if not isinstance(result, dict):
            continue
        needs = result.get("needsReview") is True
        if needs:
            human.add(str(item_id))
        rows.append(
            {
                "item_id": str(item_id),
                "path_prefix": path_prefix(item_id),
                "needs_review": needs,
                "reason": str(result.get("reason", "") or ""),
                "updated": str(result.get("updated", result.get("timestamp", "")) or ""),
                "final_score": to_pct(result.get("score")),
                "composite_score": to_pct(result.get("compositeScore", result.get("baselineScore"))),
                "ai_score": to_pct(result.get("aiScore")),
                "manual_approved": bool(result.get("manualApproved") is True),
            }
        )
    return rows, human


def load_policy(policy_csv: Path) -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    with policy_csv.open("r", encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            item = str(r.get("item_id", "")).strip()
            if not item or is_excluded_item_id(item):
                continue
            out[item] = {
                "policy_tier": str(r.get("policy_tier", "") or ""),
                "p_review": float(r.get("p_review", 0) or 0),
            }
    return out


def load_margin_low_ids(margin_csv: Path, top_frac: float) -> Set[str]:
    if top_frac <= 0:
        return set()
    if not margin_csv.exists():
        return set()
    rows = []
    with margin_csv.open("r", encoding="utf-8", newline="") as f:
        rd = csv.DictReader(f)
        for r in rd:
            item = str(r.get("item_id", "")).strip()
            if not item or is_excluded_item_id(item):
                continue
            try:
                margin = float(r.get("margin"))
            except Exception:
                continue
            rows.append((margin, item))
    if not rows:
        return set()
    rows.sort(key=lambda x: x[0])  # lowest margin first
    k = max(1, int(round(len(rows) * max(0.0, min(1.0, top_frac)))))
    return {item for _, item in rows[:k]}


def overlap_stats(cands: Set[str], truth: Set[str]) -> dict:
    inter = cands & truth
    return {
        "candidate_count": len(cands),
        "overlap_count": len(inter),
        "precision_vs_human": (len(inter) / len(cands)) if cands else 0.0,
        "recall_vs_human": (len(inter) / len(truth)) if truth else 0.0,
    }


def build_augmented(
    rows: List[dict],
    human: Set[str],
    policy: Dict[str, dict],
    margin_low_ids: Set[str],
    max_siblings_per_anchor: int,
    recent_days: int,
    max_file_propagation_per_file: int,
) -> Tuple[Dict[str, dict], dict]:
    by_item = {r["item_id"]: r for r in rows}
    by_path = defaultdict(list)
    for r in rows:
        by_path[r["path_prefix"]].append(r)

    # 1) Keep all human flags
    augmented: Dict[str, dict] = {}
    for item in human:
        p = policy.get(item, {})
        augmented[item] = {
            "item_id": item,
            "source_rule": "human_flag",
            "policy_tier": p.get("policy_tier", ""),
            "p_review": p.get("p_review", 0.0),
        }

    # 2) Add weak model auto tier candidates
    for item, p in policy.items():
        if p.get("policy_tier") != "auto_review":
            continue
        if item in augmented:
            continue
        augmented[item] = {
            "item_id": item,
            "source_rule": "weak_auto_review",
            "policy_tier": p.get("policy_tier", ""),
            "p_review": p.get("p_review", 0.0),
        }

    # 2b) Add lowest-margin embedding confusion candidates
    for item in sorted(margin_low_ids):
        if item in augmented:
            continue
        p = policy.get(item, {})
        augmented[item] = {
            "item_id": item,
            "source_rule": "margin_low",
            "policy_tier": p.get("policy_tier", ""),
            "p_review": p.get("p_review", 0.0),
        }

    # 3) Consistency sibling propagation:
    # If a human-flagged item has consistency-style reason, include a handful
    # of high-score siblings in same file/path for human review.
    for item in sorted(human):
        anchor = by_item.get(item)
        if not anchor:
            continue
        if not reason_has_consistency_signal(anchor.get("reason", "")):
            continue
        siblings = [r for r in by_path.get(anchor["path_prefix"], []) if r["item_id"] != item]
        siblings.sort(
            key=lambda r: (
                -float(r["composite_score"] if r["composite_score"] is not None else 0.0),
                r["item_id"],
            )
        )
        taken = 0
        for s in siblings:
            sid = s["item_id"]
            if sid in augmented:
                continue
            # prioritize likely "looks good but maybe inconsistent" siblings
            cs = s["composite_score"] if s["composite_score"] is not None else 0.0
            if cs < 85:
                continue
            p = policy.get(sid, {})
            augmented[sid] = {
                "item_id": sid,
                "source_rule": "consistency_sibling",
                "policy_tier": p.get("policy_tier", ""),
                "p_review": p.get("p_review", 0.0),
                "anchor_item_id": item,
            }
            taken += 1
            if taken >= max(0, max_siblings_per_anchor):
                break

    # 4) File-level propagation:
    # If a file had recent human-flagged reviews, include additional risky siblings from that file.
    # This improves recall for clustered translation issues.
    if recent_days > 0 and max_file_propagation_per_file > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(days=int(recent_days))
        anchored_files = set()
        for item in human:
            r = by_item.get(item)
            if not r:
                continue
            ts = parse_iso_utc(r.get("updated", ""))
            if ts is None or ts < cutoff:
                continue
            anchored_files.add(r["path_prefix"])

        for pref in sorted(anchored_files):
            siblings = [r for r in by_path.get(pref, []) if r["item_id"] not in augmented]
            # Risk sort:
            # - policy score first (if available)
            # - disagreement signal
            # - lower final score
            scored = []
            for s in siblings:
                sid = s["item_id"]
                p = float(policy.get(sid, {}).get("p_review", 0.0))
                cs = s["composite_score"] if s["composite_score"] is not None else 0.0
                ai = s["ai_score"] if s["ai_score"] is not None else cs
                final = s["final_score"] if s["final_score"] is not None else cs
                disagree = abs(float(ai) - float(cs))
                # Gate to reasonably risky siblings.
                risky = (p >= 0.075) or (final < 85) or (disagree >= 15)
                if not risky:
                    continue
                scored.append((p, disagree, -float(final), sid))
            scored.sort(reverse=True)
            added = 0
            for _, _, _, sid in scored:
                if sid in augmented:
                    continue
                p = policy.get(sid, {})
                augmented[sid] = {
                    "item_id": sid,
                    "source_rule": "file_propagation_recent",
                    "policy_tier": p.get("policy_tier", ""),
                    "p_review": p.get("p_review", 0.0),
                    "anchor_item_id": pref,
                }
                added += 1
                if added >= int(max_file_propagation_per_file):
                    break

    augmented_ids = set(augmented.keys())
    auto_ids = {i for i, p in policy.items() if p.get("policy_tier") == "auto_review"}
    reviewed_ids = {i for i, p in policy.items() if p.get("policy_tier") in ("auto_review", "queue_review")}

    summary = {
        "lang_code": "",
        "counts": {
            "human_needs_review": len(human),
            "policy_auto_review": len(auto_ids),
            "policy_auto_plus_queue": len(reviewed_ids),
            "augmented_candidates": len(augmented_ids),
        },
        "baseline_overlap_auto": overlap_stats(auto_ids, human),
        "baseline_overlap_auto_plus_queue": overlap_stats(reviewed_ids, human),
        "augmented_overlap": overlap_stats(augmented_ids, human),
        "rule_breakdown": {
            "human_flag": sum(1 for v in augmented.values() if v.get("source_rule") == "human_flag"),
            "weak_auto_review": sum(1 for v in augmented.values() if v.get("source_rule") == "weak_auto_review"),
            "margin_low": sum(1 for v in augmented.values() if v.get("source_rule") == "margin_low"),
            "consistency_sibling": sum(1 for v in augmented.values() if v.get("source_rule") == "consistency_sibling"),
            "file_propagation_recent": sum(1 for v in augmented.values() if v.get("source_rule") == "file_propagation_recent"),
        },
        "file_propagation_config": {
            "recent_days": int(recent_days),
            "max_file_propagation_per_file": int(max_file_propagation_per_file),
        },
    }
    return augmented, summary


def parse_int_list(raw: str) -> List[int]:
    out = []
    for tok in str(raw or "").split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            out.append(int(tok))
        except Exception:
            continue
    return out


def main() -> int:
    args = parse_args()
    out_prefix = Path(args.output_prefix)
    out_prefix.parent.mkdir(parents=True, exist_ok=True)
    rows, human = load_shared_rows(Path(args.validation_json), args.lang_code)
    policy = load_policy(Path(args.policy_csv))
    margin_low_ids = load_margin_low_ids(Path(args.margin_csv), float(args.margin_top_frac))

    if args.sweep:
        days_values = parse_int_list(args.sweep_recent_days)
        max_values = parse_int_list(args.sweep_max_file_propagation)
        if not days_values or not max_values:
            raise SystemExit("Sweep requires at least one value for --sweep-recent-days and --sweep-max-file-propagation")
        table = []
        for d in days_values:
            for m in max_values:
                _, s = build_augmented(
                    rows=rows,
                    human=human,
                    policy=policy,
                    margin_low_ids=margin_low_ids,
                    max_siblings_per_anchor=args.max_siblings_per_anchor,
                    recent_days=d,
                    max_file_propagation_per_file=m,
                )
                table.append(
                    {
                        "recent_days": d,
                        "max_file_propagation_per_file": m,
                        "augmented_candidates": s["counts"]["augmented_candidates"],
                        "overlap_count": s["augmented_overlap"]["overlap_count"],
                        "precision_vs_human": s["augmented_overlap"]["precision_vs_human"],
                        "recall_vs_human": s["augmented_overlap"]["recall_vs_human"],
                        "rule_human_flag": s["rule_breakdown"]["human_flag"],
                        "rule_weak_auto_review": s["rule_breakdown"]["weak_auto_review"],
                        "rule_margin_low": s["rule_breakdown"]["margin_low"],
                        "rule_consistency_sibling": s["rule_breakdown"]["consistency_sibling"],
                        "rule_file_propagation_recent": s["rule_breakdown"]["file_propagation_recent"],
                    }
                )
        table.sort(key=lambda r: (-r["recall_vs_human"], -r["precision_vs_human"], r["augmented_candidates"]))
        out_csv = out_prefix.with_name(out_prefix.name + "-sweep.csv")
        out_json = out_prefix.with_name(out_prefix.name + "-sweep.json")
        headers = list(table[0].keys()) if table else []
        with out_csv.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=headers)
            w.writeheader()
            w.writerows(table)
        out_json.write_text(json.dumps({"lang_code": args.lang_code, "rows": table}, indent=2), encoding="utf-8")
        print(f"wrote {out_csv}")
        print(f"wrote {out_json}")
        if table:
            print("best:", json.dumps(table[0], indent=2))
        return 0

    augmented, summary = build_augmented(
        rows=rows,
        human=human,
        policy=policy,
        margin_low_ids=margin_low_ids,
        max_siblings_per_anchor=args.max_siblings_per_anchor,
        recent_days=args.recent_days,
        max_file_propagation_per_file=args.max_file_propagation_per_file,
    )
    summary["lang_code"] = args.lang_code

    out_csv = out_prefix.with_name(out_prefix.name + "-candidates.csv")
    out_json = out_prefix.with_name(out_prefix.name + "-summary.json")

    headers = ["item_id", "source_rule", "policy_tier", "p_review", "anchor_item_id"]
    with out_csv.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for item in sorted(augmented.keys()):
            row = augmented[item]
            w.writerow(
                {
                    "item_id": item,
                    "source_rule": row.get("source_rule", ""),
                    "policy_tier": row.get("policy_tier", ""),
                    "p_review": row.get("p_review", 0.0),
                    "anchor_item_id": row.get("anchor_item_id", ""),
                }
            )

    out_json.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"wrote {out_csv}")
    print(f"wrote {out_json}")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

