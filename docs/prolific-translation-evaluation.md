# Prolific Translation Evaluation Kit

This document provides a production-ready workflow for collecting bilingual human judgments on translation equivalence for child-facing content (age 5-9), then importing those labels into the Levante calibration workflow.

## 1) Study objective

For each string pair (`en-US` source and target translation), collect bilingual ratings on:

- **Meaning equivalence** (primary signal)
- **Child clarity** for age 5-9 (secondary diagnostic)
- Optional issue notes

## 2) Recommended study design

- Raters per item: **3 minimum**, **5 preferred**
- Study language: bilingual (`en-US` + target language)
- Pilot size: `100-200` items per locale
- Include:
  - gold/check items
  - duplicate items for consistency checks
  - minimum completion-time threshold

## 3) Suggested Prolific prompt text

Use this text in your Prolific task:

> By answering the following questions, you are participating in a study being performed by cognitive scientists in the Stanford Department of Psychology. If you have questions about this research, please contact Michael C. Frank at mcfrank@stanford.edu. If you are not satisfied with how this study is being conducted, or if you have any concerns, complaints, or general questions about the research or your rights as a participant, please contact the Stanford Institutional Review Board (IRB) to speak to someone independent of the research team at irbnonmed@stanford.edu. Your participation in this research is voluntary. You may decline to answer any or all of the following questions. You may decline further participation, at any time, without adverse consequences. Your confidentiality is assured; the researchers who have requested your participation will not receive any personal information about you.
>
> You will review pairs of text strings.  
> The first is English (en-US). The second is the translated version in another language.  
>  
> Your job: decide whether the translated text conveys the **same meaning and intended child-facing instruction/content** for children age 5-9.  
>  
> Please answer:
> 1. Meaning equivalence:
>    - same_meaning
>    - mostly_same
>    - different_meaning
>    - cannot_judge
> 2. Child clarity (1-5): how understandable/natural it is for children age 5-9.
> 3. Optional issue notes.

## 4) Export study items for Prolific

Generate study items from merged Crowdin CSV:

```bash
python3 scripts/export_prolific_translation_study.py \
  --translations-csv data/validation/crowdin-xliff-merged.csv \
  --target-col es-AR \
  --sample-size 200 \
  --seed 42 \
  --output-csv data/validation/prolific-study-es-AR.csv
```

### Output schema (Prolific upload / survey import)

- `study_item_id`: stable unique row id for study
- `item_id`: canonical translation key
- `lang_code`: target language code
- `content_type`: dashboard/itembank/survey/general
- `path_prefix`: path grouping for analysis
- `source_en`: English source text
- `translation_target`: target language text
- `instructions`: fixed task instruction text

## 5) Collect and export Prolific responses

Expected response file columns (minimum):

- `study_item_id`
- `item_id`
- `lang_code`
- `equivalence_rating` (`same_meaning|mostly_same|different_meaning|cannot_judge`)
- `child_clarity_rating` (`1..5`)
- `issue_notes` (optional)
- `rater_id` (or anonymized participant id)
- `rater_passed_qc` (`1/0`, optional; defaults to included)

## 6) Import Prolific responses into calibration-friendly labels

```bash
python3 scripts/import_prolific_results.py \
  --responses-csv data/validation/prolific-responses-es-AR.csv \
  --translations-csv data/validation/crowdin-xliff-merged.csv \
  --target-col es-AR \
  --output-prefix data/validation/prolific-es-AR
```

This writes:

- `data/validation/prolific-es-AR-aggregated.csv`
- `data/validation/prolific-es-AR-seed.csv`

## 7) Label mapping used by importer

Importer converts equivalence ratings to `needsReview`:

- `different_meaning` -> needs review
- `mostly_same` -> needs review if majority vote marks risk (configurable threshold)
- `same_meaning` -> no review
- `cannot_judge` -> ignored unless it dominates and confidence is low

Default decision rule:

- `prolific_needs_review = 1` when:
  - `different_meaning_votes / valid_votes >= 0.34`, **or**
  - `mostly_same + different_meaning` majority indicates concern.

The generated `*-seed.csv` includes:

- `cohort` (`positive_needs_review` or `control_non_review`)
- `item_id`, `lang_code`, `path_prefix`
- `needs_review_flag`
- `human_outcome`, `human_reason_tags`, `human_notes`
- `source_en`, `translation_current`
- agreement diagnostics (`votes_*`, `agreement_rate`, `avg_child_clarity`)

## 8) Next calibration step

Use the `*-seed.csv` as input to your existing training and policy scripts alongside current human-labeled seeds.

