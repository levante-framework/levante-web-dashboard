#!/bin/bash
# Cleanup script to remove geofabrik files from local disk
# These files are now stored in GCS and loaded via /api/adm-pack endpoint

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ADM_PACKS_DIR="$REPO_ROOT/public/adm-packs"

echo "🧹 Cleaning up geofabrik files from local disk..."
echo "   Directory: $ADM_PACKS_DIR"
echo ""

# Count files before deletion
BEFORE_COUNT=$(find "$ADM_PACKS_DIR" -name '*geofabrik*.json.gz' -type f 2>/dev/null | wc -l)
BEFORE_SIZE=$(find "$ADM_PACKS_DIR" -name '*geofabrik*.json.gz' -type f -exec du -ch {} + 2>/dev/null | tail -1 | cut -f1)

if [ "$BEFORE_COUNT" -eq 0 ]; then
  echo "✅ No geofabrik files found. Nothing to clean up."
  exit 0
fi

echo "📊 Found $BEFORE_COUNT geofabrik files (~$BEFORE_SIZE)"
echo ""

# Remove files
echo "🗑️  Removing files..."
find "$ADM_PACKS_DIR" -name '*geofabrik*.json.gz' -type f -delete

# Verify deletion
AFTER_COUNT=$(find "$ADM_PACKS_DIR" -name '*geofabrik*.json.gz' -type f 2>/dev/null | wc -l)

if [ "$AFTER_COUNT" -eq 0 ]; then
  echo "✅ Successfully removed $BEFORE_COUNT geofabrik files (~$BEFORE_SIZE freed)"
  echo ""
  echo "ℹ️  Note: These files are still available in GCS bucket: levante-assets-draft/maps/boundaries/"
  echo "   They can be downloaded or regenerated if needed for local development."
else
  echo "⚠️  Warning: $AFTER_COUNT files still remain (expected: 0)"
  exit 1
fi
