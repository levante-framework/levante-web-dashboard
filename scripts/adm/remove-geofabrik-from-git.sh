#!/bin/bash

# Remove geofabrik files from git tracking
# These files should be stored in GCS bucket, not in the repo

echo "🗑️  Removing geofabrik files from git tracking..."
echo ""

# Find all geofabrik files tracked in git
geofabrik_files=$(git ls-files | grep -E "geofabrik.*\.json\.gz$")

if [ -z "$geofabrik_files" ]; then
  echo "✅ No geofabrik files found in git tracking"
  exit 0
fi

echo "Found $(echo "$geofabrik_files" | wc -l) geofabrik files to remove:"
echo "$geofabrik_files" | head -10
if [ $(echo "$geofabrik_files" | wc -l) -gt 10 ]; then
  echo "... and $(($(echo "$geofabrik_files" | wc -l) - 10)) more"
fi
echo ""

read -p "Remove these files from git tracking? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ Cancelled"
  exit 1
fi

# Remove from git tracking (but keep local files)
echo "$geofabrik_files" | xargs git rm --cached

echo ""
echo "✅ Removed geofabrik files from git tracking"
echo ""
echo "Next steps:"
echo "  1. Commit this change: git commit -m 'Remove geofabrik files from git tracking'"
echo "  2. Ensure files are uploaded to GCS: node scripts/adm/upload-boundary-packs-to-gcs.js"
echo "  3. Files are now ignored by .gitignore"
