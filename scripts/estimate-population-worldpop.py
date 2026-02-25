#!/usr/bin/env python3
# Try to use venv Python if available, otherwise use system python3
"""
Estimate population from WorldPop raster data.

Usage:
    python estimate-population-worldpop.py <country_code> <geojson> [year]

Example:
    python estimate-population-worldpop.py USA '{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[-87.7,41.8],[-87.5,41.8],[-87.5,42.0],[-87.7,42.0],[-87.7,41.8]]]}}' 2022

Returns:
    Population estimate (integer) or exits with code 1 if failed
"""

import sys
import json
import os
from pathlib import Path

try:
    import rasterio
    from rasterio.mask import mask
    from shapely.geometry import shape
except ImportError as e:
    print(f'Error: Missing required library. Install with: pip install rasterio shapely', file=sys.stderr)
    sys.exit(1)


def estimate_population(country_code, geojson_str, year=2022):
    """
    Estimate population within a polygon using WorldPop raster.
    
    Args:
        country_code: ISO3 code (e.g., 'USA', 'CAN')
        geojson_str: JSON string of GeoJSON polygon
        year: Year of WorldPop dataset (default: 2020)
    
    Returns:
        Population estimate (int) or None if failed
    """
    # Parse GeoJSON
    try:
        geojson = json.loads(geojson_str)
        geom = shape(geojson['geometry'])
    except (json.JSONDecodeError, KeyError, ValueError) as e:
        print(f'Error: Invalid GeoJSON: {e}', file=sys.stderr)
        return None
    
    # Find script directory and locate raster file
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    raster_dir = project_root / 'data' / 'population' / 'worldpop'
    
    # Try 1km aggregated version first, fall back to full resolution
    raster_path_1km = raster_dir / f'{country_code.upper()}_{year}_1km.tif'
    raster_path = raster_dir / f'{country_code.upper()}_{year}.tif'
    
    # Use 1km if available, otherwise use full resolution
    if raster_path_1km.exists():
        raster_path = raster_path_1km
    elif not raster_path.exists():
        print(f'Error: WorldPop raster not found: {raster_path}', file=sys.stderr)
        print(f'Download it from: https://data.worldpop.org/GIS/Population/Global_2021_2022_1km_UNadj/unconstrained/{year}/{country_code.upper()}/', file=sys.stderr)
        print(f'Or create 1km version: python3 scripts/resample-worldpop-to-1km.py {country_code.upper()}', file=sys.stderr)
        return None
    
    try:
        with rasterio.open(str(raster_path)) as src:
            # Extract pixels within polygon
            out_image, out_transform = mask(src, [geom], crop=True, nodata=0)
            
            # Sum all non-nodata pixels
            # Handle both single-band and multi-band rasters
            if len(out_image.shape) == 2:
                # Single band
                total_population = int(out_image.sum())
            else:
                # Multi-band - sum first band
                total_population = int(out_image[0].sum())
            
            return total_population if total_population > 0 else None
            
    except Exception as e:
        print(f'Error processing raster: {e}', file=sys.stderr)
        return None


if __name__ == '__main__':
    if len(sys.argv) < 3 or len(sys.argv) > 4:
        print('Usage: python estimate-population-worldpop.py <country_code> <geojson> [year]', file=sys.stderr)
        print('Example: python estimate-population-worldpop.py USA \'{"type":"Feature","geometry":{...}}\' 2022', file=sys.stderr)
        sys.exit(1)
    
    country_code = sys.argv[1].upper()
    geojson_str = sys.argv[2]
    year = 2022
    if len(sys.argv) == 4:
        try:
            year = int(sys.argv[3])
        except ValueError:
            print(f'Error: Invalid year: {sys.argv[3]}', file=sys.stderr)
            sys.exit(1)
    
    result = estimate_population(country_code, geojson_str, year=year)
    if result is not None:
        print(result)
        sys.exit(0)
    else:
        sys.exit(1)
