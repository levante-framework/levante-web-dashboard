# Levante Web Dashboard

Web dashboard application for managing Levante audio content, translations, and partner tools.

## Features

- **Audio Approval Dashboard** – Review and approve audio content
- **Partner Audio Dashboard** – Partner-facing audio management interface
- **Pitwall** – Real-time monitoring and analytics
  - **Audio Validation (ASR)** – Quantitative metrics per language (pass rates, needs review counts)
  - **Audio Validation by Language** – Detailed breakdown table showing validation status by language
  - **Asset Audit** – Compare files between `levante-assets-dev` and `levante-assets-prod` GCS buckets
    - Interactive folder tree view with expand/collapse
    - Three-column comparison: Files Only in Dev, Files Newer in Dev, Files Newer in Prod
    - Checksum comparison option (MD5/CRC32C) - ignores file dates when enabled
    - Text filtering and exclude patterns
    - Automatically filters out 0-byte files and empty folders
  - **Firestore Audit Dashboard** – View restricted audit/diff snapshots sourced from private GCS via `/api/audit-dashboard-data`
- **Locate Me** – Dual-path location discovery:
  - `Locate Me (GPS)` for browser geolocation flow
  - `Locate Me (Choose)` for country-first manual lookup (locality/postal autocomplete without GPS consent)

## Locate Me Feature

The Locate Me feature (`public/locate-me.html`) allows users to discover their nearest cities using GPS coordinates and displays administrative boundaries on an interactive map.

It now supports a privacy-first manual mode that does not require browser geolocation permission:
- Select country first
- Type locality or postal prefix
- Pick an autocomplete match
- Resolve boundaries/weather from that selected place

**Documentation:**
- **Implementation details**: `docs/locate-me/README.md`
- **Location strategies history**: `docs/location-strategies.md` (summary of strategies tried vs. currently in use)

## Gallery Feature

The Locate Me Gallery (`public/gallery/locate-me/`) displays administrative boundaries for seed GPS points across multiple countries.

**Current Status:**
- ✅ **ADM2/ADM3 boundaries** work for all countries (GADM)
- ✅ **ADM6/7/8/9/10 boundaries** available for many countries (OSM Geofabrik) - very granular!
- ✅ **City boundaries** available from OSM (boundary=administrative + place=city/town)
- ✅ **US Census tracts** - very granular boundaries for US cities
- ✅ **Selection logic** - Always picks the smallest (most granular) boundary available

**Boundary Hierarchy (most granular first):**
1. **ADM10** - Very small administrative units (electoral districts, neighborhoods) - e.g., 0.65 km² for Toronto
2. **ADM9** - Small administrative units (electoral districts) - e.g., 24.50 km² for Toronto
3. **ADM8** - Wards/districts - e.g., 120.57 km² for Toronto
4. **City boundaries** - Actual city/town boundaries from OSM
5. **ADM3** - Districts/municipalities (GADM) - reliable fallback
6. **ADM2** - Regional boundaries (counties, provinces)

**Documentation:**
- **Full status and history**: `docs/gallery-adm4-adm5-status.md`
- **osmium-tool installation**: `docs/install-osmium-tool.md`
- **Gallery README**: `public/gallery/locate-me/README.md`

**To Rebuild Boundary Packs:**
1. Install osmium-tool (recommended for faster processing): `sudo apt-get install -y osmium-tool`
2. Build Geofabrik packs: `node scripts/adm/build-geofabrik-packs.js ca,nl,de,us,gb,co,ch,ar`
   - Extracts admin_level 4-10 boundaries from Geofabrik PBF files
   - Uses osmium-tool if available, falls back to Overpass API
3. Build city boundaries: `node scripts/adm/build-city-boundaries.js ca,nl,de,us,gb`
   - Queries OSM for boundary=administrative + place=city/town relations
4. Regenerate gallery: `USE_GEOBOUNDARIES=false node scripts/generate-locate-me-gallery.js`
5. Generate images: `node scripts/generate-gallery-images.js`
6. Deploy: `npm run deploy`

### How It Works

1. **On-device reverse geocoding**
   - Uses a compact GeoNames-derived dataset (`data/geocoder/cities.min.json.gz`) loaded in the browser.

2. **On-device admin boundary lookup**
   - Uses boundary packs loaded from GCS (`levante-assets-draft/maps/boundaries/`) via `/api/adm-pack`:
     - **GADM packs** (`adm2.json.gz`, `adm3.json.gz`) - Reliable, well-defined hierarchy (also available locally)
     - **Geofabrik packs** (`adm6-geofabrik.json.gz` through `adm10-geofabrik.json.gz`) - Very granular OSM boundaries (stored in GCS)
     - **City boundaries** (`city-boundaries-osm.json.gz`) - Actual city/town boundaries from OSM
     - **US Census tracts** (`us/adm3-place/**` and `us/adm6-10/**`) - Very granular for US cities (stored in GCS)
   - Selection logic: Always picks the **smallest** (most granular) boundary available
   - Note: Geofabrik packs are stored in GCS to avoid large files in git (2.36 GB saved)

