#!/usr/bin/env python3
"""
Cleanup timestamped validation artifacts in data/validation.

Rule:
- Delete timestamped files like `foo-20260317-182005.csv`
- Only when the matching canonical file `foo-current.csv` exists.

Safety:
- Dry-run by default (no deletion).
- Use --apply to actually delete files.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path


TIMESTAMP_RE = re.compile(r"^(?P<base>.+)-20\d{6}-\d{6}\.(?P<ext>[A-Za-z0-9]+)$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cleanup timestamped validation artifacts.")
    parser.add_argument(
        "--dir",
        default="data/validation",
        help="Validation artifact directory (default: data/validation)",
    )
    parser.add_argument(
        "--extensions",
        default="csv,json,md",
        help="Comma-separated extension allowlist (default: csv,json,md)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually delete files. Without this flag, runs in dry-run mode.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    target_dir = Path(args.dir).expanduser().resolve()
    if not target_dir.exists() or not target_dir.is_dir():
        raise FileNotFoundError(f"Directory not found: {target_dir}")

    allowed_ext = {part.strip().lower() for part in args.extensions.split(",") if part.strip()}

    candidates = []
    for path in sorted(target_dir.iterdir()):
        if not path.is_file():
            continue
        m = TIMESTAMP_RE.match(path.name)
        if not m:
            continue
        ext = m.group("ext").lower()
        if ext not in allowed_ext:
            continue
        canonical = target_dir / f"{m.group('base')}-current.{ext}"
        if canonical.exists():
            candidates.append((path, canonical))

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] directory: {target_dir}")
    print(f"[{mode}] candidates: {len(candidates)}")

    reclaimed = 0
    for stale, canonical in candidates:
        size = stale.stat().st_size
        reclaimed += size
        action = "DELETE" if args.apply else "WOULD DELETE"
        print(f"{action}: {stale.name} (canonical: {canonical.name}, {size} bytes)")
        if args.apply:
            stale.unlink()

    print(f"[{mode}] total bytes {'reclaimed' if args.apply else 'candidate'}: {reclaimed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

