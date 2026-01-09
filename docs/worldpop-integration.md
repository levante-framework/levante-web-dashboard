# WorldPop Integration Guide

## Overview

This document explains how **WorldPop** works and evaluates whether it could serve as a better source of population data for the Locate Me feature, replacing the current GeoNames-based city-summing approach.

---

## Current Population Estimation Method

### How It Works Now

**Location**: `scripts/generate-gallery-images.js` → `estimatePopulationFromCities()`

**Algorithm**:
1. Takes a polygon (regional or local boundary)
2. Filters GeoNames cities (`cities.min.json.gz`) by bounding box
3. Performs point-in-polygon check for each city
4. Sums the `population` field of cities inside the polygon

**Data Source**: GeoNames `cities5000` dump
- Contains cities with population ≥ 1,000
- Includes: `{ id, name, lat, lon, country, admin1, admin2, population }`
- Stored as: `data/geocoder/cities.min.json.gz` (~5-10MB compressed)

**Limitations**:
- ❌ **Incomplete coverage**: Only includes cities ≥ 1,000 population
- ❌ **Point-based**: Treats cities as points, not accounting for actual city boundaries
- ❌ **Missing rural areas**: Rural populations between cities are not counted
- ❌ **Approximation**: Sum of city populations ≠ actual polygon population
- ❌ **Country-dependent**: Accuracy varies by GeoNames coverage quality

**Example Problem**:
- A polygon containing 3 cities (10k, 5k, 2k) = 17,000 estimated
- But the polygon might actually contain 25,000 people including rural areas between cities

---

## What is WorldPop?

**WorldPop** is a research initiative at the University of Southampton that produces high-resolution, gridded population datasets using machine learning and multiple data sources.

### How WorldPop Works

**Methodology**:
1. **Data Integration**: Combines multiple sources:
   - Census data (official population counts)
   - Satellite imagery (settlement patterns, building footprints)
   - Demographic surveys
   - Mobile phone data (where available)
   - Administrative boundaries

2. **Machine Learning Modeling**: Uses ML algorithms to:
   - Disaggregate census data from administrative units to fine grids
   - Predict population density based on settlement patterns
   - Account for factors like building density, road networks, land use

3. **Gridded Output**: Produces raster datasets:
   - **Resolution**: Uniform global grid of **100m × 100m per pixel** (approximately 0.000833° at equator)
   - **Format**: GeoTIFF (raster images with geographic metadata)
   - **Coverage**: Global, with focus on low/middle-income countries
   - **Updates**: Annual releases (e.g., 2020, 2021, 2022, 2023)

**Data Structure**:
- **Uniform pixel grid**: WorldPop uses a **consistent global grid** of 100m × 100m cells
- **Not polygons**: It's a raster (pixel-based) dataset, not vector polygons
- **Each pixel**: Contains a population count (number of people in that 100m × 100m cell)
- **Georeferenced**: Pixels are aligned to geographic coordinates (lat/lon)
- **Can be aggregated**: Pixels can be summed within any polygon boundary (administrative units, custom shapes, etc.)

**Important Notes**:
- **Uniform resolution**: The 100m × 100m grid is consistent globally (not varying by country)
- **Aggregated versions**: WorldPop also provides 1km × 1km aggregated versions for faster processing
- **Pixel-based**: Each cell is a square pixel, not a polygon with varying shapes
- **Geographic alignment**: The grid is aligned to a standard geographic coordinate system (WGS84)

---

## WorldPop vs OpenStreetMap Tiles: Spatial Alignment

### Coordinate System Differences

**WorldPop**:
- **Coordinate System**: GCS_WGS_84 (EPSG:4326) - Geographic coordinates (lat/lon)
- **Grid Structure**: Uniform 100m × 100m pixels globally
- **Origin**: Top-left corner, rows increase southward, columns increase eastward
- **Projection**: Geographic (unprojected lat/lon)

**OpenStreetMap Tiles**:
- **Coordinate System**: Spherical Mercator / Web Mercator (EPSG:3857)
- **Tile Structure**: Pyramid structure with varying tile sizes by zoom level
- **Origin**: Top-left corner, tiles increase downward and rightward
- **Projection**: Mercator (projected coordinates in meters)

### Key Differences

| Aspect | WorldPop | OSM Tiles |
|--------|----------|-----------|
| **Coordinate System** | WGS84 (EPSG:4326) | Web Mercator (EPSG:3857) |
| **Grid Type** | Uniform 100m × 100m pixels | Pyramid tiles (size varies by zoom) |
| **Alignment** | Geographic grid (lat/lon) | Tile grid (z/x/y coordinates) |
| **Direct Overlay** | ❌ No (different projections) | N/A |
| **Reprojection Needed** | ✅ Yes (for OSM overlay) | N/A |

### Tile Size at Different Zoom Levels

OSM tiles use a pyramid structure where tile size varies by zoom level:

| Zoom Level | Tile Size (meters) | Approximate Area | WorldPop Pixels per Tile |
|------------|-------------------|------------------|-------------------------|
| 10 | ~1,500m × 1,500m | ~2.25 km² | ~15 × 15 = 225 pixels |
| 12 | ~400m × 400m | ~0.16 km² | ~4 × 4 = 16 pixels |
| 14 | ~100m × 100m | ~0.01 km² | ~1 × 1 = 1 pixel |
| 16 | ~25m × 25m | ~0.0006 km² | ~0.25 × 0.25 (sub-pixel) |
| 18 | ~6m × 6m | ~0.00004 km² | ~0.06 × 0.06 (sub-pixel) |

**Key Insight**: At zoom level **14**, OSM tiles are approximately **100m × 100m** (same as WorldPop pixels), making this a natural alignment point.

### Alignment Challenges