3. **Weather (privacy-preserving)**
   - Uses Open‑Meteo with a coarse query point (e.g., ADM2 bbox center) and caching.

4. **Manual country-first autocomplete (privacy-first path)**
   - Uses prebuilt per-country geocoder bundles in `public/geocoder-index/`:
     - `CC.lite.json.gz` (small, fast warm load)
     - `CC.full.json.gz` (loaded only when lite results are sparse or query is more demanding)
   - Tracks downloaded bytes per session and surfaces this in the UI (`Session data`).
   - Shows an explicit loading indicator after country selection while warming country autocomplete data.

### Autocomplete Index Behavior (Lite vs Full)

- On country selection, the app warms the country `lite` index so first keystrokes are responsive.
- The app upgrades to `full` only when needed (for example: substantial query length, postal-like input, or too-few lite matches).
- Country bundles vary significantly by dataset size:
  - Example: Argentina `lite` is ~100 KB; Argentina `full` is ~0.8 MB.
  - Example: India `lite` is ~90 KB; India `full` is ~5.0 MB.
- Metadata and exact file sizes are recorded in `public/geocoder-index/meta.json`.

### Supported Countries

Currently supports 10 countries: US, CA, CO, IN, AR, NL, GH, CH, DE, GB

### Documentation

Full documentation is available at `/docs/locate-me-doc.html` or via the Documentation button on the Locate Me page.

## Project Structure

- `public/` – HTML pages, JavaScript, CSS, and static assets
- `api/` – Vercel serverless functions
  - `reverse-geocode.js` – Reverse geocoding API
  - `gadm-polygon.js` – Administrative boundary polygon API
  - `visual-audit.js` – Visual assets audit
  - `asset-audit.js` – Asset comparison API (compares files between dev and prod GCS buckets)
  - `adm-pack.js` – Loads administrative boundary packs from GCS
  - `crowdin-*.js` – Crowdin integration APIs
  - `audio-validation-summary.js` – Stores/loads aggregated audio validation summaries (GCS-backed)
  - `list-validation-files.js` – Lists available validation result files (GCS-backed)
  - `get-validation-file.js` – Retrieves a specific validation result file (GCS-backed)
- `scripts/` – Build and deployment scripts
  - `apply-version.js` – Updates version numbers before deployment
  - `deploy-and-alias.js` – Orchestrates deployment and domain aliasing
  - `verify-deploy.js` – Verifies deployment across aliases
  - `generate-audio-validation.sh` – Generates audio validation JSONs and imports them
  - `import-audio-validation-files.sh` – Copies validation files from `levante_translations` repo
  - `upload-audio-validation-files.js` – Uploads local validation files to GCS
  - `compare-audio-file-versions.js` – Compares local audio files vs GCS buckets (timestamps, ID3 tags)
- `data/` – Data files (geocoder city data, etc.)
  - `validation/` – Local validation result JSONs (gitignored, uploaded to GCS for deployment)
- `config/` – Configuration files

## Deployment

### Prerequisites

- Node.js 18+
- npm
- Vercel CLI (for manual deployments)

### Deploy Script

The project includes an automated deployment script:

```bash
npm run deploy
```

This script:
1. Runs `scripts/apply-version.js` to update version numbers
2. Deploys to Vercel production
3. Sets up domain aliases
4. Verifies deployment across all aliases

### Manual Deployment

```bash
npx vercel --prod
```

## Development

### Local Development

```bash
npm install
npm run dev  # If available, or use Vercel CLI: vercel dev
```

### Environment Variables

Use `.env.local` for local development and Vercel Project Settings for deployed environments.
See `.env.example` for a safe template.

Required/optional keys used by current translation and AI features:

- `CROWDIN_API_TOKEN` – Crowdin API token for translation export endpoints
- `LEVANTE_TRANSLATIONS_PROJECT_ID` – optional Crowdin project ID (defaults to `756721`)
- `OPENAI_API_KEY` – enables AI-assisted translation judging
- `OPENAI_MODEL` – optional OpenAI model override (defaults to `gpt-4.1`)
- `GCP_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS_JSON` – JSON credentials for private GCS-backed APIs
- `AUDIT_DASHBOARD_BUCKET` – optional bucket override for the audit dashboard API (defaults to `levante-tools`)
- `AUDIT_DASHBOARD_OBJECT` – optional object path override (defaults to `pitwall/audit-mini-dashboard/dashboard-data.json`)
- `AUDIT_DASHBOARD_DOWNLOAD_PREFIX` – optional prefix for JSON download listing (defaults to `pitwall/audit-mini-dashboard/`)
- `AUDIT_DASHBOARD_REQUIRE_AUTH` – optional auth toggle (`true` by default)
- `AUDIT_DASHBOARD_ALLOWED_ORGS` – comma-separated GitHub org allowlist for audit data access (defaults to `levante-framework`)

