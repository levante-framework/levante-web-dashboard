#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

# Generates an audio validation JSON via ../levante_translations/validate_language.sh
# then copies the output JSON into this repo's data/validation/ so the UI can load it.
#
# Usage:
#   ./scripts/generate-audio-validation.sh es-CO

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRANSLATIONS_DIR="$ROOT_DIR/../levante_translations"
VALIDATE_SCRIPT="$TRANSLATIONS_DIR/validate_language.sh"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <language_code>"
  echo "Example: $0 es-CO"
  exit 1
fi

LANGUAGE="$1"

if [[ ! -x "$VALIDATE_SCRIPT" ]]; then
  if [[ -f "$VALIDATE_SCRIPT" ]]; then
    echo "⚠️  $VALIDATE_SCRIPT exists but is not executable."
    echo "Run: chmod +x \"$VALIDATE_SCRIPT\""
    exit 1
  fi
  echo "❌ Missing: $VALIDATE_SCRIPT"
  exit 1
fi

echo "🚀 Running audio validation in levante_translations for: $LANGUAGE"
(cd "$TRANSLATIONS_DIR" && "$VALIDATE_SCRIPT" "$LANGUAGE")

echo "📥 Importing generated file(s) into this dashboard repo..."
bash "$ROOT_DIR/scripts/import-audio-validation-files.sh"

if [[ "${UPLOAD_TO_GCS:-0}" == "1" ]]; then
  echo "☁️  UPLOAD_TO_GCS=1 set; uploading validation file(s) to the dashboard data bucket..."
  node "$ROOT_DIR/scripts/upload-audio-validation-files.js"
fi

echo "✅ Done. Open Pitwall → Audio Validation, select the newest file, and Load."


