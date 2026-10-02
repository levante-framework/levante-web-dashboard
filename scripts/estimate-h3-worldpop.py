#!/usr/bin/env python3
"""Sum WorldPop 1km raster values inside each H3 hex polygon."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import rasterio
from rasterio.mask import mask
from shapely.geometry import shape


def main() -> int:
    if len(sys.argv) < 4:
        print(
            "Usage: estimate-h3-worldpop.py <raster.tif> <cells.geojson> <output.json>",
            file=sys.stderr,
        )
        return 1

    raster_path = Path(sys.argv[1])
    cells_path = Path(sys.argv[2])
    output_path = Path(sys.argv[3])

    collection = json.loads(cells_path.read_text(encoding="utf-8"))
    features = collection.get("features") or []
    pops = {}

    with rasterio.open(raster_path) as src:
        for feature in features:
            cell_id = (feature.get("properties") or {}).get("cellId")
            geom = feature.get("geometry")
            if not cell_id or not geom:
                continue
            try:
                polygon = shape(geom)
                out_image, _ = mask(src, [polygon], crop=True, nodata=0)
                if len(out_image.shape) == 2:
                    total = float(out_image.sum())
                else:
                    total = float(out_image[0].sum())
                pops[cell_id] = int(round(max(total, 0)))
            except Exception:
                pops[cell_id] = None

    output_path.write_text(json.dumps(pops), encoding="utf-8")
    known = sum(1 for value in pops.values() if isinstance(value, int))
    print(f"estimated {known}/{len(features)} hexes", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
