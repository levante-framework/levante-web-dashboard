# Prolific Pilot Setup (es-AR)

This is a concrete pilot configuration for `es-AR` based on the agreed plan.

## Target configuration

- Items: `180`
- Ratings per item: `3`
- Total judgments: `540`
- Suggested participant workload:
  - Option A: `~30 judgments` each (more participants, shorter task)
  - Option B: `~50-60 judgments` each (fewer participants, longer task)

## Expected cost ranges

Cost depends on participant count and pay per participant.

- If `18` participants x `$2.50-$3.00`: `$45-$54` before platform fees
- If `10` participants x `$4.50-$5.50`: `$45-$55` before platform fees

Add Prolific overhead/fees on top (check your account's current fee settings).

## 1) Generate pilot item set

```bash
npm run validation:prolific:export:pilot-es-ar
```

This writes:
- `data/validation/prolific-study-es-AR-pilot.csv`

## 2) Prolific study text (copy/paste)

### Study title

**Bilingual review (English + Spanish): judge translation meaning for child-facing text**

### Description

By answering the following questions, you are participating in a study being performed by cognitive scientists in the Stanford Department of Psychology. If you have questions about this research, please contact Michael C. Frank at mcfrank@stanford.edu. If you are not satisfied with how this study is being conducted, or if you have any concerns, complaints, or general questions about the research or your rights as a participant, please contact the Stanford Institutional Review Board (IRB) to speak to someone independent of the research team at irbnonmed@stanford.edu. Your participation in this research is voluntary. You may decline to answer any or all of the following questions. You may decline further participation, at any time, without adverse consequences. Your confidentiality is assured; the researchers who have requested your participation will not receive any personal information about you.

You will see short text pairs:
1) Original English (en-US) text
2) Spanish translation (es-AR)

Your task is to judge whether the translation preserves the same meaning and intended child-facing content for children age 5-9.

### External study URL

Use this as the Prolific external study URL:

`https://levante-pitwall.vercel.app/validation/prolific/es-ar-pilot`

Enable Prolific URL parameters so participants arrive with:
- `PROLIFIC_PID`
- `STUDY_ID`
- `SESSION_ID`

The participant page requires all three IDs and will block submission if any are missing.

### Eligibility

- Fluent in English and Spanish
- Comfortable evaluating child-facing educational language

### Per-item questions

1. **Meaning equivalence**
   - `same_meaning`
   - `mostly_same`
   - `different_meaning`
   - `cannot_judge`

2. **Child clarity (1-5)**
   - 1 = very unclear for age 5-9
   - 5 = very clear for age 5-9

3. **Issue notes** (optional)

### Quality checks

- Include check items with obvious expected judgments.
- Include a small number of repeated items to measure consistency.
- Exclude submissions failing quality checks.

## 3) Response format

Use:
- `data/validation/prolific-responses-es-AR-template.csv`

### Live response collection / export

Pilot responses are collected by:
- `POST /api/prolific-es-ar-pilot?mode=submit`

Live monitoring:
- `https://levante-pitwall.vercel.app/validation/prolific/es-ar-pilot-results`

CSV export endpoint (import-ready columns):
- `https://levante-pitwall.vercel.app/api/prolific-es-ar-pilot?mode=export_csv`

Save downloaded CSV to:
- `data/validation/prolific-responses-es-AR.csv`

Populate it with your collected responses and then run:

```bash
npm run validation:prolific:import:pilot-es-ar -- \
  --responses-csv data/validation/prolific-responses-es-AR.csv
```

Outputs:
- `data/validation/prolific-es-AR-pilot-aggregated.csv`
- `data/validation/prolific-es-AR-pilot-seed.csv`

## 4) Next step after pilot

Use `...-seed.csv` as additional human labels in your calibration workflow and compare model overlap before expanding to larger sample sizes.
