#!/bin/bash
set -e

COUNTRIES=(
  "GBR:Scotland"
  "USA:USA"
  "CAN:Canada"
  "COL:Colombia"
  "IND:India"
  "ARG:Argentina"
  "NLD:Netherlands"
  "GHA:Ghana"
  "CHE:Switzerland"
  "DEU:Germany"
)

GADM_DIR="$HOME/levante/levante-web-dashboard/scripts/gadm-processing"
OUTPUT_DIR="$GADM_DIR/gadm_downloads"
mkdir -p "$OUTPUT_DIR"

echo "📦 Downloading GADM shapefiles for ${#COUNTRIES[@]} countries..."

for country in "${COUNTRIES[@]}"; do
  IFS=':' read -r code name <<< "$country"
  echo ""
  echo "⬇️  Downloading $name ($code)..."
  
  URL="https://geodata.ucdavis.edu/gadm/gadm4.1/shp/gadm41_${code}_shp.zip"
  OUTPUT="$OUTPUT_DIR/gadm41_${code}_shp.zip"
  
  if [ -f "$OUTPUT" ]; then
    echo "   ✓ Already exists: $OUTPUT"
  else
    curl -L -o "$OUTPUT" "$URL" || {
      echo "   ⚠️  Failed to download $name"
      continue
    }
    echo "   ✓ Downloaded: $OUTPUT"
  fi
done

echo ""
echo "✅ Download complete! Files saved to: $OUTPUT_DIR"
