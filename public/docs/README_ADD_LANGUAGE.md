## Add and Deploy New Languages and Dialects

This guide consolidates all steps to add and deploy:
- a new root language (e.g., `de` German)
- a new dialect of an existing root language (e.g., `de-CH` German (Switzerland))
- a new dialect when no root language exists (e.g., `fr-CA` without `fr`)

It merges operational steps for Levante (GCS, audio, deployment) with Crowdin project setup and best practices.

---

### Prerequisites
- Crowdin access (Manager/Admin) and understanding of your localization workflow
- GitHub access for this repo and any integrated CI/CD
- GCP service account with required bucket permissions
  - `levante-dashboard-<env>` (CSV only)
  - `levante-audio-<env>` (audio files + shared config)
- Local environment variables when working from CLI:
  - `export GCP_SERVICE_ACCOUNT_JSON='<service_account_json>'`
- Web dashboard is deployed and can load/save `language_config.json` via `/api/language-config`

### Sources of Truth
- Centralized language configuration JSON:
  - Dev: `gs://levante-audio-dev/language_config.json`
  - Prod: `gs://levante-audio-prod/language_config.json`
- Translations CSV: `item-bank-translations.csv`
  - Stored in repo and deployed to `levante-dashboard-<env>` as `item-bank-translations.csv`

### Language Types and Codes
- Root language: Two-letter ISO codes (e.g., `en`, `es`, `de`, `nl`)
- Dialect/regional variants: BCP 47 locale codes (e.g., `es-CO`, `de-CH`, `fr-CA`)
- Display names should be user-friendly (e.g., `German (Switzerland)`, `Spanish`)

---

## Scenario A: Add a New Root Language

Example: Add `Italian` with code `it`.

#### A.1 Crowdin Project Setup (if applicable)
1) Crowdin › Settings › Languages › Target Languages: add `Italian (it)`
2) (Optional) Language mapping if your repo expects custom folder names
3) (Optional) Pre-translate via TM/MT; invite translators and proofreaders

#### A.2 Ensure CSV Column
- Ensure `item-bank-translations.csv` includes a new column `it`
- If your workflow pulls from `l10n_pending`, commit updates there. Our tools fetch from that branch.

#### A.3 Update Centralized Language Config
- Open the Web Dashboard → click “Edit Language Config”
- Add an entry and choose a default voice:

```json
{
  "Italian": {
    "lang_code": "it",
    "service": "ElevenLabs",
    "voice": "<Default voice name>"
  }
}
```

- Save (writes to `gs://levante-audio-<env>/language_config.json`)

#### A.4 Fetch, Generate, Validate, Deploy
```bash
npm run fetch:translations                 # update local CSV from l10n_pending
python generate_speech.py Italian --force  # initial full build for new language
npm run validate:core-tasks-quick          # optional validation (Cypress)
npm run deploy:translations-dev            # deploy CSV + audio to dev
# After validation
npm run deploy:translations-prod           # manual prod deploy per org rules
```

Notes:
- CSV uploads go to `levante-dashboard-<env>` as `item-bank-translations.csv`
- Audio files go to `gs://levante-audio-<env>/audio_files/<lang_code>/…`

---

## Scenario B: Add a New Dialect (Root Exists)

Example: Add `German (Austria)` with code `de-AT` when `de` exists.

#### B.1 Crowdin Setup
1) Add the dialect in Crowdin: Settings › Languages › Target Languages → `de-AT`
2) (Optional) Enable dialect fallback to root in export settings
3) (Optional) Map custom locale folder names via `languages_mapping`

#### B.2 CSV and Config
- Add column `de-AT` to `item-bank-translations.csv`
- Web Dashboard → Edit Language Config → add entry:
```json
{
  "German (Austria)": {
    "lang_code": "de-AT",
    "service": "ElevenLabs",
    "voice": "<Default voice>"
  }
}
```

#### B.3 Fetch, Generate, Validate, Deploy
```bash
npm run fetch:translations
python generate_speech.py "German (Austria)" --force
npm run validate:core-tasks-quick
npm run deploy:translations-dev
# After validation
npm run deploy:translations-prod
```

Notes:
- Root and dialect columns are independent; both can exist (e.g., `de` and `de-AT`).
- Use `--force` for the initial build to generate all audio for the dialect.

---

## Scenario C: Add a New Dialect (No Root Exists)

Example: Add `French (Canada)` with code `fr-CA` when there is no `fr`.