**1. Projection Mismatch**
- WorldPop uses geographic coordinates (WGS84)
- OSM tiles use Web Mercator projection
- **Solution**: Reproject WorldPop to Web Mercator before overlaying

**2. Grid Misalignment**
- WorldPop grid is aligned to lat/lon (geographic)
- OSM tiles are aligned to tile coordinates (z/x/y)
- Even after reprojection, grids won't perfectly align
- **Impact**: WorldPop pixels may span tile boundaries

**3. Zoom Level Dependency**
- At zoom 14: ~1 WorldPop pixel per tile (good alignment)
- At zoom 12: ~16 WorldPop pixels per tile (need aggregation)
- At zoom 16+: Multiple tiles per WorldPop pixel (need interpolation)

### Practical Implications

**For Your Project** (Locate Me Gallery):

**Current Setup**:
- Uses **Mapbox Static Images API** (which uses Web Mercator)
- Generates static images with GeoJSON overlays
- Population estimates are **text labels**, not visual overlays

**If Overlaying WorldPop**:

**Option A: Server-Side Aggregation** (Recommended)
```javascript
// Query WorldPop API for polygon (already handles projection)
const population = await estimatePopulationFromWorldPopAPI(polygon);
// Use as text label (no visual overlay needed)
```

**Option B: Visual Heatmap Overlay** (If desired)
- Reproject WorldPop pixels to Web Mercator
- Aggregate pixels to match tile resolution
- Render as colored overlay on map
- **Complexity**: High (requires raster processing)

**Option C: Pre-rendered Tiles** (For interactive maps)
- Convert WorldPop to tile format (TMS/XYZ)
- Serve as separate tile layer
- Overlay on OSM tiles
- **Complexity**: Very high (requires tile server)

### For Your Use Case

**Good News**: You don't need to worry about tile alignment!

Since you're using WorldPop for **population estimates** (text labels), not visual overlays:

1. **WorldPop API**: Handles projection automatically
   - Send polygon in GeoJSON (WGS84)
   - API returns population sum
   - No tile alignment needed

2. **Gallery Images**: Population shown as text
   - No visual overlay required
   - No tile alignment issues
   - Just display the number from API

3. **Interactive Maps**: Same approach
   - Query WorldPop API for polygon
   - Display population as text/label
   - No raster overlay needed

---

## Using WorldPop to Select Privacy-Preserving OSM Tiles

### The Privacy Challenge

Your current privacy strategy:
- ✅ Never store raw GPS coordinates
- ✅ Use approximate city centers for logging
- ✅ Round coordinates before network calls
- ✅ Process everything client-side when possible

**New Challenge**: When displaying OSM map tiles, you want to show tiles that are:
- ✅ **Nearby** (close to actual location for context)
- ✅ **Low population density** (privacy-preserving)
- ✅ **Similar context** (similar geographic features)

### How WorldPop Can Help

**Concept**: Use WorldPop population density to identify nearby OSM tiles with low population, then display those tiles instead of the exact location tile.

**Algorithm**:
1. **Get actual location**: User's GPS coordinates (lat/lon)
2. **Convert to OSM tile coordinates**: Calculate tile (z/x/y) for actual location
3. **Generate candidate tiles**: Create a ring of nearby tiles (e.g., 1-3 tiles away in all directions)
4. **Query WorldPop for each candidate**: Get population density for each tile's bounding box
5. **Select lowest-population tile**: Choose the tile with minimum population density
6. **Display selected tile**: Show the privacy-preserving tile instead of exact location

### Implementation Approach

**Option 1: Client-Side with WorldPop API** (Recommended)

```javascript
/**
 * Find a privacy-preserving OSM tile near the given location
 * @param {number} lat - Actual latitude
 * @param {number} lon - Actual longitude
 * @param {number} zoom - OSM zoom level (default: 14)
 * @param {number} searchRadius - Number of tiles to search in each direction (default: 2)
 * @returns {Promise<{z: number, x: number, y: number, population: number}>}
 */
async function findPrivacyPreservingTile(lat, lon, zoom = 14, searchRadius = 2) {
  // 1. Convert actual location to OSM tile coordinates
  const actualTile = latLonToTile(lat, lon, zoom);
  
  // 2. Generate candidate tiles (ring around actual location)
  const candidates = [];
  for (let dx = -searchRadius; dx <= searchRadius; dx++) {
    for (let dy = -searchRadius; dy <= searchRadius; dy++) {
      // Skip the exact location tile
      if (dx === 0 && dy === 0) continue;
      
      const candidateX = actualTile.x + dx;
      const candidateY = actualTile.y + dy;
      
      // Validate tile coordinates
      const maxTile = Math.pow(2, zoom);
      if (candidateX >= 0 && candidateX < maxTile && 
          candidateY >= 0 && candidateY < maxTile) {
        candidates.push({ x: candidateX, y: candidateY });
      }
    }
  }
  
  // 3. Query WorldPop API for each candidate tile's bounding box
  const tilePopulations = await Promise.all(
    candidates.map(async (tile) => {
      const bbox = tileToBoundingBox(tile.x, tile.y, zoom);
      const polygon = bboxToGeoJSONPolygon(bbox);
      
      try {
        const population = await queryWorldPopAPI(polygon);
        return { ...tile, population: population || 0 };
      } catch (error) {
        console.warn(`WorldPop query failed for tile ${tile.x}/${tile.y}:`, error);
        return { ...tile, population: Infinity }; // Prefer tiles with successful queries
      }
    })
  );
  
  // 4. Select tile with minimum population
  tilePopulations.sort((a, b) => a.population - b.population);
  const selected = tilePopulations[0];
  
  return {
    z: zoom,
    x: selected.x,
    y: selected.y,
    population: selected.population,
    actualTile: { x: actualTile.x, y: actualTile.y }
  };
}

// Helper: Convert lat/lon to OSM tile coordinates
function latLonToTile(lat, lon, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

// Helper: Convert OSM tile to bounding box
function tileToBoundingBox(x, y, zoom) {
  const n = Math.pow(2, zoom);
  const lonMin = (x / n) * 360 - 180;
  const lonMax = ((x + 1) / n) * 360 - 180;
  const latMax = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const latMin = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { latMin, latMax, lonMin, lonMax };
}

// Helper: Convert bounding box to GeoJSON polygon
function bboxToGeoJSONPolygon(bbox) {
  return {
    type: "Polygon",
    coordinates: [[
      [bbox.lonMin, bbox.latMin],
      [bbox.lonMax, bbox.latMin],
      [bbox.lonMax, bbox.latMax],
      [bbox.lonMin, bbox.latMax],
      [bbox.lonMin, bbox.latMin]
    ]]
  };
}

// Helper: Query WorldPop API
async function queryWorldPopAPI(polygon, year = 2020) {
  const url = `https://api.worldpop.org/v1/services/stats?` +
    `dataset=wpgppop&` +
    `year=${year}&` +
    `geojson=${encodeURIComponent(JSON.stringify(polygon))}`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`WorldPop API error: ${response.status}`);
  }
  const data = await response.json();
  return data?.stats?.sum ?? 0;
}
```

**Usage Example**:
```javascript
// User's actual location (never displayed)
const actualLat = 40.7128;
const actualLon = -74.0060;

