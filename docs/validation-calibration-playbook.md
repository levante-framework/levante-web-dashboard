# Validation Calibration Playbook

Use this to turn human `Needs Review` decisions into better scoring/routing.

## 1) Tagging Schema (for reviewers)

For each reviewed item, set:

- `human_outcome`: one of `pass`, `review`, `fail`
- `human_reason_tags`: pipe-separated tags from taxonomy below
- `human_notes`: optional free text

Recommended tag taxonomy:

- `regional_variant` - same meaning, wrong regional word choice (e.g., autos/carros)
- `term_consistency` - inconsistent with neighboring/sibling strings
- `register_tone` - too formal/informal or wrong voice for context
- `semantic_shift` - meaning changed materially
- `instruction_mismatch` - action/prompt meaning is off
- `grammar_agreement` - morphology/agreement/tense issue
- `source_changed` - source changed; translation needs refresh
- `image_grounding` - image/task context suggests alternate target
- `format_placeholder` - punctuation/placeholder/format token issue
- `other` - keep only when no tag above fits

## 2) Build Starter Label Set

Generate a seed dataset with all human-flagged positives plus matched controls:

```bash
python3 scripts/build_human_review_seed.py \
  --validation-json data/validation/validation_results.shared.json \
  --translations-csv data/validation/crowdin-xliff-merged.csv \
  --lang-code es-AR \
  --controls-per-positive 1 \
  --output-csv data/validation/human-review-seed-es-AR.csv
```

Output columns include current scores/signals, reason/back-translation, and blank `human_*` fields for annotation.

## 3) Compare Signals vs Human Labels

After reviewers fill the `human_outcome` field (and optional tags), run:

```bash
python3 scripts/compare_validation_signals.py \
  --human-csv data/validation/human-review-seed-es-AR.csv \
  --validation-json data/validation/validation_results.shared.json \
  --embedding-json data/validation/embedding-advisory.json \
  --output-prefix data/validation/validation-signals-compare-es-AR
```

This writes:

- detailed joined rows (`*-details.csv`)
- summary with coverage and threshold suggestions (`*-summary.json`)

## 3b) Weak-Label Baseline (when only needsReview flags exist)

When you have `needsReview=true` positives and assume others are negatives, run:

```bash
python3 scripts/train_weak_needs_review_model.py \
  --validation-json data/validation/validation_results.shared.json \
  --lang-code es-AR \
  --negative-weight 0.35 \
  --output-prefix data/validation/weak-needs-review-es-AR
```

Outputs:

- `*-predictions.csv` - per-item risk score `p_review`
- `*-summary.json` - holdout metrics and a recommended threshold

This is for prioritization / threshold tuning. Keep manual audits in loop because assumed negatives are noisy.

## 3c) Build 3-Tier Operating Policy

Convert weak-model probabilities into operational tiers:

- `auto_review` (highest risk)
- `queue_review` (medium risk)
- `pass` (lower risk)

```bash
python3 scripts/build_review_policy_from_weak_scores.py \
  --predictions-csv data/validation/weak-needs-review-es-AR-predictions.csv \
  --target-auto-pct 0.02 \
  --target-queue-pct 0.12 \
  --output-prefix data/validation/weak-needs-review-es-AR-policy
```

Tune queue size by adjusting:

- `target-auto-pct` for strict top risk escalation
- `target-queue-pct` for total review load

## 4) Decision Rules to Trial

Start conservative:

- Keep existing score thresholds as baseline.
- Add routing override to `Needs Review` when:
  - human-derived risk tags appear frequently for a pattern, or
  - deterministic score is high but disagreement/risk signals are high.

Track:

- false-pass rate (human says review/fail but model passes)
- review queue size
- per-tag precision/recall (especially `regional_variant`, `term_consistency`)

## 5) Weekly Cadence

- Pull latest shared validation results.
- Refresh seed/control dataset.
- Label new batch.
- Re-run comparison script.
- Update thresholds/risk rules only if false-pass drops without queue blow-up.