#### C.1 Crowdin Setup
1) Add `fr-CA` in Crowdin as a Target Language
2) Use TM to bootstrap from the closest variant (optional)

#### C.2 CSV and Config
- Add column `fr-CA` in `item-bank-translations.csv`
- Web Dashboard → Edit Language Config → add entry:
```json
{
  "French (Canada)": {
    "lang_code": "fr-CA",
    "service": "ElevenLabs",
    "voice": "<Default voice>"
  }
}
```

#### C.3 Fetch, Generate, Validate, Deploy
```bash
npm run fetch:translations
python generate_speech.py "French (Canada)" --force
npm run validate:core-tasks-quick
npm run deploy:translations-dev
# After validation
npm run deploy:translations-prod
```

Notes:
- A root `fr` is not required; dialect-only flows are supported.

---

## Buckets and Separation of Concerns
- `levante-dashboard-<env>`: CSV only (`item-bank-translations.csv`). Never upload code or audio here
- `levante-audio-<env>`: audio files under `audio_files/<lang_code>/…` and `language_config.json`

---

## Useful Commands
- Detect new language columns:
```bash
npm run detect:languages
```
- Auto-add languages to config (best-effort helper):
```bash
npm run auto:add-languages
```
- Fetch latest CSV from `l10n_pending`:
```bash
npm run fetch:translations
```
- Generate audio for a language:
```bash
python generate_speech.py "German (Switzerland)" --force
```
- Deploy both CSV and audio:
```bash
npm run deploy:translations-dev
npm run deploy:translations-prod
```
- CSV-only or audio-only deploys:
```bash
npm run deploy:translations-csv-only-dev
npm run deploy:translations-audio-only-dev
```

---

## CI/CD and Crowdin Integration (Reference)

### GitHub Action Skeleton for Crowdin
```yaml
name: Crowdin Localization
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 2 * * *'

jobs:
  crowdin-upload:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: crowdin/github-action@v2
        with:
          upload_sources: true
          upload_translations: false
        env:
          CROWDIN_PROJECT_ID: ${{ secrets.CROWDIN_PROJECT_ID }}
          CROWDIN_PERSONAL_TOKEN: ${{ secrets.CROWDIN_PERSONAL_TOKEN }}

  crowdin-download:
    runs-on: ubuntu-latest
    if: github.event_name == 'schedule'
    steps:
      - uses: actions/checkout@v4
      - uses: crowdin/github-action@v2
        with:
          download_translations: true
          create_pull_request: true
          pull_request_title: 'New Crowdin translations'
          localization_branch_name: l10n_crowdin_translations
        env:
          CROWDIN_PROJECT_ID: ${{ secrets.CROWDIN_PROJECT_ID }}
          CROWDIN_PERSONAL_TOKEN: ${{ secrets.CROWDIN_PERSONAL_TOKEN }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Best Practices and QA
- Prioritize languages by demand and product goals
- Maintain a matrix of enabled languages/dialects and folder names
- Automate pre-translation (TM → MT) and enable QA checks (placeholders, glossary)
- For RTL languages, verify text direction and UI mirroring
- Provide context (screenshots, descriptions) to improve translation quality

---

## Troubleshooting
- “Column <code> not found in CSV”
  - Ensure the language column exists in `item-bank-translations.csv`
  - Re-run `npm run fetch:translations`
- “Anonymous caller” or `401` on deploy
  - Ensure `GCP_SERVICE_ACCOUNT_JSON` is set in CI/local env
  - Grant service account `storage.objectAdmin` on target buckets
- Web dashboard not showing new language
  - Hard refresh; dashboard fetches `language_config.json` at runtime
  - Confirm the config entry exists and was saved successfully
- Fully rebuild a language’s audio
```bash
python generate_speech.py <Language Name> --force
```
This clears per-language cache in `translation_master.csv` and regenerates all items using the current voice.

---

## Templates

### language_config.json Entry
```json
{
  "<Display Name>": {
    "lang_code": "<bcp47_code>",
    "service": "ElevenLabs",
    "voice": "<Default voice name>"
  }
}
```
- For PlayHT, set `"service": "PlayHt"` and provide a valid voice

---

## Rollout Checklist
- [ ] CSV column added for new `lang_code`
- [ ] `language_config.json` updated via web dashboard (GCS saved)
- [ ] Translations fetched locally
- [ ] Audio generated with `--force` (initial build)
- [ ] Validation passed (optional)
- [ ] Dev deploy completed
- [ ] Manual prod deploy completed after validation
