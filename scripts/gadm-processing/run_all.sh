#!/bin/bash
set -e

GADM_DIR="$HOME/levante/levante-web-dashboard/scripts/gadm-processing"
cd "$GADM_DIR"

echo "╔════════════════════════════════════════════════╗"
echo "║   GADM Processing Pipeline - Complete Workflow ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

echo "STEP 1/5: Downloading GADM files..."
bash download_gadm.sh

echo ""
echo "STEP 2/5: Processing shapefiles..."
bash process_gadm_files.sh

echo ""
echo "STEP 3/5: Building snippets..."
node build-gadm-snippets-batch.js

echo ""
echo "STEP 4/5: Generating configuration..."
node generate_config.js

echo ""
echo "STEP 5/5: Uploading to Google Cloud Storage..."
printf "Upload to GCS now? (y/n) "
read -r REPLY
echo
case "$REPLY" in
  [Yy]*)
    bash upload_to_gcs.sh
    ;;
  *)
    echo "Skipping GCS upload. Run upload_to_gcs.sh manually when ready."
    ;;
esac

echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║   ✅ GADM Processing Complete!                 ║"
echo "╚════════════════════════════════════════════════╝"
