# WorldPop Raster Processing Guide

## How It Works

### Current API Approach (Problems)
- **WorldPop REST API**: Makes HTTP requests with GeoJSON polygons
- **Issues**: 
  - Creates async tasks that never complete
  - Polling endpoint creates NEW tasks instead of checking status
  - 60+ second timeouts, then falls back to GeoNames
  - Rate limits: 1,000 calls/day without API key

### Raster Processing Approach (Better)

**Step 1: Download Raster Files**
- WorldPop provides GeoTIFF files (raster images) with population data
- Each pixel represents population count at that location
- Files are organized by country and year
- Example: `usa_ppp_2020_1km_Aggregated.tif` (~50-200 MB per country)

**Step 2: Process Locally**
- Use Python libraries (`rasterio`, `gdal`) to:
  1. Load the GeoTIFF file
  2. Mask/extract pixels within your polygon
  3. Sum all pixel values = total population

**Step 3: Cache Results**
- Once downloaded, raster files stay on disk
- Processing is instant (milliseconds per polygon)
- No API calls, no rate limits, no timeouts

## Speed Comparison

### Current API Approach
```
Request → Wait for task → Poll every 2s → Timeout after 60s → Fallback to GeoNames
Time: 60+ seconds per polygon (often fails)
```

### Raster Processing Approach
```
Load raster (once) → Extract polygon → Sum pixels → Return result
Time: <1 second per polygon (after initial download)
```

**Speed Improvement: 60-100x faster** (after initial download)

## Implementation Example

### Python Script (`scripts/estimate-population-worldpop.py`)

```python
#!/usr/bin/env python3
"""
Estimate population from WorldPop raster data.
Usage: python estimate-population-worldpop.py <country_code> <geojson>
"""

import sys
import json
import rasterio
from rasterio.mask import mask
from shapely.geometry import shape

def estimate_population(country_code, geojson_str):
    """
    Estimate population within a polygon using WorldPop raster.
    
    Args:
        country_code: ISO3 code (e.g., 'USA', 'CAN')
        geojson_str: JSON string of GeoJSON polygon
    
    Returns:
        Population estimate (int) or None if failed
    """
    # Load GeoJSON
    geojson = json.loads(geojson_str)
    geom = shape(geojson['geometry'])
    
    # Path to WorldPop raster (downloaded locally)
    raster_path = f'data/population/worldpop/{country_code}_2020.tif'
    
    try:
        with rasterio.open(raster_path) as src:
            # Extract pixels within polygon
            out_image, out_transform = mask(src, [geom], crop=True, nodata=0)
            
            # Sum all non-nodata pixels
            total_population = int(out_image.sum())
            
            return total_population if total_population > 0 else None
            
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        return None

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print('Usage: python estimate-population-worldpop.py <country_code> <geojson>')
        sys.exit(1)
    
    country_code = sys.argv[1].upper()
    geojson_str = sys.argv[2]
    
    result = estimate_population(country_code, geojson_str)
    if result is not None:
        print(result)
    else:
        sys.exit(1)
```

### JavaScript Integration

```javascript
const { execSync } = require('child_process');
const path = require('path');

async function estimatePopulationFromWorldPopRaster(geometry, countryCode) {
  const scriptPath = path.join(__dirname, 'estimate-population-worldpop.py');
  const geomJson = JSON.stringify({ type: 'Feature', geometry });
  
  try {
    const result = execSync(
      `python3 "${scriptPath}" "${countryCode}" '${geomJson}'`,
      { encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 }
    );
    
    const population = parseInt(result.trim(), 10);
    return isNaN(population) ? null : population;
    
  } catch (e) {
    console.warn('WorldPop raster estimation failed:', e.message);
    return null;
  }
}
```

## Setup Steps

### 1. Download WorldPop Rasters

```bash
# Create directory
mkdir -p data/population/worldpop

# Download USA 2020 (1km resolution, ~150 MB)
curl -L "https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/USA/usa_ppp_2020_1km_Aggregated.tif" \
  -o data/population/worldpop/USA_2020.tif

# Download other countries as needed
# Canada: ~50 MB
# India: ~200 MB
# etc.
```

### 2. Install Python Dependencies

```bash
pip install rasterio shapely
```

### 3. Update Gallery Script

Replace `estimatePopulationFromWorldPop()` with raster-based version.

## File Sizes

| Country | Resolution | Size (approx) |
|---------|-----------|---------------|
| USA     | 1km       | ~150 MB       |
| Canada  | 1km       | ~50 MB        |
| India   | 1km       | ~200 MB       |
| UK      | 1km       | ~20 MB        |
| Germany | 1km       | ~30 MB        |

**Total for 10 countries: ~500 MB - 1 GB**

## Advantages

1. **Speed**: 60-100x faster than API (after download)
2. **Reliability**: No API failures, timeouts, or rate limits
3. **Offline**: Works without internet after download
4. **Accuracy**: Same data source, processed locally
5. **No API Key**: No registration or approval needed

## Disadvantages

1. **Storage**: Need ~500 MB - 1 GB disk space
2. **Initial Setup**: Download files and install Python libraries
3. **Updates**: Need to re-download if you want newer years
4. **Country Coverage**: Only countries you download

## Recommendation

**For production use**: Raster processing is much better
- Faster, more reliable, no API issues
- One-time setup cost, then instant results

**For quick testing**: GeoNames works fine
- Already implemented and working
- Less accurate but sufficient for many use cases
