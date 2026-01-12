# Gallery ADM4/ADM5 Status and Implementation History

## Current Status

**Last Updated:** January 12, 2025

### What's Working
- ✅ Gallery is deployed and accessible at: https://levante-pitwall.vercel.app/gallery/locate-me/
- ✅ ADM2/ADM3 boundaries display correctly for all countries
- ✅ ADM4 boundaries display correctly for **India only** (uses GeoBoundaries API)
- ✅ Geofabrik pack building script exists (`scripts/adm/build-geofabrik-packs.js`)
- ✅ Country filtering implemented (filters out cross-border regions)
- ✅ Gallery generation script updated to prioritize Geofabrik packs

### What's Not Working
- ❌ ADM4/ADM5 boundaries **not displaying** for most countries (DE, NL, CA, US, GB, CO, CH, AR)
- ❌ Overpass API geometry reconstruction is incomplete (only uses first outer ring, doesn't handle multipolygons)
- ❌ Point-in-polygon matching fails for Overpass-generated packs
- ❌ osmium-tool not installed (requires sudo, needed for proper geometry extraction)

### Root Cause
The Geofabrik packs are being built using the Overpass API fallback (because osmium-tool isn't installed). The Overpass geometry reconstruction in `build-geofabrik-packs.js` has fundamental limitations:
1. Only uses the first outer ring from relations
2. Doesn't properly reconstruct multipolygons
3. Creates incomplete polygons that don't match points correctly

## Implementation History

### Phase 1: Initial GeoBoundaries Integration
- **Goal**: Get ADM4 boundaries for all countries
- **Approach**: Direct GeoBoundaries API calls
- **Issues**: 
  - Vercel read-only filesystem
  - Timeout limits (30s → 60s)
  - Deployment size limits (250MB)
- **Solution**: Pre-download GeoBoundaries data, store in GCS, API fetches from bucket

### Phase 2: GCS Integration
- **Goal**: Overcome Vercel limitations
- **Approach**: Pre-download GeoBoundaries data, upload to GCS bucket
- **Result**: ✅ GeoBoundaries API works, but only provides ADM4 for India

### Phase 3: Hybrid Approach (GADM + GeoBoundaries)
- **Goal**: Get ADM3 for most countries, ADM4 for India
- **Approach**: Use GeoBoundaries for India, GADM for others
- **Result**: ✅ ADM3 works, but ADM4 only for India

### Phase 4: OSM Overpass Integration
- **Goal**: Get ADM4+ for all countries
- **Approach**: Query Overpass API for admin_level 4-5 boundaries
- **Issues**:
  - Rate limits (HTTP 429, 504)
  - Multiple Overpass instances with failover implemented
  - Nominatim pre-check added to reduce queries
- **Result**: ⚠️ Packs created but geometry reconstruction incomplete

### Phase 5: Geofabrik Extracts
- **Goal**: More consistent ADM4/ADM5 data
- **Approach**: Download Geofabrik PBF files, extract admin boundaries
- **Implementation**: `scripts/adm/build-geofabrik-packs.js`
- **Methods**:
  1. **osmium-tool** (preferred): Downloads PBF → Extracts with osmium → Converts to GeoJSON
  2. **Overpass API fallback**: Queries Overpass when osmium-tool not available
- **Result**: ⚠️ Overpass fallback has geometry issues

### Phase 6: Country Filtering
- **Goal**: Remove cross-border regions from packs
- **Issue**: DE pack included Austrian (Steiermark) and Dutch (Fryslân) regions
- **Solution**: Added geometry-based filtering using polygon centroid within country bounding box
- **Result**: ✅ Country filtering works, but geometry still incomplete

### Phase 7: Debugging Geometry Issues
- **Problem**: Packs load but point-in-polygon doesn't match
- **Findings**:
  - Overpass geometry reconstruction only uses first outer ring
  - Polygons are incomplete (e.g., Noord-Holland has 36 coordinates but doesn't contain Amsterdam)
  - Custom `pointInPolygon` function works correctly (tested with Turf.js)
- **Root Cause**: Overpass fallback geometry reconstruction is fundamentally limited

## Options Moving Forward

### Option 1: Install osmium-tool (Recommended)
**Status**: ⏳ Pending (requires sudo)

**Steps**:
1. Install osmium-tool:
   ```bash
   sudo apt-get update && sudo apt-get install -y osmium-tool
   ```
2. Rebuild all packs:
   ```bash
   cd /home/david/levante/levante-web-dashboard
   node scripts/adm/build-geofabrik-packs.js de,nl,ca,us,gb,co,ch,ar
   ```
3. Regenerate gallery:
   ```bash
   USE_GEOBOUNDARIES=false node scripts/generate-locate-me-gallery.js
   node scripts/generate-gallery-images.js
   ```
4. Deploy:
   ```bash
   git add public/adm-packs/ public/gallery/
   git commit -m "Rebuild packs with osmium-tool"
   git push
   npm run deploy
   ```

**Why**: osmium-tool extracts complete geometries from PBF files, avoiding Overpass reconstruction issues.

**Documentation**: See `docs/install-osmium-tool.md`

### Option 2: Fix Overpass Geometry Reconstruction
**Status**: ⚠️ Complex, may not work perfectly

**Challenges**:
- Need to properly reconstruct multipolygons from relations
- Must handle multiple outer rings and inner rings (holes)
- Must correctly order ways to form closed polygons
- Requires understanding OSM relation structure

**Effort**: High (would require significant refactoring of `convertOSMToGeoJSON` function)

**Likelihood of Success**: Low (Overpass API doesn't provide complete geometry, requires complex reconstruction)

### Option 3: Use Different Data Source
**Status**: 🔍 Not explored

**Alternatives**:
- **Natural Earth**: Has admin boundaries but may not have ADM4/ADM5 granularity
- **OpenStreetMap Nominatim**: Can reverse geocode but doesn't provide boundary polygons
- **Commercial APIs**: Cost-prohibitive for our use case

### Option 4: Accept Current State
**Status**: ✅ Works for India

**Current Coverage**:
- ADM2/ADM3: ✅ All countries
- ADM4: ✅ India only (via GeoBoundaries)
- ADM5: ❌ Not available

**Trade-off**: Accept that most countries only show ADM2/ADM3, which is still useful for regional identification.

## Technical Details

### Pack Building Process

1. **Download Geofabrik PBF**:
   - Source: https://download.geofabrik.de/
   - Files cached in `data/geofabrik/`
   - Country-specific files (e.g., `netherlands-latest.osm.pbf`)

2. **Extract Admin Boundaries**:
   - **With osmium-tool**:
     ```bash
     osmium tags-filter <pbf> r/boundary=administrative r/admin_level=4 -o <output>.osm.pbf
     osmium export <output>.osm.pbf -o <output>.geojson
     ```
   - **With Overpass API**:
     - Queries Overpass with bounding box
     - Reconstructs geometry from relations → ways → nodes
     - Converts to GeoJSON

3. **Country Filtering**:
   - Checks `ISO3166-1` tag on relations
   - If missing, filters by polygon centroid within country bounding box
   - Removes cross-border regions

4. **Compression**:
   - GeoJSON files compressed with gzip
   - Stored as `adm4-geofabrik.json.gz` or `adm5-geofabrik.json.gz`

### Gallery Generation Process

1. **Load Seed Points**: `public/gallery/locate-me/seed-points.json`
2. **Process Each Point**:
   - Load ADM packs (priority: Geofabrik → OSM → GADM)
   - Find smallest containing boundary (ADM5 → ADM4 → ADM3 → ADM2)
   - Assign to `cityArea` (regional/ADM2) and `adminArea` (local/ADM3-5)
3. **Generate Gallery Data**: `public/gallery/locate-me/gallery-data.json`
4. **Generate Images**: `scripts/generate-gallery-images.js`
   - Creates `.webp` images with Mapbox Static Images API
   - Overlays polygons on map
   - Adds weather data

### File Structure

```
public/adm-packs/
  {country}/
    adm2.json.gz          # GADM ADM2
    adm3.json.gz          # GADM ADM3
    adm4-geofabrik.json.gz # Geofabrik ADM4 (if built)
    adm5-geofabrik.json.gz # Geofabrik ADM5 (if built)
    adm4-osm.json.gz      # OSM Overpass ADM4 (fallback)
    adm5-osm.json.gz      # OSM Overpass ADM5 (fallback)

public/gallery/locate-me/
  gallery-data.json       # Gallery metadata
  images/                 # Generated .webp images
  index.html              # Gallery viewer
  seed-points.json        # GPS points to process
```

### Key Scripts

- **`scripts/adm/build-geofabrik-packs.js`**: Builds Geofabrik packs (osmium-tool or Overpass)
- **`scripts/generate-locate-me-gallery.js`**: Generates gallery data from seed points
- **`scripts/generate-gallery-images.js`**: Creates map images for gallery

### Key Functions

- **`loadAdmPack(countryCode, level)`**: Loads ADM pack with priority (Geofabrik → OSM → GADM)
- **`lookupTwoLevelAreas(lat, lon, country, admin1Hint)`**: Finds ADM2 and local boundary (ADM3-5)
- **`pointInPolygon(pt, geom)`**: Custom point-in-polygon check (ray-casting algorithm)
- **`convertOSMToGeoJSON(osmData, adminLevel, countryIso2)`**: Converts Overpass response to GeoJSON

## Lessons Learned

1. **Vercel Limitations**: Read-only filesystem, timeout limits, deployment size limits require cloud storage
2. **Overpass API Limitations**: Rate limits, incomplete geometry, requires complex reconstruction
3. **osmium-tool is Essential**: Proper geometry extraction requires osmium-tool, Overpass fallback is insufficient
4. **Country Filtering is Critical**: Bounding boxes can include neighboring countries, need explicit filtering
5. **Geometry Reconstruction is Hard**: Properly reconstructing OSM multipolygons from relations is complex
6. **Hybrid Approaches Work**: Combining multiple data sources (GADM, GeoBoundaries, OSM) provides best coverage

## Next Steps

1. **Install osmium-tool** (requires sudo access)
2. **Rebuild all Geofabrik packs** with proper geometry
3. **Verify point-in-polygon matching** works correctly
4. **Regenerate gallery** with ADM4/ADM5 boundaries
5. **Deploy** updated gallery

## Related Documentation

- `docs/install-osmium-tool.md` - Installation instructions
- `docs/locate-me/README.md` - Locate Me feature documentation
- `public/gallery/locate-me/README.md` - Gallery documentation
- `scripts/adm/build-geofabrik-packs.js` - Pack building script (has inline docs)
