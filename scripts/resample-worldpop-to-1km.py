#!/usr/bin/env python3
"""
Resample WorldPop raster from 100m (3 arc-sec) to 1km (30 arc-sec) resolution.

This creates a much smaller file (~150 MB vs 3.7 GB) that's faster to process
while still providing accurate population estimates.

Usage:
    python3 resample-worldpop-to-1km.py <country_code> [year]

Example:
    python3 resample-worldpop-to-1km.py USA 2020
"""

import sys
from pathlib import Path

try:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.warp import calculate_default_transform, reproject
except ImportError:
    print('Error: Missing required library. Install with: pip install rasterio', file=sys.stderr)
    sys.exit(1)


def resample_to_1km(country_code, year=2020):
    """
    Resample WorldPop raster from 100m to 1km resolution.
    
    Args:
        country_code: ISO3 code (e.g., 'USA')
        year: Year of dataset (default: 2020)
    
    Returns:
        Path to resampled file or None if failed
    """
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    raster_dir = project_root / 'data' / 'population' / 'worldpop'
    
    input_path = raster_dir / f'{country_code}_{year}.tif'
    output_path = raster_dir / f'{country_code}_{year}_1km.tif'
    
    if not input_path.exists():
        print(f'Error: Input file not found: {input_path}', file=sys.stderr)
        print(f'Download it first: ./scripts/download-worldpop-rasters.sh {country_code}', file=sys.stderr)
        return None
    
    if output_path.exists():
        print(f'✓ 1km file already exists: {output_path}')
        return output_path
    
    print(f'Resampling {input_path.name} to 1km resolution...')
    print(f'  Input: {input_path}')
    print(f'  Output: {output_path}')
    print('  This may take a few minutes...')
    
    try:
        with rasterio.open(str(input_path)) as src:
            # Calculate target transform for 1km resolution (30 arc-seconds = 0.00833333 degrees)
            # Original is 3 arc-seconds (0.000833333 degrees)
            # Target: 30 arc-seconds = 10x coarser
            target_resolution = 0.008333333  # 30 arc-seconds = ~1km at equator
            
            # Calculate new dimensions (approximately 1/10th the size)
            new_width = max(1, int(src.width / 10))
            new_height = max(1, int(src.height / 10))
            
            # Calculate transform for new resolution
            transform = rasterio.Affine(
                target_resolution, 0, src.bounds.left,
                0, -target_resolution, src.bounds.top
            )
            
            # Create output profile
            profile = src.profile.copy()
            profile.update({
                'width': new_width,
                'height': new_height,
                'transform': transform,
                'compress': 'lzw',  # Compress to reduce file size
                'tiled': True
            })
            
            # Resample and write
            with rasterio.open(str(output_path), 'w', **profile) as dst:
                for i in range(1, src.count + 1):
                    reproject(
                        source=rasterio.band(src, i),
                        destination=rasterio.band(dst, i),
                        src_transform=src.transform,
                        src_crs=src.crs,
                        dst_transform=transform,
                        dst_crs=src.crs,
                        resampling=Resampling.sum  # Use sum to aggregate population values
                    )
        
        # Get file sizes
        input_size = input_path.stat().st_size / (1024 * 1024)  # MB
        output_size = output_path.stat().st_size / (1024 * 1024)  # MB
        
        print(f'✓ Resampling complete!')
        print(f'  Input size: {input_size:.1f} MB')
        print(f'  Output size: {output_size:.1f} MB')
        print(f'  Reduction: {(1 - output_size/input_size)*100:.1f}%')
        print(f'  Output: {output_path}')
        
        return output_path
        
    except Exception as e:
        print(f'Error during resampling: {e}', file=sys.stderr)
        if output_path.exists():
            output_path.unlink()  # Clean up partial file
        return None


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python3 resample-worldpop-to-1km.py <country_code> [year]', file=sys.stderr)
        print('Example: python3 resample-worldpop-to-1km.py USA 2020', file=sys.stderr)
        sys.exit(1)
    
    country_code = sys.argv[1].upper()
    year = int(sys.argv[2]) if len(sys.argv) > 2 else 2020
    
    result = resample_to_1km(country_code, year)
    if result:
        sys.exit(0)
    else:
        sys.exit(1)
