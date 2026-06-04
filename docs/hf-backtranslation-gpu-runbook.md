# HF Back-Translation GPU Runbook

This runbook documents how to run the Hugging Face back-translation workflow on a larger GPU machine and compare it against the current Google baseline.

## Quickstart (Fresh GPU Machine)

From repo root, run:

```bash
npm install
python3 -m venv .venv-emb
source .venv-emb/bin/activate
pip install --upgrade pip
pip install transformers torch accelerate sentencepiece protobuf sentence-transformers numpy

node scripts/export-crowdin-xliff-merged.js \
  --approved-only \
  --output-all data/validation/crowdin-xliff-merged.csv \
  --output-surveys data/validation/crowdin-xliff-surveys.csv \
  --output-itembank data/validation/crowdin-xliff-itembank.csv \
  --output-dashboard data/validation/crowdin-xliff-dashboard.csv

npm run validation:backtranslate:hf

npm run validation:backtranslate:benchmark -- \
  --translations-csv data/validation/crowdin-xliff-merged.csv \
  --labels-csv data/validation/human-review-seed-es-AR.csv \
  --target-col es-AR \
  --providers google,hf \
  --k-values 43,86,129
```

Primary output summary:
- `data/validation/backtranslation-provider-benchmark-es-AR-summary.json`

## Scope

This covers:
- Crowdin export prep for validation QA datasets
- Hugging Face NLLB back-translation smoke tests
- Google vs HF benchmark runs against human labels
- Output files and interpretation
- Optional runtime toggle wiring (kept off by default)

## Relevant Scripts

- `scripts/hf_backtranslation.py`
- `scripts/hf_lang_map.json`
- `scripts/benchmark_backtranslation_providers.py`
- `scripts/export-crowdin-xliff-merged.js`

Runtime integration:
- `api/back-translate.js` (provider wrapper)
- `public/js/validation.js` (provider selection)
- `public/config.js` (`validationBacktranslationProvider`, default `google`)

## 1) Machine Prerequisites

- NVIDIA GPU with current CUDA drivers
- Python 3.10+ and Node.js 18+
- Enough disk for model cache (`facebook/nllb-200-distilled-600M` ~1.2GB+ plus tokenizer/cache overhead)

## 2) One-Time Environment Setup

From repo root:

```bash
npm install
python3 -m venv .venv-emb
source .venv-emb/bin/activate
pip install --upgrade pip
pip install transformers torch accelerate sentencepiece protobuf sentence-transformers numpy
```

Optional: verify GPU is visible to torch

```bash
python3 - <<'PY'
import torch
print("cuda_available:", torch.cuda.is_available())
print("cuda_device_count:", torch.cuda.device_count())
if torch.cuda.is_available():
    print("device_name:", torch.cuda.get_device_name(0))
PY
```

## 3) Prepare Crowdin QA Inputs

Generate merged CSVs used by the benchmark and calibration scripts:

```bash
node scripts/export-crowdin-xliff-merged.js \
  --approved-only \
  --output-all data/validation/crowdin-xliff-merged.csv \
  --output-surveys data/validation/crowdin-xliff-surveys.csv \
  --output-itembank data/validation/crowdin-xliff-itembank.csv \
  --output-dashboard data/validation/crowdin-xliff-dashboard.csv
```

Expected human-label input (already in repo workflow):
- `data/validation/human-review-seed-es-AR.csv`

## 4) Quick HF Smoke Test

Round-trip smoke test via npm script:

```bash
npm run validation:backtranslate:hf
```

Direct one-way test (target locale -> English):

```bash
source .venv-emb/bin/activate
python3 scripts/hf_backtranslation.py \
  --mode to-english \
  --source-locale es-AR \
  --text "¿Te gusta el colegio?" \
  --json
```

## 5) Run Google vs HF Benchmark

Default benchmark command:

```bash
npm run validation:backtranslate:benchmark -- \
  --translations-csv data/validation/crowdin-xliff-merged.csv \
  --labels-csv data/validation/human-review-seed-es-AR.csv \
  --target-col es-AR \
  --providers google,hf \
  --k-values 43,86,129
```

Important defaults:
- Google baseline endpoint: `https://levante-cockpit.vercel.app/api/google-translate`
- Semantic scorer endpoint: `https://levante-cockpit.vercel.app/api/translation-semantic-score`

If you need a bearer key for Google endpoint auth:

```bash
npm run validation:backtranslate:benchmark -- \
  --google-api-key "<YOUR_KEY>"
```

## 6) Benchmark Outputs

With default output prefix (`data/validation/backtranslation-provider-benchmark-es-AR`), results are:

- `...-details.csv`: per-row provider results
- `...-topk.csv`: top-K overlap/precision/recall by provider
- `...-summary.csv`: aggregate provider stats
- `...-disagreements.csv`: row-level score/status disagreements
- `...-summary.json`: machine-readable summary with key metrics

## 7) Decision Guidance

Use the benchmark to decide whether HF is a meaningful improvement:

- Prefer HF only if it consistently improves overlap/recall on labeled `Needs Review` rows.
- If results are mixed, keep Google as production default and use HF for offline QA only.
- Promote runtime HF usage only after staging validation with representative languages and volumes.

## 8) Optional Runtime Toggle (Default Remains Google)

Current default is Google. To enable HF runtime path in an environment:

```bash
export HF_BACKTRANSLATE_RUNTIME_ENABLED=true
export HF_PYTHON_BIN=.venv-emb/bin/python
export HF_BACKTRANSLATE_TIMEOUT_MS=180000
```

Then set client-side provider choice (default in config is still `google`):
- `public/config.js` -> `validationBacktranslationProvider: 'google' | 'hf'`
- Optional local override key in browser storage: `validationBacktranslationProvider`

## 9) GPU Performance Notes

- First run is slower due to model download and warmup.
- Keep process warm for repeated benchmarks to avoid reload overhead.
- If VRAM is constrained, reduce concurrency externally and avoid running multiple heavy scripts simultaneously.
- HF cache location defaults to `~/.cache/huggingface`.

## 10) Troubleshooting

- **OOM / CUDA errors**: rerun with fewer parallel jobs on the machine; script includes conservative fallback logic.
- **No benchmark overlap**: verify `--target-col` matches label file locale and that item IDs overlap between labels and merged CSV.
- **Google auth errors**: provide `GOOGLE_TRANSLATE_APIKEY` or bearer token as required by endpoint.
- **HF runtime disabled**: set `HF_BACKTRANSLATE_RUNTIME_ENABLED=true` before using `provider=hf` through runtime API.
