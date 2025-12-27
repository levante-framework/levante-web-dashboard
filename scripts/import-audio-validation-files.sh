#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

# Copies audio validation JSON files generated in ../levante_translations into this repo's
# data/validation/ folder so the Audio Validation UI can load them.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR_DEFAULT="$(cd "$ROOT_DIR/../levante_translations/web-dashboard/data" 2>/dev/null && pwd || true)"
SRC_DIR="${1:-$SRC_DIR_DEFAULT}"

if [[ -z "${SRC_DIR:-}" || ! -d "$SRC_DIR" ]]; then
  echo "❌ Source directory not found."
  echo "Tried: $SRC_DIR_DEFAULT"
  echo "Usage: $0 [source_dir]"
  exit 1
fi

DEST_DIR="$ROOT_DIR/data/validation"
mkdir -p "$DEST_DIR"

shopt -s nullglob
FILES=( "$SRC_DIR"/validation-*.json )
shopt -u nullglob

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "⚠️  No files matched: $SRC_DIR/validation-*.json"
  echo "Generate them first via ../levante_translations/validate_language.sh"
  exit 0
fi

echo "📦 Importing ${#FILES[@]} validation files from:"
echo "   $SRC_DIR"
echo "➡️  Into:"
echo "   $DEST_DIR"

for f in "${FILES[@]}"; do
  base="$(basename "$f")"
  cp -f "$f" "$DEST_DIR/$base"
done

echo "✅ Done. Refresh Audio Validation and pick a file from the dropdown."


