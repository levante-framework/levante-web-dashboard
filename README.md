# Levante Web Dashboard

Web dashboard application for managing Levante audio content, translations, and partner tools.

## Features

- **Audio Approval Dashboard** – Review and approve audio content
- **Partner Audio Dashboard** – Partner-facing audio management interface
- **Pitwall** – Real-time monitoring and analytics
  - **Audio Validation (ASR)** – Quantitative metrics per language (pass rates, needs review counts)
  - **Audio Validation by Language** – Detailed breakdown table showing validation status by language
- **Locate Me** – GPS-based city discovery with interactive map visualization

## Locate Me Feature

The Locate Me feature (`public/locate-me.html`) allows users to discover their nearest cities using GPS coordinates and displays administrative boundaries on an interactive map.

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
   - Uses offline gzipped packs in `public/adm-packs/**`:
     - **GADM packs** (`adm2.json.gz`, `adm3.json.gz`) - Reliable, well-defined hierarchy
     - **Geofabrik packs** (`adm6-geofabrik.json.gz` through `adm10-geofabrik.json.gz`) - Very granular OSM boundaries
     - **City boundaries** (`city-boundaries-osm.json.gz`) - Actual city/town boundaries from OSM
     - **US Census tracts** (`public/adm-packs/us/adm3-place/**`) - Very granular for US cities
   - Selection logic: Always picks the **smallest** (most granular) boundary available

3. **Weather (privacy-preserving)**
   - Uses Open‑Meteo with a coarse query point (e.g., ADM2 bbox center) and caching.

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
