# Prolific es-AR Pilot: Findings

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