// Find privacy-preserving tile
const privacyTile = await findPrivacyPreservingTile(actualLat, actualLon, 14, 2);

// Display the privacy-preserving tile instead
const map = L.map('map').setView([
  tileToLatLon(privacyTile.x, privacyTile.y, privacyTile.z).lat,
  tileToLatLon(privacyTile.x, privacyTile.y, privacyTile.z).lon
], privacyTile.z);

// Load OSM tile
L.tileLayer(`https://tile.openstreetmap.org/${privacyTile.z}/${privacyTile.x}/${privacyTile.y}.png`).addTo(map);

console.log(`Showing tile with population: ${privacyTile.population} (actual location tile had higher population)`);
```

### Privacy Benefits

**Advantages**:
- ✅ **Preserves context**: Nearby tiles maintain geographic relevance
- ✅ **Reduces identifiability**: Low-population tiles are harder to associate with specific individuals
- ✅ **Maintains functionality**: Map still shows relevant area
- ✅ **Configurable**: Can adjust search radius based on privacy requirements

**Considerations**:
- ⚠️ **Network calls**: Requires WorldPop API calls (but can cache results)
- ⚠️ **Latency**: Adds ~50-500ms per candidate tile query
- ⚠️ **Rate limits**: WorldPop API has rate limits (1,000 calls/day free tier)
- ⚠️ **Rural bias**: WorldPop underestimates rural populations (but that's fine for privacy)

### Optimization Strategies

**1. Cache Tile Population Data**
```javascript
// Cache WorldPop queries by tile coordinates
const tilePopulationCache = new Map();

async function getCachedTilePopulation(x, y, z) {
  const key = `${z}/${x}/${y}`;
  if (tilePopulationCache.has(key)) {
    return tilePopulationCache.get(key);
  }
  
  const bbox = tileToBoundingBox(x, y, z);
  const polygon = bboxToGeoJSONPolygon(bbox);
  const population = await queryWorldPopAPI(polygon);
  
  tilePopulationCache.set(key, population);
  return population;
}
```

**2. Pre-compute Privacy Tiles**
```javascript
// For gallery generation, pre-compute privacy tiles
// Store mapping: actualLocation → privacyTile
const privacyTileMap = {
  "40.7128,-74.0060": { z: 14, x: 4824, y: 6159, population: 150 }
};
```

**3. Limit Search Radius**
```javascript
// Start with small radius, expand if needed
let searchRadius = 1; // Only check immediate neighbors
// If all neighbors have high population, expand to radius = 2
```

**4. Use Population Thresholds**
```javascript
// Only use privacy tile if actual location tile exceeds threshold
const PRIVACY_THRESHOLD = 1000; // Only protect if population > 1000

const actualTilePopulation = await getCachedTilePopulation(actualTile.x, actualTile.y, zoom);
if (actualTilePopulation > PRIVACY_THRESHOLD) {
  // Find privacy-preserving alternative
  const privacyTile = await findPrivacyPreservingTile(lat, lon, zoom, 2);
  return privacyTile;
} else {
  // Low population already, use actual location
  return actualTile;
}
```

### Integration with Current Privacy Strategy

**Current Flow**:
```
User GPS → Round coordinates → Use for city lookup → Display approximate city center
```

**Enhanced Flow with WorldPop**:
```
User GPS → Calculate OSM tile → Query WorldPop for nearby tiles → 
Select lowest-population tile → Display privacy-preserving tile
```

**Combined Approach**:
```javascript
// 1. Get approximate city center (existing privacy measure)
const cityCenter = await findNearestCity(lat, lon);

// 2. Find privacy-preserving tile near city center
const privacyTile = await findPrivacyPreservingTile(
  cityCenter.lat, 
  cityCenter.lon, 
  14, 
  2
);

