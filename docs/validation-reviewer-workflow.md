# Translation Validation — Reviewer Workflow Runbook

This is the **operational** guide for a reviewer creating and validating back-translations
in the LEVANTE dashboard. For the scoring math, providers, and thresholds, see
[`README_VALIDATION.md`](../README_VALIDATION.md). This doc covers the click-path, what
"shared storage" means, when your work is saved, and how to recover it.

---

## 1. Where translations come from

- Human translations live in **Crowdin**.
- The dashboard loads **approved-only** Crowdin exports (CSV + XLIFF) as the source text
  for each language. You do not enter translations in the dashboard; you **review** them.

## 2. Generating back-translations

In the per-language validation table:

1. Open the validation view and select a language.
2. Click **Validate** on a row, or **Validate All** to process the whole language.
3. For each non-English row the system round-trips the text:
   **English source → human translation → back to English** via `/api/back-translate`
   (Google is the default provider; HF/NLLB is optional and off by default).
4. A score is produced from a semantic + lexical composite, then **Gemini AI adjudication**
   gives the final score. Rows are color-coded:
   - 🟢 **≥ 90** — good
   - 🟡 **80–89** — borderline, review recommended
   - 🔴 **< 80** — likely problem, review required

> Tip: `Validate All` re-runs the AI scorer on rows. It will **not** clear your manual
> approvals or review flags (the server protects human decisions), but it does refresh
> AI scores.

## 3. Reviewing a row

Open a row to see **source English / human translation / back-translation** side by side,
plus the score breakdown. Then make one of two decisions:

### Approve
- Tick the **Approved** checkbox on the row.
- Effect: score is set to **100%**, `scoreSource = manual`, `manualApproved = true`.
- **Saved immediately** to shared storage (no extra step needed).

### Mark for review
- Tick the **Needs Review** flag. Optionally type a **reason**.
- Effect: `needsReview = true` with a `reviewUpdatedAt` timestamp.
- **Saved automatically** when you toggle the flag (and again when you edit the reason).

> If you change your mind, untick the box to clear the flag/approval. That change is also
> saved automatically.

## 4. What "shared storage" is

When you see **"Validation results saved to shared session storage for team access"**, it
means your work was written to the **team store**, not just your browser:

- Save path: `POST /api/validation-storage`
- Backing store: GCS `gs://levante-tools/validations/by-language/<lang>.json`
- The server **merges** your changes into the team copy (it does not blindly overwrite),
  and keeps rolling history snapshots.
- Your browser `localStorage` is kept as a local backup, but **the team store is the
  source of truth**.

On load, the dashboard calls `loadFromSharedStorage`, which merges the team copy with any
local changes so the whole team sees the same approvals/flags.

## 5. When is my work saved?

| Action | Saved to shared storage? | How |
|---|---|---|
| Tick **Approved** | ✅ Immediately | `saveValidationResults()` runs on toggle |
| Untick **Approved** | ✅ Immediately | same |
| Tick / untick **Needs Review** | ✅ Auto (debounced ~2s) | `queueValidationAutoSave()` |
| Edit a **reason** | ✅ Auto (debounced ~2s) | autosave on input/blur |
| Run **Validate / Validate All** | ✅ AI scores persisted | results written after the run |

Saves are **debounced**: after your last change there is a short delay (~2s) before the
write. If you close the tab the instant after a change, wait for the success message first.

## 6. Recovering work / troubleshooting

- **"I made changes but a teammate doesn't see them."** Confirm you saw the green
  "saved to shared session storage" message. Reload — `loadFromSharedStorage` pulls the
  merged team copy.
- **"My approvals/flags disappeared."** The team store keeps history snapshots, and
  **GCS object versioning is enabled** on `gs://levante-tools`, so prior generations of a
  language file can be restored. Ask an engineer to inspect:
  - current file: `gs://levante-tools/validations/by-language/<lang>.json`
  - history snapshots in the same prefix
  - object versions: `gsutil ls -a gs://levante-tools/validations/by-language/<lang>.json`
- **Auditing what's saved.** An engineer can export an item-level CSV of all
  approved / needs-review items per language directly from the bucket.

## 7. Guardrails in place

- An **AI re-validation can no longer clear a human decision.** The server only clears
  `manualApproved` / `needsReview` when a reviewer explicitly toggles it with a newer
  timestamp (see `mergeValidationEntry` in `api/validation-storage.js`).
- **GCS object versioning + history retention** provide a recovery window for the team
  store.
- Toggling **Needs Review** now auto-saves on its own (it previously only saved if you
  also typed a reason).

---

## Related code

- UI handlers: `public/dashboard.js` (Needs Review / reason / approve checkboxes),
  `public/js/validation.js` (`setManualApprovalForValidation`, `queueValidationAutoSave`,
  `loadFromSharedStorage`, `saveToSharedStorage`).
- Server persistence + merge guard: `api/validation-storage.js`.
- Back-translation provider: `api/back-translate.js`.
- AI adjudication: `api/translation-ai-judge.js`; semantic score: `api/translation-semantic-score.js`.
