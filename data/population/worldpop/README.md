# WorldPop Raster Data

This directory contains WorldPop GeoTIFF raster files for population estimation.

## Setup

### 1. Install Python Dependencies

```bash
pip install rasterio shapely
```

Or with conda:

```bash
conda install -c conda-forge rasterio shapely
```

### 2. Download Raster Files

Download all supported countries:

```bash
cd /home/david/levante/levante-web-dashboard
./scripts/download-worldpop-rasters.sh
```

Or download a specific country:

```bash
./scripts/download-worldpop-rasters.sh USA
```

### 3. Verify Installation

Test the Python script:

```bash
python3 scripts/estimate-population-worldpop.py USA '{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[-87.7,41.8],[-87.5,41.8],[-87.5,42.0],[-87.7,42.0],[-87.7,41.8]]]}}'
```

Expected output: A population number (integer)

## Supported Countries

- USA (United States)
- CAN (Canada)
- COL (Colombia)
- IND (India)
- ARG (Argentina)
- NLD (Netherlands)
- GHA (Ghana)
- CHE (Switzerland)
- DEU (Germany)
- GBR (United Kingdom)

## File Structure

Files are named: `{ISO3_CODE}_{YEAR}.tif`

Example: `USA_2020.tif`, `CAN_2020.tif`

## File Sizes

Approximate sizes per country:
- USA: ~150 MB
- Canada: ~50 MB
- India: ~200 MB
- Other countries: ~20-50 MB

Total for all countries: ~500 MB - 1 GB

## Usage

The gallery generation script (`scripts/generate-gallery-images.js`) automatically uses raster processing when:
1. Raster files are present in this directory
2. Python dependencies are installed
3. Country code is provided

If raster processing fails, it falls back to GeoNames automatically.
