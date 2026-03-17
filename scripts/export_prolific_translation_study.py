#!/usr/bin/env python3
"""
Export Prolific study items from merged translation CSV.
"""

from __future__ import annotations

import argparse
import csv
import random
from collections import defaultdict
from pathlib import Path
from typing import Dict, List

CONSENT_LANGUAGE = (
    "By answering the following questions, you are participating in a study being performed by "
    "cognitive scientists in the Stanford Department of Psychology. If you have questions about this "
    "research, please contact Michael C. Frank at mcfrank@stanford.edu. If you are not satisfied "
    "with how this study is being conducted, or if you have any concerns, complaints, or general "
    "questions about the research or your rights as a participant, please contact the Stanford "
    "Institutional Review Board (IRB) to speak to someone independent of the research team at "
    "irbnonmed@stanford.edu. Your participation in this research is voluntary. You may decline to "
    "answer any or all of the following questions. You may decline further participation, at any time, "
    "without adverse consequences. Your confidentiality is assured; the researchers who have requested "
    "your participation will not receive any personal information about you."
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Export Prolific translation study items.")
    p.add_argument("--translations-csv", default="data/validation/crowdin-xliff-merged.csv")
    p.add_argument("--target-col", default="es-AR")
    p.add_argument("--source-col", default="en")
    p.add_argument("--sample-size", type=int, default=200)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--output-csv", default="data/validation/prolific-study-es-AR.csv")
    return p.parse_args()


def path_prefix(item_id: str) -> str:
    raw = str(item_id or "")
    if "::" in raw:
        raw = raw.split("::", 1)[0]
    parts = [p for p in raw.split("/") if p]
    if len(parts) >= 3:
        return "/".join(parts[:3])
    return "/".join(parts) if parts else "unknown"


def load_rows(path: Path, source_col: str, target_col: str) -> List[dict]:
    rows: List[dict] = []
    with path.open("r", encoding="utf-8", newline="") as f:
        rd = csv.DictReader(f)
        for r in rd:
            item_id = str(r.get("identifier") or r.get("item_id") or "").strip()
            source = str(r.get(source_col, "") or "").strip()
            target = str(r.get(target_col, "") or "").strip()
            if not item_id or not source or not target:
                continue
            content_type = str(r.get("contentType", "") or "general").strip().lower() or "general"
            rows.append(
                {
                    "item_id": item_id,
                    "lang_code": target_col,
                    "content_type": content_type,
                    "path_prefix": path_prefix(item_id),
                    "source_en": source,
                    "translation_target": target,
                }
            )
    return rows


def stratified_sample(rows: List[dict], sample_size: int, seed: int) -> List[dict]:
    if sample_size <= 0 or sample_size >= len(rows):
        return list(rows)
    rnd = random.Random(seed)
    buckets: Dict[str, List[dict]] = defaultdict(list)
    for r in rows:
        buckets[str(r["content_type"])].append(r)

    keys = sorted(buckets.keys())
    out: List[dict] = []
    remaining = sample_size
    remaining_keys = len(keys)
    for k in keys:
        group = buckets[k]
        rnd.shuffle(group)
        take = max(1, round(remaining / max(1, remaining_keys)))
        take = min(take, len(group), remaining)
        out.extend(group[:take])
        remaining -= take
        remaining_keys -= 1
    if remaining > 0:
        picked_ids = {r["item_id"] for r in out}
        leftovers = [r for r in rows if r["item_id"] not in picked_ids]
        rnd.shuffle(leftovers)
        out.extend(leftovers[:remaining])
    return out[:sample_size]


def main() -> int:
    args = parse_args()
    src = Path(args.translations_csv)
    outp = Path(args.output_csv)
    outp.parent.mkdir(parents=True, exist_ok=True)

    rows = load_rows(src, args.source_col, args.target_col)
    sampled = stratified_sample(rows, args.sample_size, args.seed)

    instruction = (
        CONSENT_LANGUAGE
        + " "
        "Assess whether translation preserves the same meaning/intended child-facing content "
        "for children age 5-9. Rate meaning equivalence and child clarity."
    )
    out_rows = []
    for i, r in enumerate(sampled, start=1):
        out_rows.append(
            {
                "study_item_id": f"{args.target_col}-{i:05d}",
                "item_id": r["item_id"],
                "lang_code": r["lang_code"],
                "content_type": r["content_type"],
                "path_prefix": r["path_prefix"],
                "source_en": r["source_en"],
                "translation_target": r["translation_target"],
                "instructions": instruction,
            }
        )

    headers = list(out_rows[0].keys()) if out_rows else [
        "study_item_id",
        "item_id",
        "lang_code",
        "content_type",
        "path_prefix",
        "source_en",
        "translation_target",
        "instructions",
    ]
    with outp.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        w.writerows(out_rows)

    print(f"wrote {outp} rows={len(out_rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

