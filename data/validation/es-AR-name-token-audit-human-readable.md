# es-AR Name-Token Scoring Audit (Human-Readable)

## Key Results
- Rows analyzed: **1131**
- Name-mask applied rows: **198**
- Status-changed rows: **76**
- Improved rows: **196**
- Worsened rows: **2**
- Potential false-penalty fixes (old low score, not human-flagged, now >= review): **21**

## Interpretation
- The token-level name masking materially reduces score penalties in name-sensitive cases.
- Most status changes move items upward (toward `warning`/`good`), aligning better with human non-review outcomes.
- A small number of rows shift downward and should be spot-checked manually.

## Status Change Breakdown
- Upward status changes: **76**
- Downward status changes: **0**

## Top Status-Changed Examples
### 1. `TeacherStudentsGenderBoys`
- Score: `31.67` -> `96.67` (delta `65.0`)
- Status: `error` -> `good`
- Human needs_review: `0`
- Source: "Boys"
- Translation: "Niños"
- Back-translation: "Children"

### 2. `navigation.previous`
- Score: `31.57` -> `96.57` (delta `65.0`)
- Status: `error` -> `good`
- Human needs_review: `0`
- Source: "Previous"
- Translation: "Anterior"
- Back-translation: "Former"

### 3. `ChildHealth`
- Score: `31.82` -> `96.81` (delta `64.99`)
- Status: `error` -> `good`
- Human needs_review: `0`
- Source: "Poor"
- Translation: "Deficiente"
- Back-translation: "Deficient"

### 4. `ChildTeeth`
- Score: `31.82` -> `96.81` (delta `64.99`)
- Status: `error` -> `good`
- Human needs_review: `0`
- Source: "Poor"
- Translation: "Deficiente"
- Back-translation: "Deficient"

### 5. `SelfLifeChangesWork`
- Score: `59.39` -> `98.39` (delta `39.0`)
- Status: `error` -> `good`
- Human needs_review: `0`
- Source: "Work:"
- Translation: "Trabajo:"
- Back-translation: "Job:"

### 6. `HomeHOME25`
- Score: `60.53` -> `93.45` (delta `32.92`)
- Status: `error` -> `good`
- Human needs_review: `0`
- Source: "Almost never"
- Translation: "Casi nunca"
- Back-translation: "Hardly ever"

### 7. `HomeHOME26`
- Score: `60.53` -> `93.45` (delta `32.92`)
- Status: `error` -> `good`
- Human needs_review: `0`
- Source: "Almost never"
- Translation: "Casi nunca"
- Back-translation: "Hardly ever"

### 8. `HomeHOME27`
- Score: `60.53` -> `93.45` (delta `32.92`)
- Status: `error` -> `good`
- Human needs_review: `0`
- Source: "Almost never"
- Translation: "Casi nunca"
- Back-translation: "Hardly ever"

### 9. `HomeHOME33`
- Score: `60.53` -> `93.45` (delta `32.92`)
- Status: `error` -> `good`
- Human needs_review: `0`
- Source: "Almost never"
- Translation: "Casi nunca"
- Back-translation: "Hardly ever"

### 10. `HomeHOME34`
- Score: `60.53` -> `93.45` (delta `32.92`)
- Status: `error` -> `good`
- Human needs_review: `0`
- Source: "Almost never"
- Translation: "Casi nunca"
- Back-translation: "Hardly ever"

## Files
- Full audit: `/home/david/levante/levante-web-dashboard/data/validation/es-AR-name-token-audit-full-current.csv`
- Affected rows: `/home/david/levante/levante-web-dashboard/data/validation/es-AR-name-token-audit-affected-current.csv`
- Top 25 status-changed CSV: `/home/david/levante/levante-web-dashboard/data/validation/es-AR-name-token-audit-top25-status-changed-current.csv`

## Update: Strict Proper-Noun Gating
- Masking is now applied only when item type is explicitly `proper_noun`.
- This prevents sentence-start capitalization from being treated as names (e.g., "Almost never" vs "Hardly ever").
- Latest full-dataset audit after this fix: `name_mask_applied_rows = 0`, `status_changed_rows = 0` on current live es-AR validation rows.
