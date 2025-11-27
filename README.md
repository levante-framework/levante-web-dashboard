# Levante Web Dashboard

Web dashboard application for managing Levante audio content, translations, and partner tools.

## Features

- **Audio Approval Dashboard** – Review and approve audio content
- **Partner Audio Dashboard** – Partner-facing audio management interface
- **Pitwall** – Real-time monitoring and analytics
- **Locate Me** – GPS-based city discovery with interactive map visualization

## Locate Me Feature

The Locate Me feature (`public/locate-me.html`) allows users to discover their nearest cities using GPS coordinates and displays administrative boundaries on an interactive map.

### How It Works

1. **Reverse Geocoding** (`/api/reverse-geocode`)
   - Uses GPS coordinates to find the nearest cities
   - Implements optimized brute-force search with bounding-box pre-filtering
   - Prioritizes cities in the same administrative region
   - Data source: `data/geocoder/cities.min.json.gz`

2. **Polygon Lookup** (`/api/gadm-polygon`)
   - Retrieves administrative boundaries from OpenStreetMap via Overpass API
   - Supports admin levels 6-10 (counties, cities, towns, neighborhoods)
   - Falls back to nearby cities when only county boundaries are available
   - Caches responses for 5 minutes

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
- `scripts/` – Build and deployment scripts
  - `apply-version.js` – Updates version numbers before deployment
  - `deploy-and-alias.js` – Orchestrates deployment and domain aliasing
  - `verify-deploy.js` – Verifies deployment across aliases
- `data/` – Data files (geocoder city data, etc.)
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

## Recent Improvements

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
