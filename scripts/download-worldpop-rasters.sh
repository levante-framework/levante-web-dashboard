#!/bin/bash
# Download WorldPop raster files for supported countries
# Usage: ./download-worldpop-rasters.sh [country_code]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RASTER_DIR="$PROJECT_ROOT/data/population/worldpop"
YEAR=2020
BASE_URL="https://data.worldpop.org/GIS/Population/Global_2000_2020/$YEAR"

# Supported countries (ISO3 codes)
COUNTRIES=(
    "USA"
    "CAN"
    "COL"
    "IND"
    "ARG"
    "NLD"
    "GHA"
    "CHE"
    "DEU"
    "GBR"
)

# Create raster directory
mkdir -p "$RASTER_DIR"

# Function to download a country's raster
download_country() {
    local country=$1
    local country_lower=$(echo "$country" | tr '[:upper:]' '[:lower:]')
    
    # Use 1km aggregated version (much smaller, ~150MB vs 3.7GB)
    local base_url_1km="https://data.worldpop.org/GIS/Population/Global_2000_2020_1km/${YEAR}"
    local filename_1km="${country_lower}_ppp_${YEAR}_1km_Aggregated.tif"
    local url_1km="${base_url_1km}/${country}/${filename_1km}"
    local output_path="${RASTER_DIR}/${country}_${YEAR}_1km.tif"
    
    # Try 1km version first
    local url="$url_1km"
    local filename="$filename_1km"
    
    if [ -f "$output_path" ]; then
        echo "✓ $country: Already downloaded ($output_path)"
        return 0
    fi
    
    echo "Downloading $country..."
    echo "  URL: $url"
    echo "  Output: $output_path"
    
    if curl -L -f -o "$output_path" "$url"; then
        local size=$(du -h "$output_path" | cut -f1)
        echo "✓ $country: Downloaded successfully ($size)"
        
        # If file is large (>1GB), suggest resampling to 1km
        file_size_mb=$(du -m "$output_path" | cut -f1)
        if [ "$file_size_mb" -gt 1000 ]; then
            echo "  ⚠️  Large file detected (${file_size_mb}MB). Consider resampling to 1km:"
            echo "     python3 scripts/resample-worldpop-to-1km.py $country $YEAR"
        fi
        
        return 0
    else
        echo "✗ $country: Download failed"
        rm -f "$output_path"
        return 1
    fi
}

# If country code provided, download only that country
if [ $# -eq 1 ]; then
    download_country "$1"
else
    # Download all supported countries
    echo "Downloading WorldPop raster files for ${#COUNTRIES[@]} countries..."
    echo "Output directory: $RASTER_DIR"
    echo ""
    
    success=0
    failed=0
    
    for country in "${COUNTRIES[@]}"; do
        if download_country "$country"; then
            ((success++))
        else
            ((failed++))
        fi
        echo ""
    done
    
    echo "Summary: $success successful, $failed failed"
    
    if [ $failed -eq 0 ]; then
        echo ""
        echo "✓ All downloads completed successfully!"
        echo "Total size: $(du -sh "$RASTER_DIR" | cut -f1)"
    fi
fi
