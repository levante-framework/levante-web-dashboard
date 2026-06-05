# Translation Grading Flag Report (All Languages)

Generated from:

- `data/validation/translation-grading-report-all-languages.csv`
- `data/validation/translation-grading-summary-all-languages.json`
- `data/validation/translation-grading-llm-flagged-sample.csv`

## Run Scope

- Input mode: Crowdin approved export (`/api/crowdin-approved-translations`)
- Languages: `ar-IL,de,de-CH,en-GB,en-GH,en-US,es-AR,es-CO,fr-CA,he-IL,nl,pt-BR,pt-PT`
- Total source-target pairs scored: **7,139**

## Metric Flags (Consistency Stage)

- Total flagged: **755 / 7,139 (10.58%)**
- Flag reason counts:
  - `consistency<0.78`: **755**

Consistency score distribution:

- Mean: **0.9077**
- Median: **0.9484**
- P10: **0.7713**
- P90: **1.0000**
- Min/Max: **0.0027 / 1.0000**

## Flag Rate by Language

- `de`: 156 / 977 (**15.97%**)
- `de-CH`: 0 / 1 (**0.00%**)
- `en-GB`: 29 / 899 (**3.23%**)
- `en-GH`: 1 / 1 (**100.00%**) *(tiny sample)*
- `en-US`: 29 / 1120 (**2.59%**)
- `es-AR`: 152 / 1032 (**14.73%**)
- `es-CO`: 139 / 1006 (**13.82%**)
- `fr-CA`: 98 / 975 (**10.05%**)
- `nl`: 132 / 1107 (**11.92%**)
- `pt-BR`: 6 / 7 (**85.71%**) *(tiny sample)*
- `pt-PT`: 13 / 14 (**92.86%**) *(tiny sample)*

## Gemini Judge Report (Flagged Sample)

To add model-level diagnostics quickly, Gemini (`gemini-2.5-pro`) was run on a balanced flagged sample.

- Source flagged pool: **755**
- Sample judged by Gemini: **103**
- Successful judgments: **103**
- Errors: **0**

Normalized Gemini severity on the sample:

- `critical`: **25**
- `major`: **22**
- `minor`: **8**
- `no error`: **48**

Interpretation:

- About **53.4%** of sampled consistency-flagged rows had model-reported issues (`critical|major|minor`).
- About **46.6%** were likely false positives for the consistency threshold (`no error`), suggesting threshold tuning or language-aware thresholds may reduce review noise.