// 3. Display privacy-preserving tile
displayMapTile(privacyTile);
```

### Use Cases

**1. Interactive Locate Me Page**
- User grants GPS permission
- System finds privacy-preserving tile near actual location
- Displays map with privacy-preserving tile
- User sees relevant area without revealing exact location

**2. Gallery Generation**
- Pre-compute privacy tiles for seed points
- Generate gallery images using privacy-preserving tiles
- Maintains visual consistency while protecting privacy

**3. Location Logging**
- When logging locations, use privacy-preserving tile coordinates
- Store tile (z/x/y) instead of lat/lon
- Reduces identifiability while maintaining approximate location

### Limitations & Considerations

**1. Geographic Context Loss**
- Privacy-preserving tile might show different geographic features
- User might see farmland instead of urban area
- **Mitigation**: Limit search radius, prefer tiles with similar elevation/terrain

**2. API Rate Limits**
- WorldPop API: 1,000 calls/day (free tier)
- Each privacy tile search = 8-24 API calls (depending on search radius)
- **Mitigation**: Cache results, pre-compute for common locations

**3. Rural Bias**
- WorldPop underestimates rural populations
- Might select tiles that appear low-population but aren't
- **Impact**: Actually beneficial for privacy (more conservative)

**4. Tile Alignment**
- WorldPop pixels don't perfectly align with OSM tiles
- Some approximation error in population estimates
- **Impact**: Minimal for privacy purposes (exact numbers less important)

### Alternative: Pre-computed Privacy Tile Database

**Approach**: Pre-compute privacy-preserving tiles for common locations

**Steps**:
1. Generate grid of locations (e.g., every 0.1° lat/lon)
2. For each location, find privacy-preserving tile
3. Store mapping: `location → privacyTile`
4. Serve as static JSON file or database

**Benefits**:
- ✅ No API calls at runtime
- ✅ Fast lookup
- ✅ Predictable performance

**Drawbacks**:
- ❌ Large file size (millions of entries)
- ❌ Requires periodic updates
- ❌ Less flexible than dynamic lookup

### If You Wanted Visual Overlays

**Example**: Heatmap showing population density

**Steps**:
1. Download WorldPop GeoTIFF (WGS84)
2. Reproject to Web Mercator (EPSG:3857)
3. Generate tiles at desired zoom levels
4. Aggregate WorldPop pixels to match tile resolution
5. Render as colored overlay

**Tools Needed**:
- GDAL (`gdalwarp` for reprojection)
- Tile generation tool (e.g., `gdal2tiles.py`)
- Tile server (e.g., MapServer, GeoServer)

**Complexity**: High - probably not worth it for your use case

---

## Advantages of WorldPop

### ✅ **Comprehensive Coverage**

- **Rural inclusion**: Includes rural populations between cities
- **Complete coverage**: Every 100m × 100m cell has a population estimate
- **No gaps**: Unlike GeoNames (city points only), covers entire land area

### ✅ **Higher Accuracy**

- **Validated**: Peer-reviewed methodology
- **Multi-source**: Combines census + satellite + surveys (more reliable than single source)
- **Spatial modeling**: Accounts for actual settlement patterns, not just city centroids

### ✅ **Better for Polygons**

- **Raster-based**: Perfect for polygon population estimation
- **Zonal statistics**: Can sum pixels within polygon boundaries accurately
- **No point approximation**: Doesn't rely on city centroids falling inside polygons

### ✅ **Up-to-Date**

- **Annual releases**: More current than GeoNames (which updates less frequently)
- **Time series**: Can track population changes over years

---

## Limitations of WorldPop

### ⚠️ **Rural Underestimation: A Critical Issue**

WorldPop has a **significant and systematic bias** against rural populations. This is not a minor limitation—it's a fundamental issue affecting all major gridded population datasets.

#### The Numbers

A comprehensive 2025 study published in *Nature Communications* evaluated five major global population datasets and found:

- **WorldPop**: Underestimates rural populations by **53.4%** (accounts for less than half of actual rural population)
- **GHS-POP**: Worst performer at **83.8%** underestimation
- **All datasets**: Show substantial negative bias in rural areas (WorldPop is actually among the better ones)

**What this means**: If a rural area has 10,000 people, WorldPop might estimate only ~4,660 people.

#### Root Causes

The rural underestimation stems from multiple interconnected factors:

**1. Census Data Quality Issues**
- **Logistical challenges**: Rural areas are harder to survey—remote locations, poor infrastructure, difficult access
- **Resource constraints**: Census operations prioritize urban areas where more people live
- **Incomplete coverage**: Some rural settlements are missed entirely during census enumeration
- **Language barriers**: Census takers may not speak local languages in remote areas
- **Political/security issues**: Conflict zones and disputed territories often have incomplete census data

**2. Urban-Centric Model Calibration**
- **Training bias**: Machine learning models are calibrated primarily on urban patterns
- **Feature detection**: Models learn to recognize dense settlement patterns (buildings, roads, infrastructure)
- **Rural patterns differ**: Dispersed settlements, agricultural areas, and low-density housing don't match urban training data
- **Model assumptions**: Algorithms assume population correlates with visible infrastructure, which breaks down in rural areas

**3. Satellite Imagery Limitations**
- **Detection challenges**: Dispersed rural settlements are harder to identify from space
- **Vegetation interference**: Dense forests and agricultural areas obscure buildings
- **Cloud cover**: Persistent cloud cover in some regions blocks satellite views
- **Resolution limits**: Even high-resolution imagery may miss small rural structures
- **Settlement patterns**: Rural homes may be scattered, making pixel-level detection difficult

**4. Data Integration Problems**
- **Census disaggregation**: When census data is disaggregated from administrative units to grids, rural areas get less accurate allocation
- **Missing auxiliary data**: Rural areas have fewer data sources (no mobile phone data, fewer surveys)
- **Validation gaps**: Less ground truth data exists to validate rural estimates

#### Regional Variations

While the **53.4%** figure is a global average, the severity varies significantly:

**Most Affected Regions**:
- **Sub-Saharan Africa**: High underestimation due to poor census coverage and dispersed settlements
- **Remote mountainous areas**: Himalayas, Andes, Central Asia—logistical census challenges
- **Conflict zones**: Syria, Yemen, parts of Africa—incomplete census data
- **Densely forested regions**: Amazon, Congo Basin—satellite detection difficulties

**Less Affected Regions**:
- **Well-surveyed countries**: USA, Canada, Western Europe—better census coverage
- **Urbanized areas**: Even in developing countries, cities are more accurately estimated
- **Agricultural plains**: Easier to detect and survey than mountainous or forested areas

**Country-Specific Examples**:
- **India**: Moderate underestimation (better census coverage)
- **Nigeria**: High underestimation (poor rural census coverage)
- **USA**: Low underestimation (comprehensive census + good satellite coverage)
- **Colombia**: Moderate to high (mountainous terrain challenges)

#### Implications for Our Use Case

**For Locate Me Gallery**:

**Rural polygons will be underestimated**:
- A rural administrative boundary (ADM2/ADM3) might show 5,000 people when it actually has 10,000+
- This affects the "population" label shown on gallery images
- **Impact**: Gallery images may show lower population estimates than reality

**Urban polygons are more accurate**:
- City boundaries and urban administrative units are estimated more reliably
- **Impact**: Urban gallery images will have better population estimates

**Mixed urban-rural polygons**:
- Polygons containing both urban and rural areas will have partial underestimation
- Urban portions accurate, rural portions underestimated
- **Impact**: Estimates will be somewhere between accurate and 50% low

#### Comparison with GeoNames (Current Method)

**GeoNames also underestimates rural areas**, but for different reasons:

| Aspect | GeoNames | WorldPop |
|--------|----------|----------|
| **Rural Coverage** | ❌ Excludes rural entirely (cities only) | ⚠️ Includes rural but underestimates by 53% |
| **Urban Accuracy** | ✅ Good (city population data) | ✅ Good (validated in urban areas) |
| **Rural Accuracy** | ❌ Zero (not included) | ⚠️ ~47% of actual (53% underestimation) |
| **Overall Polygon** | ❌ Underestimates (misses rural) | ⚠️ Underestimates (rural bias) |

**Key Insight**: 
- **GeoNames**: Shows 0 for purely rural polygons (no cities ≥1,000)
- **WorldPop**: Shows ~47% of actual for purely rural polygons
- **WorldPop is still better** for rural areas, even with the bias

**Example Scenario**:
- Polygon with 2 cities (5k + 3k = 8k) + 4k rural = **12k total**
- **GeoNames**: 8k (misses 4k rural) = **33% underestimation**
- **WorldPop**: ~5.6k (8k urban accurate + 4k rural × 47% = 1.9k) = **53% underestimation**

**In this case, GeoNames is actually better** because the urban portion dominates. But for polygons with more rural area, WorldPop would be better.

#### Potential Workarounds

**1. Apply Correction Factors** (Not Recommended)
- Multiply rural estimates by ~2.14 (1 / 0.47) to correct for bias
- **Problem**: Correction factors vary by region and are not well-documented
- **Problem**: Would overcorrect urban areas if applied globally
- **Problem**: No reliable way to distinguish urban vs rural pixels

**2. Hybrid Approach** (Recommended)
- Use WorldPop for urban-dominant polygons
- Use GeoNames for rural-dominant polygons (or fallback)
- **Challenge**: Need to classify polygons as urban vs rural

**3. Accept the Limitation** (Pragmatic)
- Acknowledge that population estimates are approximate
- WorldPop is still better than GeoNames for comprehensive coverage
- Document the limitation in gallery metadata

**4. Use Alternative Datasets** (Future)
- **LandScan**: Better for some regions but has different biases
- **GPW (Gridded Population of World)**: Older but may have different characteristics
- **Country-specific sources**: Some countries have better local datasets

#### Research Context

The *Nature Communications* study (2025) evaluated datasets against **ground truth** from:
- National census data (where available)
- Local population surveys
- Administrative records

**Key Finding**: **All gridded population datasets underestimate rural populations**. This is a systemic issue, not unique to WorldPop. WorldPop is actually among the better performers.

**Why This Matters**:
- Policy decisions based on these datasets may underallocate resources to rural areas
- Infrastructure planning may underestimate rural needs
- Disaster response may be insufficient for rural communities
- Healthcare and education planning may miss rural populations

### ⚠️ **Accuracy Varies by Region**

- **Best**: Urban areas, well-surveyed countries (USA, Canada, Western Europe)
- **Worse**: Remote rural areas, conflict zones, areas with poor census data (Sub-Saharan Africa, remote Asia)
- **Country-dependent**: Accuracy varies significantly by country and region
- **Rural bias**: The 53% underestimation is an average—some regions may be worse

### ⚠️ **Technical Complexity**

- **Large files**: GeoTIFF files can be 100+ MB per country
- **Processing required**: Need raster processing libraries (GDAL, rasterio)
- **Memory intensive**: Loading full-country rasters requires significant RAM
- **API/Infrastructure**: May need Cloud Optimized GeoTIFF (COG) or tile services

---

## How WorldPop Could Be Integrated

### Option 1: WorldPop REST API (Simplest - Recommended)

**Approach**: Use WorldPop's REST API to query population for polygons

**Steps**:
1. **API Request**: Send polygon GeoJSON to WorldPop API endpoint
2. **Get Results**: Receive aggregated population statistics (sum, mean, etc.)
3. **No Storage**: No need to download or store GeoTIFF files

**Implementation**:
```javascript
// In scripts/generate-gallery-images.js

