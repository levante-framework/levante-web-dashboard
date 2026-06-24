# Partner Audio Approval Tool — QA Checklist

Use this checklist before merging or deploying the partner audio workstream (`/partner-audio-dashboard`).

## Local setup

- [ ] Run `vercel dev` (not `npm start`) so API routes work.
- [ ] Set GCP credentials in `.env.local` (see `.env.example`): `GCP_SERVICE_ACCOUNT_JSON=secrets/devkey.json`
- [ ] Confirm credentials can read draft bucket, dev bucket, and write `languageoptions.json` on dev bucket.

## Unit tests

```bash
npm run test:partner-audio-translations:unit
npm run test:language-options-task-options:unit
npm run test:partner-audio-regression:unit
npm run test:move-audio-to-dev:unit
```

All should pass.

## Language load and dropdown

- [ ] Open `/partner-audio-dashboard` — page loads without fetching all languages’ translations upfront.
- [ ] Language dropdown lists only audio-capable languages (has `lang_code` + voice in `language_config.json`).
- [ ] Selecting a language loads `GET /api/partner-audio-translations?lang=<code>` once.
- [ ] Switching language clears prior tab counts and reloads items.

## Tabs and classification

| Tab | Expected contents |
|-----|-------------------|
| **To Be Approved** | Valid translations (`ok`) not yet approved for current task |
| **Approved in task** | Staged or promoted approvals for current task filter |
| **Approved** | Items with audio in dev bucket |
| **Missing Audio** | Valid translations with no draft/dev audio |
| **Missing Translation** | Items with literal `NO APPROVED TRANSLATION` |
| **Hidden Strings** | Superadmin only — English keys missing from target export |

- [ ] Status summary counts match tab contents for selected task.
- [ ] **Hidden Strings** tab is disabled/grey when count is 0.
- [ ] **Missing Translation** count excludes hidden strings.

## Approve / unapprove / promote

- [ ] **Approve** stages item for current task (does not move to dev until task finish).
- [ ] **Save & Approve** saves generated audio then stages approval.
- [ ] **Unapprove** on promoted item moves dev → draft; staged-only items drop from staged set.
- [ ] **Approve all (task)** stages all pending items for selected task.
- [ ] **Mark task finished** (when all task audio approved):
  - [ ] Promotes staged draft audio → dev bucket
  - [ ] Posts Slack notification (if configured)
  - [ ] Appends task slug to `languageoptions.json` `taskOptions` for language
  - [ ] Status message reports language-options outcome (added / already present / warning)

## languageoptions.json

After marking a task finished for language `de-DE` and task `memory-game`:

- [ ] `gs://levante-assets-dev/translations/dashboard-consolidated-flat/languageoptions.json` includes `memory-game` under `de-DE.taskOptions` (if not already present).
- [ ] Other language entries unchanged.
- [ ] Re-finishing same task does not duplicate slug; UI shows “already in language options”.

## Crowdin removal

- [ ] No “Crowdin: approved / not approved” badges on item cards.
- [ ] Crowdin screenshot thumbnails still render when artifact exists.

## Search and task filter

- [ ] Task filter scopes all tabs.
- [ ] Search filters visible items across tabs.
- [ ] Task selection persists per language in browser storage.

## Regression guards

```bash
npm run test:partner-audio-regression:unit
```

- [ ] No fabricated audio paths in approve/unapprove flows.
- [ ] Force-refresh bucket lookups on approve/unapprove.

## Production smoke (post-deploy)

- [ ] Partner login restricted to assigned language.
- [ ] Superadmin can access all languages and Hidden Strings tab.
- [ ] `GET /api/partner-audio-language-config` returns audio-capable languages.
- [ ] Finish-task flow on one non-production language/task if available.
