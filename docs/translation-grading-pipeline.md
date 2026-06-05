# Translation Grading Pipeline (Frontier + QE)

This branch introduces a tiered grading script:

- `scripts/translation_grading_pipeline.py`

It follows a multi-method flow:

1. Cross-lingual consistency outlier check (LaBSE / multilingual-e5).
2. Optional reference-free QE (COMET / xCOMET).
3. Optional Gemini direct assessment (LLM-as-judge).
4. Review triage report for dashboard ingestion.

## Why this helps

- Reduces over-reliance on back-translation as a single signal.
- Uses cheap broad screening first, then expensive LLM judging only where needed.
- Supports ambiguity/context constraints through an optional `--ambiguity-col`.

## Example Usage

Basic run (consistency stage only):

```bash
python scripts/translation_grading_pipeline.py \
  --input-mode csv \
  --input-csv data/validation/crowdin-xliff-merged.csv \
  --item-id-col item_id \
  --source-col en \
  --target-cols "es-CO,fr-CA,de-DE,nl"
```

Load from the same Crowdin-approved export path used by the dashboard:

```bash
python scripts/translation_grading_pipeline.py \
  --input-mode crowdin \
  --crowdin-base-url https://levante-cockpit.vercel.app \
  --source-col en \
  --target-cols "de,es-CO,fr-CA,pt-BR"
```

Enable COMET/xCOMET if installed:

```bash
python scripts/translation_grading_pipeline.py \
  --input-mode csv \
  --input-csv data/validation/crowdin-xliff-merged.csv \
  --target-cols "es-CO,fr-CA,de-DE,nl" \
  --run-comet \
  --comet-model Unbabel/wmt22-cometkiwi-da
```

Enable Gemini LLM judge only on flagged rows:

```bash
export GEMINI_API_KEY=...
python scripts/translation_grading_pipeline.py \
  --input-mode csv \
  --input-csv data/validation/crowdin-xliff-merged.csv \
  --target-cols "es-CO,fr-CA,de-DE,nl" \
  --run-comet \
  --run-llm-judge \
  --llm-only-flagged \
  --llm-max-calls 200
```

## Outputs

- CSV report: `data/validation/translation-grading-report.csv`
- JSON summary + row metadata: `data/validation/translation-grading-summary.json`

Rows get flagged for review when one or more thresholds trip:

- `consistency < --consistency-threshold`
- `comet < --comet-threshold` (when COMET enabled)
- `llm_final < --gemini-threshold` or LLM severity is `major`/`critical`

## Dependency notes

- Consistency stage requires `sentence-transformers` and `numpy`.
- COMET stage requires `unbabel-comet`.
- LLM stage uses Gemini REST directly (no extra SDK required) and reads key from `GEMINI_API_KEY` by default.

## Current scope

This first version focuses on robust triage output and optional model stages.
Next likely step is writing flagged rows directly into the dashboard shared review queue format.
