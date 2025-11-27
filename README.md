# GADM Processing Scripts

Automated pipeline for downloading, processing, and uploading GADM shapefiles for 10 countries.

## Location
`~/levante/levante-web-dashboard/scripts/gadm-processing/`

## Quick Start
1. Run `bash scripts/gadm-processing/setup.sh` to generate the helper scripts.
2. Execute `bash scripts/gadm-processing/run_all.sh` to download shapefiles, extract the highest available level, build normalized snippets, generate the config, and optionally upload to GCS.
3. Update `config/gadm-bucket-files.json` so each country points at `maps/gadm/<CODE>/levelN/gadm41_<CODE>_<N>.zip` (and `snippets/gadm_<CODE>_snippets.json` if you uploaded snippets) before deploying.

For debugging look at the generated log files in `scripts/gadm-processing` and rerun any individual step (download/process/build/upload) as needed.