async function estimatePopulationFromWorldPopAPI(polygon, year = 2020) {
  const geojson = {
    type: 'Polygon',
    coordinates: [polygon.coordinates] // Convert to GeoJSON format
  };
  
  const url = `https://api.worldpop.org/v1/services/stats?` +
    `dataset=wpgppop&` +
    `year=${year}&` +
    `geojson=${encodeURIComponent(JSON.stringify(geojson))}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    
    // API returns: { "stats": { "sum": 12345, "mean": 12.3, ... } }
    return data.stats?.sum || null;
    
  } catch (e) {
    console.warn('WorldPop API request failed:', e);
    return null;
  }
}

// Usage with fallback
async function estimatePopulation(polygon, countryCode) {
  // Try WorldPop API first
  const worldPop = await estimatePopulationFromWorldPopAPI(polygon);
  if (worldPop !== null) return worldPop;
  
  // Fallback to GeoNames
  return estimatePopulationFromCities(polygon, countryCode);
}
```

**Pros**:
- ✅ **Simplest**: No raster processing libraries needed
- ✅ **No storage**: No need to download/store large GeoTIFF files
- ✅ **Fast setup**: Just HTTP requests
- ✅ **Automatic aggregation**: API handles polygon queries and returns sum
- ✅ **Always up-to-date**: Uses latest WorldPop data

**Cons**:
- ⚠️ **Network dependency**: Requires internet connection
- ⚠️ **Rate limits**: 1,000 calls/day free tier (can request API key)
- ⚠️ **Latency**: Network requests slower than local processing (~100-500ms)
- ⚠️ **Gallery generation**: May hit rate limits if generating many images

**Best For**:
- Gallery generation (pre-generated, can handle rate limits)
- Low-volume queries
- Quick prototyping

**Rate Limit Considerations**:
- **Gallery**: ~50-100 images = 50-100 API calls (well under 1,000/day limit)
- **Interactive page**: Not recommended (would hit rate limits quickly)
- **Solution**: Request API key for higher limits if needed

### Option 2: Pre-processed Country Rasters (For High Volume)

**Approach**: Download WorldPop GeoTIFFs per country, pre-process into optimized format

**Steps**:
1. **Download**: Get WorldPop GeoTIFF for each supported country (10 countries)
   - Example: `https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/...`
2. **Optimize**: Convert to Cloud Optimized GeoTIFF (COG) or tile format
3. **Store**: Upload to GCS or serve via tile server
4. **Query**: Use zonal statistics to sum pixels within polygon

**Implementation**:
```javascript
// Pseudo-code
async function estimatePopulationFromWorldPop(polygon, countryCode) {
  // Load WorldPop raster for country (or fetch tiles)
  // WorldPop is a uniform 100m × 100m pixel grid (not polygons)
  const raster = await loadWorldPopRaster(countryCode);
  
  // Extract pixels within polygon bounding box
  const bbox = getBoundingBox(polygon);
  const pixels = raster.readPixels(bbox);
  
  // Sum pixels that fall inside polygon
  // Each pixel is a 100m × 100m square cell with a population count
  let total = 0;
  for (const pixel of pixels) {
    // Check if pixel center (or entire pixel) falls inside polygon
    if (pointInPolygon(pixel.coords, polygon)) {
      total += pixel.population; // Add population count from this cell
    }
  }
  
  return total;
}
```

**How It Works**:
1. WorldPop provides a **uniform grid** of 100m × 100m pixels covering the entire country
2. Each pixel contains a population count (e.g., pixel at lat/lon might have 15 people)
3. To estimate polygon population:
   - Extract all pixels whose bounding box intersects the polygon
   - For each pixel, check if it falls inside the polygon (using pixel center or full pixel coverage)
   - Sum the population values from pixels inside the polygon
4. Result: Total population estimate for that polygon

**Visual Example**:
```
WorldPop Grid (100m × 100m pixels):
┌─────┬─────┬─────┬─────┐
│  5  │  8  │  3  │  2  │  ← Each cell = 100m × 100m
├─────┼─────┼─────┼─────┤     Number = population count
│  12 │  15 │  7  │  4  │
├─────┼─────┼─────┼─────┤
│  20 │  25 │  18 │  9  │
└─────┴─────┴─────┴─────┘

Polygon boundary (red line):
     ╱─────────╲
    ╱  [12][15] ╲
   ╱  [20][25]   ╲
  ╱───────────────╲

Population = 12 + 15 + 20 + 25 = 72 people
```

**Pros**:
- ✅ Accurate polygon population estimates
- ✅ Includes rural areas
- ✅ Can cache/pre-process for performance

**Cons**:
- ❌ Large storage requirements (~1GB+ for 10 countries)
- ❌ Requires raster processing libraries
- ❌ More complex than current point-in-polygon

### Option 3: WorldPop API / Tile Service

**Approach**: Use WorldPop's web services (if available) or build tile server

**Steps**:
1. **Tile Server**: Set up COG tile server (e.g., using TiTiler, Terracotta)
2. **Client Query**: Request tiles covering polygon bbox
3. **Sum Pixels**: Sum population values from tiles within polygon

**Pros**:
- ✅ No local storage of large files
- ✅ Can leverage CDN caching
- ✅ Scales better

**Cons**:
- ❌ Requires infrastructure (tile server)
- ❌ Network dependency
- ❌ May have rate limits

### Option 4: Hybrid Approach

**Approach**: Use WorldPop for gallery generation (server-side), keep GeoNames for interactive page (client-side)

**Rationale**:
- **Gallery**: Pre-generated images can use slower, more accurate WorldPop processing
- **Interactive**: Needs fast client-side estimation (GeoNames is sufficient)

**Implementation**:
- Keep `estimatePopulationFromCities()` for interactive page
- Add `estimatePopulationFromWorldPop()` for gallery generation
- Gallery shows more accurate population, interactive page shows approximate

---

## Technical Requirements

### Libraries Needed

**Python** (for server-side processing):
```bash
pip install rasterio geopandas shapely
```

**JavaScript** (if doing client-side):
```bash
npm install geotiff ol-mapbox-style  # or similar raster libraries
```

### Data Storage

**Per Country Estimates**:
- **GeoTIFF**: ~50-200 MB per country (uncompressed)
- **COG**: ~20-100 MB per country (Cloud Optimized)
- **10 countries**: ~200 MB - 2 GB total

**Storage Options**:
1. **GCS Bucket**: `gs://levante-assets-dev/population/worldpop/`
2. **Local Cache**: `data/population/worldpop/` (gitignored)
3. **Tile Server**: Serve via HTTP (no local storage)

### Processing Time

**Per Polygon**:
- **GeoNames (current)**: ~1-10ms (point-in-polygon on small dataset)
- **WorldPop API**: ~100-500ms (network request + processing)
- **WorldPop (raster)**: ~50-500ms (depends on polygon size, raster resolution)

**Gallery Generation**:
- **Current**: ~2-5 seconds per image (includes GeoNames population)
- **With WorldPop API**: ~2.1-5.5 seconds per image (adds ~100-500ms API call)
- **With WorldPop (raster)**: ~3-8 seconds per image (adds raster processing overhead)

---

## Comparison: GeoNames vs WorldPop

| Aspect | GeoNames (Current) | WorldPop (Proposed) |
|--------|-------------------|---------------------|
| **Coverage** | Cities ≥ 1,000 only | Complete land coverage |
| **Rural Areas** | ❌ Excluded entirely | ⚠️ Included but underestimated by 53% |
| **Urban Accuracy** | ✅ Good (city population data) | ✅ Good (validated in urban areas) |
| **Rural Accuracy** | ❌ Zero (not included) | ⚠️ ~47% of actual (53% underestimation) |
| **Overall Accuracy** | Approximate (city sums) | More accurate for comprehensive coverage, but rural bias |
| **File Size** | ~10 MB (all countries) | ~200 MB - 2 GB (10 countries) |
| **Processing** | Simple (point-in-polygon) | Complex (raster zonal stats) |
| **Speed** | ⚡ Fast (~1-10ms) | 🐌 Slower (~50-500ms) |
| **Client-Side** | ✅ Yes (small dataset) | ❌ No (too large) |
| **Updates** | Infrequent | Annual |
| **Dependencies** | None | GDAL/rasterio required |
| **Best For** | Urban-dominant polygons | Comprehensive coverage (urban + rural) |
| **Worst For** | Rural-only polygons (shows 0) | Rural-only polygons (shows ~47% of actual) |

**Key Insight**: 
- **GeoNames**: Better for urban-dominant polygons (no rural bias, accurate city counts)
- **WorldPop**: Better for rural-dominant polygons (includes rural, even if underestimated)
- **Neither is perfect**: Both have limitations, but WorldPop provides more complete coverage

---

## Recommendation

### ✅ **Use WorldPop for Gallery Generation** (With Caveats)

**Rationale**:
1. **Gallery is pre-generated**: Can afford slower processing (50-500ms)
2. **More comprehensive**: Includes rural areas (even if underestimated)
3. **Server-side only**: No need for client-side implementation
4. **Incremental**: Can add WorldPop without removing GeoNames (fallback)

**Important Considerations**:
- ⚠️ **Rural bias**: Gallery images will show lower population for rural-dominant polygons (~47% of actual)
- ⚠️ **Urban accuracy**: Urban polygons will be more accurate than GeoNames
- ⚠️ **Mixed results**: Polygons with both urban and rural will have partial underestimation
- ✅ **Still better**: Even with 53% rural underestimation, WorldPop is better than GeoNames for comprehensive coverage

**Recommendation**: Use WorldPop but **document the limitation** in gallery metadata or tooltips, acknowledging that population estimates are approximate and may underestimate rural areas.

### ❌ **Keep GeoNames for Interactive Page**

**Rationale**:
1. **Fast**: Client-side processing needs to be instant
2. **Small dataset**: GeoNames fits in memory easily
3. **Good enough**: Approximate population is sufficient for interactive display
4. **No dependencies**: Works without raster libraries
5. **Urban focus**: Many interactive queries are for urban areas where GeoNames is accurate

### Implementation Plan

**Phase 1: Add WorldPop API to Gallery** (Recommended - Simplest)

**Start with the API approach** (Option 1) - it's the easiest to implement:

```javascript
// In scripts/generate-gallery-images.js

async function estimatePopulation(polygon, countryCode) {
  // Try WorldPop API first (more accurate, includes rural)
  try {
    const worldPop = await estimatePopulationFromWorldPopAPI(polygon);
    if (worldPop !== null) return worldPop;
  } catch (e) {
    console.warn('WorldPop API failed, falling back to GeoNames', e);
  }
  
  // Fallback to GeoNames (current method)
  return estimatePopulationFromCities(polygon, countryCode);
}
```

**Advantages of starting with API**:
- ✅ No dependencies (just `fetch`)
- ✅ No file downloads or storage
- ✅ Quick to implement (~30 minutes)
- ✅ Easy to test and iterate

**If API rate limits become an issue**, then consider:
- Request API key for higher limits
- Or switch to Option 2 (pre-processed rasters) for high-volume use

**Phase 2: Evaluate Results**
- Compare WorldPop vs GeoNames estimates for gallery images
- Measure processing time impact
- Assess accuracy improvements

**Phase 3: Consider Client-Side** (Future)
- If WorldPop proves significantly better, consider tile-based approach
- Would require infrastructure (tile server) or pre-aggregated data

---

## Data Access

### ✅ **WorldPop REST API** (Recommended for Integration)

**Yes, WorldPop has a REST API!** This is the easiest way to integrate WorldPop without downloading large GeoTIFF files.

**API Endpoint**: `https://api.worldpop.org/v1/services/stats`

**Features**:
- **RESTful API**: Query population data via HTTP requests
- **GeoJSON queries**: Submit polygon boundaries and get population estimates
- **No authentication required**: Free tier with 1,000 API calls per day
- **API key available**: Request key for higher rate limits
- **Multiple datasets**: Access various population datasets (counts, densities, demographics)

**Example API Request**:
```javascript
// Query population for a polygon
const geojson = {
  "type": "Polygon",
  "coordinates": [[[lon1, lat1], [lon2, lat2], ...]]
};

const url = `https://api.worldpop.org/v1/services/stats?` +
  `dataset=wpgppop&` +           // WorldPop Global Population dataset
  `year=2020&` +                  // Year
  `geojson=${encodeURIComponent(JSON.stringify(geojson))}`;

const response = await fetch(url);
const data = await response.json();
// Returns: { "stats": { "sum": 12345, "mean": 12.3, ... } }
```

**Rate Limits**:
- **Free tier**: 1,000 API calls per day (no authentication)
- **With API key**: Higher limits (request via WorldPop website)

**API Documentation**: https://www.worldpop.org/sdi/introapi/

**Advantages**:
- ✅ No need to download/store large GeoTIFF files
- ✅ No raster processing libraries required
- ✅ Simple HTTP requests
- ✅ Handles polygon queries automatically
- ✅ Returns aggregated statistics (sum, mean, etc.)

**Disadvantages**:
- ⚠️ Network dependency (requires internet connection)
- ⚠️ Rate limits (1,000/day free tier)
- ⚠️ Slower than local raster processing (network latency)

### WorldPop Download Sources

**Official Website**: https://www.worldpop.org/
- **Data Portal**: https://www.worldpop.org/geodata/
- **Direct Downloads**: GeoTIFF files per country/year
- **REST API**: https://api.worldpop.org/v1/services/stats (see above)

**Alternative Sources**:
- **Google Earth Engine**: WorldPop available as dataset (requires GEE account)
- **AWS Open Data**: Some WorldPop datasets on S3
- **HDX (Humanitarian Data Exchange)**: https://data.humdata.org/
- **R Package**: `wopr` package for R users (https://data.worldpop.org/repo/git/wopr/)

### Example Download URLs

```
# WorldPop Global 2020 (100m resolution)
https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/USA/usa_ppp_2020_1km_Aggregated.tif

# Per-country structure
https://data.worldpop.org/GIS/Population/Global_2000_2020/{YEAR}/{ISO3}/{iso3}_ppp_{year}_{resolution}_Aggregated.tif
```

**Supported Countries** (for this project):
- `USA`, `CAN`, `COL`, `IND`, `ARG`, `NLD`, `GHA`, `CHE`, `DEU`, `GBR`

---

## Code Example: WorldPop Integration

### Python Script (Server-Side)

```python
import rasterio
from rasterio.mask import mask
from shapely.geometry import shape
import json

def estimate_population_from_worldpop(polygon_geojson, country_code, year=2020):
    """
    Estimate population within a polygon using WorldPop raster.
    
    Args:
        polygon_geojson: GeoJSON polygon geometry
        country_code: ISO3 country code (e.g., 'USA')
        year: Year of WorldPop dataset (default: 2020)
    
    Returns:
        Total population estimate (int) or None if failed
    """
    # Load WorldPop GeoTIFF for country
    worldpop_path = f'data/population/worldpop/{country_code}_{year}.tif'
    
    try:
        with rasterio.open(worldpop_path) as src:
            # Convert GeoJSON to Shapely geometry
            geom = shape(polygon_geojson)
            
            # Mask raster to polygon (extract pixels within polygon)
            out_image, out_transform = mask(src, [geom], crop=True, nodata=0)
            
            # Sum all non-nodata pixels
            total_population = int(out_image.sum())
            
            return total_population if total_population > 0 else None
            
    except Exception as e:
        print(f'WorldPop estimation failed: {e}')
        return None
```

### JavaScript Integration (Gallery Script)

```javascript
// In scripts/generate-gallery-images.js

const { execSync } = require('child_process');
const path = require('path');

async function estimatePopulationFromWorldPop(geometry, countryCode) {
  // Call Python script for WorldPop estimation
  const scriptPath = path.join(__dirname, 'estimate-population-worldpop.py');
  const geomJson = JSON.stringify(geometry);
  
  try {
    const result = execSync(
      `python3 "${scriptPath}" "${countryCode}" '${geomJson}'`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    
    const population = parseInt(result.trim(), 10);
    return isNaN(population) ? null : population;
    
  } catch (e) {
    console.warn('WorldPop estimation failed:', e.message);
    return null;
  }
}

// Updated population estimation with fallback
async function estimatePopulation(polygon, countryCode) {
  // Try WorldPop first
  const worldPop = await estimatePopulationFromWorldPop(polygon.geometry, countryCode);
  if (worldPop !== null) {
    return worldPop;
  }
  
  // Fallback to GeoNames
  return estimatePopulationFromCities(polygon.geometry, countryCode);
}
```

---

## Conclusion

**WorldPop** offers significant advantages over the current GeoNames approach:

✅ **More accurate**: Raster-based polygon population estimation  
✅ **Complete coverage**: Includes rural areas between cities  
✅ **Better for polygons**: Designed for spatial population analysis  

However, it comes with trade-offs:

⚠️ **Complexity**: Requires raster processing libraries  
⚠️ **Storage**: Large files (~200 MB - 2 GB for 10 countries)  
⚠️ **Speed**: Slower than point-in-polygon (~50-500ms vs ~1-10ms)  

**Recommendation**: **Start with WorldPop for gallery generation** (server-side, pre-generated images), while keeping GeoNames for the interactive page (client-side, fast). This provides the best of both worlds: accurate population estimates in the gallery without sacrificing interactive performance.

---

## References

- **WorldPop Official**: https://www.worldpop.org/
- **WorldPop Methods**: https://www.worldpop.org/book-of-methods/
- **Current Implementation**: `scripts/generate-gallery-images.js` → `estimatePopulationFromCities()`
- **GeoNames Data**: `data/geocoder/cities.min.json.gz`