### Version Management

Version numbers are automatically updated before deployment via `scripts/apply-version.js`. The script:
- Reads version from `package.json`
- Updates version in HTML files (`public/locate-me.html`, `public/locate.html`)
- Adds cache-busting query strings to asset URLs

## Dependencies

Key dependencies:
- `@turf/*` – Geospatial calculations (boolean-point-in-polygon, area, distance, centroid)
- `osmtogeojson` – Converts OpenStreetMap data to GeoJSON
- `@google-cloud/storage` – Google Cloud Storage integration
- `sharp` – Image processing

## API Endpoints

### `/api/reverse-geocode`
Finds nearest cities based on GPS coordinates.

**Parameters:**
- `lat` (required) – Latitude
- `lon` (required) – Longitude
- `limit` (optional) – Number of results (1-10, default: 3)
- `maxDistanceKm` (optional) – Maximum search radius in km (default: 50)

**Example:**
```bash
curl "https://levante-audio-dashboard.vercel.app/api/reverse-geocode?lat=37.424&lon=-122.166&limit=3"
```

### `/api/gadm-polygon`
Retrieves administrative boundary polygons.

**Parameters:**
- `country` (required) – Country code (must be in supported list)
- `lat` (required) – Latitude
- `lon` (required) – Longitude

**Example:**
```bash
curl "https://levante-audio-dashboard.vercel.app/api/gadm-polygon?country=USA&lat=37.424&lon=-122.166"
```

### `/api/asset-audit`
Compares files between `levante-assets-dev` and `levante-assets-prod` GCS buckets.

**Parameters:**
- `prefix` (optional) – Folder prefix filter (e.g., `audio/`, `visual/`)
- `exclude` (optional) – Comma-separated exclude patterns (e.g., `pt-PT,downex`)
- `checksum` (optional) – Use checksum comparison (`true`/`1` to enable)

**Response:**
- `onlyInDev` – Files that only exist in dev bucket
- `newerInDev` – Files newer in dev than prod (date comparison)
- `newerInProd` – Files newer in prod than dev (date comparison)
- `onlyInProd` – Files that only exist in prod bucket
- `summary` – Counts for each category and identical files

**Note:** When `checksum=true`, file dates are ignored and only checksums (MD5/CRC32C) are used to determine if files are identical. 0-byte files and empty folders are automatically excluded.

**Example:**
```bash
curl "https://levante-pitwall.vercel.app/api/asset-audit?prefix=audio/&exclude=pt-PT&checksum=false"
```

### `/api/audit-dashboard-data`
Loads private Firestore audit dashboard JSON from GCS for the Pitwall page `public/audit-dashboard.html`.

**Auth behavior (default):**
- Requires valid GitHub session cookie (`levante_auth_session`)
- Requires membership in one of the orgs from `AUDIT_DASHBOARD_ALLOWED_ORGS`

**Configuration:**
- `AUDIT_DASHBOARD_BUCKET` (default `levante-tools`)
- `AUDIT_DASHBOARD_OBJECT` (default `pitwall/audit-mini-dashboard/dashboard-data.json`)
- `AUDIT_DASHBOARD_DOWNLOAD_PREFIX` (default `pitwall/audit-mini-dashboard/`)
- `AUDIT_DASHBOARD_REQUIRE_AUTH` (default `true`)
- `AUDIT_DASHBOARD_ALLOWED_ORGS` (default `levante-framework`)

**Example:**
```bash
curl "https://levante-pitwall.vercel.app/api/audit-dashboard-data"
```

### `/api/audit-dashboard-files`
Lists/downloads JSON report files for the audit dashboard download menu (OAuth + org gated, same as `/api/audit-dashboard-data`).

**Query params:**
- `action=list` – list JSON files under `AUDIT_DASHBOARD_DOWNLOAD_PREFIX`
- `action=download&path=<object-path>` – download one JSON object

**Examples:**
```bash
curl "https://levante-pitwall.vercel.app/api/audit-dashboard-files?action=list"
curl "https://levante-pitwall.vercel.app/api/audit-dashboard-files?action=download&path=pitwall/audit-mini-dashboard/dashboard-data.json"
```

### `/api/adm-pack`
Loads administrative boundary packs from GCS bucket (`levante-assets-draft/maps/boundaries/`).

**Parameters:**
- `country` (required) – Country code (e.g., `ca`, `us`, `nl`)
- `file` (required) – Pack filename (e.g., `adm6-geofabrik.json.gz`, `adm3/ca.json.gz`)

