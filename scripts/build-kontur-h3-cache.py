#!/usr/bin/env python3
"""
Build a compact H3->population cache JSON from Kontur GeoPackage exports.

Usage examples:
  python3 scripts/build-kontur-h3-cache.py \
    --input data/population/kontur_population_20231101_r5.gpkg.gz \
    --input data/population/kontur_population_20231101_r6.gpkg.gz

Output:
  data/gallery/kontur-h3-population-cache.json

The generated JSON shape is:
{
  "meta": { ... },
  "resolutions": {
    "5": { "<h3_cell_id>": 12345, ... },
    "6": { "<h3_cell_id>": 678, ... }
  }
}
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import shutil
import sqlite3
import tempfile
from pathlib import Path
from typing import Dict, Iterable, Optional, Tuple


DEFAULT_OUTPUT = Path("data/gallery/kontur-h3-population-cache.json")


def parse_resolution(path_str: str, explicit: Optional[int]) -> int:
    if explicit is not None:
        return int(explicit)
    m = re.search(r"_r(\d+)\.gpkg(?:\.gz)?$", path_str)
    if not m:
        raise ValueError(f"Could not infer H3 resolution from filename: {path_str}")
    return int(m.group(1))


def maybe_unpack_gpkg(input_path: Path) -> Tuple[Path, Optional[Path]]:
    if input_path.suffix != ".gz":
        return input_path, None
    fd, tmp_name = tempfile.mkstemp(prefix="kontur-", suffix=".gpkg")
    os.close(fd)
    tmp_path = Path(tmp_name)
    with gzip.open(input_path, "rb") as src, open(tmp_path, "wb") as dst:
        shutil.copyfileobj(src, dst)
    return tmp_path, tmp_path


def detect_table_name(conn: sqlite3.Connection) -> str:
    cur = conn.execute(
        """
        SELECT table_name
        FROM gpkg_contents
        WHERE data_type IN ('features', 'attributes')
        ORDER BY CASE WHEN lower(table_name) = 'data' THEN 0 ELSE 1 END, table_name
        LIMIT 1
        """
    )
    row = cur.fetchone()
    if not row or not row[0]:
        raise RuntimeError("Could not detect data table in GeoPackage")
    return str(row[0])


def extract_h3_population(gpkg_path: Path) -> Dict[str, int]:
    conn = sqlite3.connect(str(gpkg_path))
    try:
        table_name = detect_table_name(conn)
        cur = conn.execute(f'SELECT h3, population FROM "{table_name}"')
        out: Dict[str, int] = {}
        for h3_id, pop in cur:
            if not h3_id:
                continue
            try:
                out[str(h3_id)] = int(round(float(pop)))
            except Exception:
                continue
        return out
    finally:
        conn.close()


def parse_input_arg(value: str) -> Tuple[Path, Optional[int]]:
    # Supports:
    #   /path/to/file.gpkg.gz
    #   6:/path/to/file.gpkg.gz
    if ":" in value and value.split(":", 1)[0].isdigit():
        res_s, file_s = value.split(":", 1)
        return Path(file_s), int(res_s)
    return Path(value), None


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Build Kontur H3 population cache JSON")
    parser.add_argument(
        "--input",
        action="append",
        required=True,
        help="Input GeoPackage (.gpkg or .gpkg.gz). Optional 'RESOLUTION:path' prefix, e.g. 6:data/r6.gpkg.gz",
    )
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT),
        help=f"Output JSON path (default: {DEFAULT_OUTPUT})",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    resolutions: Dict[str, Dict[str, int]] = {}
    sources = []

    for item in args.input:
        input_path, explicit_res = parse_input_arg(item)
        if not input_path.exists():
            raise FileNotFoundError(f"Input not found: {input_path}")

        resolution = parse_resolution(str(input_path), explicit_res)
        gpkg_path, tmp_path = maybe_unpack_gpkg(input_path)
        try:
            mapping = extract_h3_population(gpkg_path)
            resolutions[str(resolution)] = mapping
            sources.append({"path": str(input_path), "resolution": resolution, "rows": len(mapping)})
            print(f"Loaded {len(mapping)} rows from {input_path} (r{resolution})")
        finally:
            if tmp_path and tmp_path.exists():
                tmp_path.unlink(missing_ok=True)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "meta": {
            "generatedBy": "scripts/build-kontur-h3-cache.py",
            "sources": sources,
        },
        "resolutions": resolutions,
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=True, indent=2)
    print(f"Saved Kontur H3 cache: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
