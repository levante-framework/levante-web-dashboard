#!/bin/bash
set -e

GCS_BUCKET="gs://levante-assets-dev/maps/gadm"
GADM_DIR="$HOME/levante/levante-web-dashboard/scripts/gadm-processing"
PROCESSED_DIR="$GADM_DIR/gadm_processed"

echo "☁️  Uploading to GCS: $GCS_BUCKET"

if ! command -v gsutil &> /dev/null; then
  echo "Error: gsutil not found. Install Google Cloud SDK first."
  exit 1
fi

for country_dir in "$PROCESSED_DIR"/*/; do
  [ -d "$country_dir" ] || continue
  
  country_code=$(basename "$country_dir")
  echo ""
  echo "Uploading: $country_code"
  
  for zipfile in "$country_dir"/*.zip; do
    [ -f "$zipfile" ] || continue
    level=$(basename "$zipfile" | grep -oP '_\K[0-9]+(?=\.zip)' || echo "3")
    gsutil cp "$zipfile" "$GCS_BUCKET/${country_code}/level${level}/" || echo "   ⚠️  Failed"
  done
  
  snippets_dir="$country_dir/snippets"
  if [ -d "$snippets_dir" ]; then
    gsutil -m cp "$snippets_dir"/*.json "$GCS_BUCKET/${country_code}/snippets/" || echo "   ⚠️  Failed"
  fi
  
  echo "   ✓ Uploaded $country_code"
done

echo ""
echo "✅ Upload complete!"
