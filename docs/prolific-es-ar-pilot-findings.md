# Prolific es-AR Pilot: Findings

## Summary

We ran two connected Prolific studies for es-AR. The initial sampled pilot (180-item pool, with uneven coverage) confirmed that crowdsourced bilingual ratings are useful for triage, but item-level confidence was limited by inconsistent votes per item. The follow-up full-set study (63 items = 43 flagged by Amy as Need Review + 20 controls) resulted in 5 approved complete responses. For that limited dataset the result was a cleaner signal. Controls behaved as expected (high agreement/high clarity), flagged items surfaced a focused set of true risk candidates, and clarity responses showed moderate, directionally correct alignment with human quality scores on overlapping items. Overall, the results are very promising. We could keep Prolific as a targeted calibration and prioritization layer (e.g. triage or as a contributing score), but would continue using expert review for final adjudication on the highest-risk items.

Cost is one factor. Items take about 20 seconds each (although maybe they'd be a little faster with a thumbs up / thumbs down). So doing this for all items would add up. But if we triage first, and use this as a second layer of triage it might not be too bad.

TL;DR: Nothing worth stopping the world for, but especially as we get to languages that none of us speak or understand, could be increasingly helpful.

Below are the more-detailes study results and lessons learned:

## Initial (Sampled) Study
Date: 2026-03-16
Study: `Translation Evaluation (es-AR pilot)`  
Scope: 180 items, target 3 ratings/item, Prolific external study

## Executive Summary

- The pilot completed and produced strong usable signal for translation quality triage.
- Data quality is acceptable for analysis: no hard QC fails in final submissions.
- Most items were judged as meaning-preserving and clear for child-facing use.
- Prolific human signal adds value by filtering AI over-flagging and identifying concrete risk hotspots.

## Data Collected

- Submissions: `18`
- Unique raters: `18`
- Total ratings: `540`
- QC status:
  - `pass`: 13
  - `review`: 5 (telemetry-related warnings)
  - `fail`: 0
- Median time-on-task: `1211s` (~20.2 minutes)

## Quality of Translation Outcomes

- Equivalence distribution (all ratings):
  - `same_meaning`: 380
  - `mostly_same`: 116
  - `different_meaning`: 38
  - `cannot_judge`: 6
- Item-level averages:
  - Mean pass-like rate (`same` + `mostly`): `0.901`
  - Mean `different_meaning` ratio: `0.091`
  - Mean child clarity: `4.092/5`

Interpretation: Most content appears acceptable; a non-trivial minority needs review.

## Coverage Caveat (Important)

Item vote counts are uneven:

- 60 items with 1 vote
- 60 items with 3 votes
- 30 items with 4 votes
- 30 items with 6 votes

This means confidence is stronger for items with 3+ votes and weaker for single-vote items. NB: We need to fix this for future studies so we get the same number of votes for each item.

## Comparison to Existing Signals

### Against current AI-generated review signal

- AI weak-review predictions are high-recall but over-sensitive on this pilot subset.
- Prolific signal is more selective and better suited as a precision layer.
- Practical implication: combine signals rather than using AI-only thresholds.

### Against existing human expert seed

- Current overlap poorly measured. See follow-up study notes at the end of this document.
- Prolific flags are conservative relative to expert flags on overlap.
- Practical implication: use Prolific primarily to prioritize queue ordering and support expert review.

## High-Priority Review Pattern Types Observed

- Items with high `different_ratio` and high `concern_ratio`
- Items with lower child clarity (especially <3 average)
- Repeated concern areas in stories, hostile-attribution, and selected vocabulary/survey terms

## Recommended Next Steps

1. Review top-risk items first from:
   - `data/validation/prolific-es-AR-pilot-aggregated.csv`
   - `data/validation/prolific-ai-ensemble-es-AR.csv`
2. Tune AI thresholds using this pilot as calibration evidence (reduce false positives).
3. For future pilots, enforce balanced assignment so every item gets exactly 3 ratings.
4. Expand overlap with expert-reviewed items to quantify precision/recall more reliably.

## AI-Assisted Completion Risk Check

Question addressed: Could participants have used AI to complete the survey?

- This dataset cannot prove or disprove AI assistance with certainty.
- We ran behavioral heuristics across all 18 raters:
  - completion timing and items-per-minute
  - response straight-lining checks (equivalence and clarity distributions)
  - interaction telemetry (when available)
  - note text presence and basic pattern checks
- Result: no high-risk behavior clusters were detected; all raters were low-risk under these checks.
- The 5 QC `review` submissions were telemetry-related warnings (missing/zero telemetry), not clear content-pattern anomalies.

Interpretation: AI assistance is always possible in principle, but we found no strong evidence of systematic AI-assisted or fraudulent completion in this pilot.

## Potential Cost-Effective Use Case

Use Prolific as a value-added calibration source, not as the primary scorer for every string.

### Strategy

1. Keep automated + expert workflow as primary coverage.
2. Use Prolific only for high-value subsets:
   - AI-uncertain items
   - high-impact UI strings
   - disagreement cases
   - periodic anchor/audit items
3. Run two-stage sampling per language:
   - Stage A: broad, cheap scan (mostly 1 rating/item)
   - Stage B: add ratings only where uncertainty remains

### Cost Planning Per Language

Estimated ranges based on this pilot's effective economics:

- Lean signal: `$40-$70` per language
  - ~80-120 items, mostly 1-2 ratings/item, targeted follow-up
- Standard signal: `$70-$120` per language
  - ~120-180 items, about 2 ratings/item average
- Robust validation: `$110-$170` per language
  - ~180 items, 3 ratings/item equivalent

Operational rule of thumb: total cost scales approximately with total ratings, so reducing full-coverage multi-rater collection is the largest lever.

## Follow-up Study for Correlation with Human expert

### What We Did

- Switched from sampled assignment to a full-set targeted run using:
  - `data/validation/prolific-study-es-AR-targeted-43-plus-20-controls.csv`
  - 43 flagged items + 20 controls (63 total), all shown to every participant
- Removed the optional notes field to reduce completion burden.
- Collected and approved 5 complete Prolific submissions for the new study (`study_id: 69b84bd4b2990f91cd4226a8`).
- Verified all 5 submissions passed QC with complete `63/63` responses and plausible timing/interaction profiles.

### What We Learned

- The follow-up run produced cleaner, more-usable signal:
  - controls behaved as expected (`~97%` same-meaning, high clarity)
  - flagged items showed meaningful concern (`mostly/different` rates much higher than controls)
- Overlap with human-reviewed flagged items: `43` items.
- Correlation with human `final_score` is directionally correct and moderate:
  - vs Prolific concern ratio: Pearson `-0.304`, Spearman `-0.272`
  - vs Prolific different ratio: Spearman `-0.319`
  - vs Prolific clarity: Spearman `+0.317`
  - vs blended Prolific quality score: Pearson `+0.334`, Spearman `+0.322`
- Practical interpretation: higher Prolific concern tends to align with lower human quality scores, and higher Prolific clarity/equivalence aligns with higher human scores.

### What We Could Do Next

1. Use Prolific as a calibration/triage layer, not a sole decision source.
2. Introduce a blended queue score for review ordering (example):  
   `blend = 0.7 * equivalence_score + 0.3 * clarity_normalized`.
3. For stronger classification metrics (AUC/F1), compare against a mixed human set containing both pass and review labels (not only pre-flagged items).
5. Keep future follow-ups in full-set mode for stable per-item vote counts and cleaner item-level comparisons.

