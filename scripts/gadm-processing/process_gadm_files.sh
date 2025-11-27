#!/bin/bash
set -e

GADM_DIR="$HOME/levante/levante-web-dashboard/scripts/gadm-processing"
INPUT_DIR="$GADM_DIR/gadm_downloads"
OUTPUT_DIR="$GADM_DIR/gadm_processed"

mkdir -p "$OUTPUT_DIR"

echo "📂 Processing GADM shapefiles..."

for zipfile in "$INPUT_DIR"/*.zip; do
  [ -e "$zipfile" ] || continue
  
  basename=$(basename "$zipfile" .zip)
  country_code=$(echo "$basename" | cut -d'_' -f2)
  
  echo ""
  echo "Processing: $basename"
  
  temp_dir="$OUTPUT_DIR/temp_$country_code"
  mkdir -p "$temp_dir"
  
  unzip -q -o "$zipfile" -d "$temp_dir"
  
  for level in 4 3 2; do
    shp_pattern="$temp_dir/gadm41_${country_code}_${level}.shp"
    if ls $shp_pattern 2>/dev/null; then
      echo "   ✓ Found level $level"
      
      country_dir="$OUTPUT_DIR/${country_code}"
      mkdir -p "$country_dir/level${level}"
      
      cp "$temp_dir/gadm41_${country_code}_${level}".* "$country_dir/level${level}/"
      
      (cd "$country_dir/level${level}" && zip -q "../gadm41_${country_code}_${level}.zip" gadm41_${country_code}_${level}.*)
      
      echo "   ✓ Processed to: $country_dir/level${level}"
      break
    fi
  done
  
  rm -rf "$temp_dir"
done

echo ""
echo "✅ Processing complete! Files in: $OUTPUT_DIR"
