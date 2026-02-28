# Dashboard Updates - January 2026

This document tracks major dashboard and partner-audio changes made during January 2026.

## How to Maintain This Log
- Add new entries at the top (newest first) using `YYYY-MM-DD` headings.
- Keep each entry concise and grouped by area (Crowdin, validation, partner audio, etc.).
- Include user-visible behavior changes first, then technical/internal notes.
- When behavior changed due to a bug fix, include the symptom and resolution in one bullet.
- Cross-link to touched docs/readmes when relevant:
  - `README.md`
  - `README_WebDashboard.md`
  - `README_VALIDATION.md`
- If a change is deployment-sensitive, note whether it requires refresh/cache clear or data migration.

## 2026-01 (workstream summary)

### Crowdin + Translation Data
- Switched to cache-first Crowdin loading; live Crowdin refresh only on explicit `Update Translations`.
- Crowdin export uses approved-only translations.
- Added handling for Crowdin build `409` (reuse in-progress build instead of failing immediately).
- Expanded Crowdin merge to include CSV + XLIFF sources, including `main/dashboard/*.csv`.
- Added compact caching strategy and IndexedDB fallback when localStorage quota is exceeded.

### CSV Fallback and Data Sources UI
- CSV fallback now merges multiple sources (item bank + surveys + additional configured CSVs).
- Data source controls moved into their own top panel above voice tools.
- Data source label now clearly identifies cached Crowdin payloads and retrieval timestamp.

### Rendering and Performance
- Added progressive row rendering and DOM batching (`DocumentFragment` + frame slicing).
- Added render deduplication and stale render cancellation to prevent duplicate long renders.
- Added performance logging for cache reads, parsing, merging, and render phases.
- Added explicit validation summary loading state (`Rendering...` + spinner) while table builds.

### Table UX and File-Aware Filtering
- Added per-language file filter dropdown (All Files + detected source files).
- Added backward compatibility for older cache rows lacking `_sourcePaths` by deriving path from composite IDs.
- File filter options are constrained to current language plus shared files.
- Added locale alias compatibility in file relevance checks (`en`/`en-US`, `de`/`de-DE`).

### Validation Improvements
- Validation now strips HTML before scoring and back-translation.
- Validation modal includes note that scoring uses normalized plain text.
- Validation modal now backfills sparse historical records from current row data.
- Missing back-translation in old records can be generated on-demand in modal.
- Compact validation snapshots now retain `backTranslation`.
- Validation key read/write is alias-safe (`en`<->`en-US`, `de`<->`de-DE`).

### Language Code Migration Compatibility
- Added compatibility for moving UI/config language codes to locale forms (`en-US`, `de-DE`).
- Validation and metadata lookup resolve aliases so old data remains visible.
- Audio lookup/save flows use canonical bucket language codes to avoid path misses.
- `read-tags` API fallback now supports `en-US -> en` and `de-DE -> de`.

### Partner Audio Approval Tool
- Added `Approve All Audio (Language)` bulk action in pending tab.
- Added button state guards, progress messaging, and post-run summary counts.
- Strengthened refresh/cache invalidation after approve/unapprove moves.
- Approval state now supports timestamp-based resolution:
  - item is considered approved only when newest dev copy is newer/equal than draft copy.
  - prevents passive flips to approved when draft has the newest version.

## Notes
- This changelog complements the high-level summaries in:
  - `README.md`
  - `README_WebDashboard.md`
  - `README_VALIDATION.md`