**Example:**
```bash
curl "https://levante-pitwall.vercel.app/api/adm-pack?country=ca&file=adm6-geofabrik.json.gz"
```

## Audio Validation

The Pitwall dashboard includes comprehensive audio validation reporting:

### Pitwall Integration

- **Status Pill**: Shows overall pass rate and needs review count
- **By-Language Table**: Displays validation metrics per language (pass %, needs review count, average similarity)
- **Data Source**: Validation summaries are stored in GCS (`levante-dashboard-dev/pitwall/audio-validation-summary/`) and automatically published when loading validation files

### Workflow

1. **Generate Validation**: Run validation in `../levante_translations`:
   ```bash
   ./scripts/generate-audio-validation.sh <language-code>
   ```

2. **Upload to GCS** (for deployed Pitwall):
   ```bash
   export UPLOAD_TO_GCS=1
   ./scripts/generate-audio-validation.sh <language-code>
   # Or manually:
   node scripts/upload-audio-validation-files.js
   ```

3. **View in Pitwall**: Open the deployed Pitwall → Audio Validation section shows the latest summary

See `README_VALIDATION.md` for detailed validation system documentation.

## Recent Improvements

For a chronological log of January 2026 dashboard updates, see `docs/dashboard-updates-2026-01.md`.

### Translation + Partner Audio Workstream (Jan 2026)
- **Crowdin cache-first loading**: Dashboard now prefers cached Crowdin exports and only refreshes from Crowdin on explicit **Update Translations**.
- **Crowdin export behavior**: Export endpoint uses approved-only translations; build conflicts are handled by reusing in-progress builds.
- **Crowdin data parsing**:
  - Merges CSV + XLIFF sources, including `main/dashboard/*.csv`.
  - Preserves source-path metadata for file-aware filtering and diagnostics.
  - Adds backward compatibility when older cached rows only have composite IDs.
- **Performance + UX**:
  - Progressive row rendering with render deduplication/cancellation.
  - Validation summary shows spinner + `Rendering...` during table build.
  - Added explicit performance logs for cache/read/render stages.
- **Per-language file filtering**:
  - File dropdown now scopes to files relevant to the selected language.
  - Added English/German locale alias compatibility (`en`/`en-US`, `de`/`de-DE`) to avoid missing-file filters during migration.
- **Validation robustness**:
  - Validation strips HTML tags before scoring/back-translation.
  - Validation modal includes note that HTML is normalized.
  - Modal now backfills sparse historical records and can auto-generate missing back-translation on demand.
  - Compact validation snapshots now retain `backTranslation`.
- **Language-code migration compatibility**:
  - Added alias-safe handling for validation keys and audio paths (`en`<->`en-US`, `de`<->`de-DE`).
  - Prevents loss of existing validation history and reduces audio lookup misses after locale-code changes.
- **Partner Audio Approval Tool**:
  - Added **Approve All Audio (Language)** action in pending tab.
  - Added timestamp-based approval classification: item is approved only when dev copy is newest vs draft (prevents passive status flips when draft is newer).
  - Strengthened cache invalidation + UI consistency after approve/unapprove/move flows.

### Asset Audit (January 2025)
- **New Feature**: Interactive asset comparison tool comparing files between `levante-assets-dev` and `levante-assets-prod` GCS buckets
- Three-column view: Files Only in Dev, Files Newer in Dev, Files Newer in Prod
- Checksum comparison option (MD5/CRC32C) - when enabled, ignores file dates and only uses checksums
- Folder tree view with expand/collapse functionality
- Text filtering and exclude patterns support
- Automatically filters out 0-byte files and empty folders
- Accessible via Pitwall → "Audit Asset Files" button

### Boundary Pack Storage (January 2025)
- Moved geofabrik boundary packs (ADM6-10) to GCS bucket (`levante-assets-draft/maps/boundaries/`)
- Removed large geofabrik files from git tracking (2.36 GB freed)
- Added `/api/adm-pack` endpoint to load boundary packs from GCS
- Updated frontend to load geofabrik files from GCS instead of local filesystem
- US ADM6-10 state-specific packs also stored in GCS

### Audio Validation
- Added Pitwall component with quantitative metrics (pass rates, needs review counts per language)
- GCS-backed storage for validation files and summaries (deployed environment)
- Automatic summary publishing when loading validation files

### Reverse Geocoding
- Fixed algorithm to scan all candidates within range (not just first N)
- Improved accuracy by removing early termination bug
- Added administrative region prioritization

### Polygon Lookup
- Switched from GADM to OpenStreetMap/Overpass for more granular boundaries
- Added nearby city fallback when only county boundaries are available
- Improved boundary selection (prefers cities/towns over counties)

## License

MIT
