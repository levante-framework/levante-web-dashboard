#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const MAX_DISTANCE_KM = 20; // Filter out results where nearest city is > 20km
// Throttling / retry tuning for Overpass-backed endpoints
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 800; // base backoff; jitter is added
const CACHE_FILE = path.join(process.cwd(), 'data', 'gallery', 'overpass-cache.json');

const BASE_URL = process.env.BASE_URL || 'https://levante-audio-dashboard.vercel.app';
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'gallery', 'locate-me');
const DATA_FILE = path.join(OUTPUT_DIR, 'gallery-data.json');
const SEED_FILE = path.join(OUTPUT_DIR, 'seed-points.json');
const GEOCODER_PATH = path.join(process.cwd(), 'data', 'geocoder', 'cities.min.json');
const GEOCODER_PATH_GZ = `${GEOCODER_PATH}.gz`;
const MAX_LOCALITY_CANDIDATES = 6000; // cap per-country locality sample to stay compact
const ADM_PACK_DIR = path.join(process.cwd(), 'public', 'adm-packs');

const ALLOWED_COUNTRY_SLUGS = new Set([
  'scotland',
  'usa',
  'canada',
  'colombia',
  'india',
  'argentina',
  'netherlands',
  'ghana',
  'switzerland',
  'germany'
]);

const COUNTRY_SLUG_MAP = {
  US: 'usa',
  USA: 'usa',
  'UNITED STATES': 'usa',
  'UNITED STATES OF AMERICA': 'usa',
  CA: 'canada',
  CANADA: 'canada',
  CO: 'colombia',
  COL: 'colombia',
  COLOMBIA: 'colombia',
  DE: 'germany',
  GER: 'germany',
  DEU: 'germany',
  GERMANY: 'germany',
  'FEDERAL REPUBLIC OF GERMANY': 'germany',
  NL: 'netherlands',
  NLD: 'netherlands',
  NETHERLANDS: 'netherlands',
  'THE NETHERLANDS': 'netherlands',
  SCOTLAND: 'scotland',
  GB: 'scotland',
  UK: 'scotland',
  GH: 'ghana',
  GHANA: 'ghana',
  AR: 'argentina',
  ARGENTINA: 'argentina',
  IN: 'india',
  INDIA: 'india',
  CH: 'switzerland',
  CHE: 'switzerland',
  SWITZERLAND: 'switzerland'
};

const ALLOWED_COUNTRY_CODES = new Set(
  Object.entries(COUNTRY_SLUG_MAP)
    .filter(([, slug]) => ALLOWED_COUNTRY_SLUGS.has(slug))
    .map(([code]) => code)
    .filter((code) => /^[A-Z]{2,3}$/.test(code))
);

const SLUG_TO_COUNTRY = {
  usa: 'US',
  canada: 'CA',
  colombia: 'CO',
  germany: 'DE',
  netherlands: 'NL',
  scotland: 'GB',
  ghana: 'GH',
  argentina: 'AR',
  india: 'IN',
  switzerland: 'CH'
};

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// --- Local, compact geocoder helpers (Step 1 + Step 2) ---
let geoData = null;
let countryBounds = null;
const countrySlices = new Map();

function loadGeocoderData() {
  if (geoData) return geoData;
  if (fs.existsSync(GEOCODER_PATH_GZ)) {
    geoData = JSON.parse(zlib.gunzipSync(fs.readFileSync(GEOCODER_PATH_GZ)).toString());
  } else if (fs.existsSync(GEOCODER_PATH)) {
    geoData = JSON.parse(fs.readFileSync(GEOCODER_PATH, 'utf8'));
  } else {
    throw new Error('Geocoder dataset not found (cities.min.json[.gz])');
  }
  return geoData;
}

function buildCountryBounds() {
  if (countryBounds) return countryBounds;
  const data = loadGeocoderData();
  const bounds = new Map();
  for (const row of data) {
    if (!row.country || !ALLOWED_COUNTRY_CODES.has(row.country)) continue;
    const b = bounds.get(row.country) || {
      minLat: row.lat, maxLat: row.lat, minLon: row.lon, maxLon: row.lon, count: 0
    };
    b.minLat = Math.min(b.minLat, row.lat);
    b.maxLat = Math.max(b.maxLat, row.lat);
    b.minLon = Math.min(b.minLon, row.lon);
    b.maxLon = Math.max(b.maxLon, row.lon);
    b.count += 1;
    bounds.set(row.country, b);
  }
  countryBounds = bounds;
  return countryBounds;
}

function distanceKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat +
    sinDLon * sinDLon * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function coarseCountryLookup(lat, lon) {
  const bounds = buildCountryBounds();
  for (const [code, b] of bounds.entries()) {
    if (lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon) {
      return code;
    }
  }
  // fallback: nearest centroid
  let best = null;
  let bestDist = Infinity;
  for (const [code, b] of bounds.entries()) {
    const centroid = { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
    const d = distanceKm({ lat, lon }, centroid);
    if (d < bestDist) {
      bestDist = d;
      best = code;
    }
  }
  return best;
}

function getCountrySlice(country) {
  if (!country || !ALLOWED_COUNTRY_CODES.has(country)) return [];
  if (countrySlices.has(country)) return countrySlices.get(country);
  const data = loadGeocoderData();
  let slice = data
    .filter((row) => row.country === country)
    .filter((row) => typeof row.lat === 'number' && typeof row.lon === 'number');
  slice.sort((a, b) => (b.population || 0) - (a.population || 0));
  if (slice.length > MAX_LOCALITY_CANDIDATES) {
    slice = slice.slice(0, MAX_LOCALITY_CANDIDATES);
  }
  countrySlices.set(country, slice);
  return slice;
}

function nearestLocality(lat, lon, country) {
  if (!country || !ALLOWED_COUNTRY_CODES.has(country)) return null;
  const slice = getCountrySlice(country);
  if (!slice.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const city of slice) {
    const d = distanceKm({ lat, lon }, { lat: city.lat, lon: city.lon });
    if (d < bestDist) {
      bestDist = d;
      best = city;
    }
  }
  if (!best) return null;
  return {
    name: best.name || best.ascii || 'Unknown',
    admin1: best.admin1 || null,
    admin2: best.admin2 || null,
    country: best.country,
    lat: best.lat,
    lon: best.lon,
    population: best.population,
    distanceKm: bestDist,
    source: 'local-geocoder'
  };
}

// Simple on-disk cache to avoid re-hitting Overpass-backed endpoints when rerunning

// --- ADM pack helpers (local polygons; no GPS sent remotely) ---
const admPackCache = new Map();

function pointInRing(pt, ring) {
  const [px, py] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(pt, geom) {
  if (!geom) return false;
  const type = geom.type;
  const polys =
    type === 'Polygon'
      ? [geom.coordinates]
      : type === 'MultiPolygon'
      ? geom.coordinates
      : [];
  if (!polys.length) return false;
  for (const poly of polys) {
    if (!poly || !poly.length) continue;
    const [outer, ...holes] = poly;
    if (!outer || !outer.length) continue;
    if (!pointInRing(pt, outer)) continue;
    let inHole = false;
    for (const hole of holes) {
      if (hole && hole.length && pointInRing(pt, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function polygonArea(geom) {
  const ringArea = (ring = []) => {
    let sum = 0;
    for (let i = 0, len = ring.length; i < len; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % len];
      sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum / 2);
  };
  if (!geom) return Infinity;
  const type = geom.type;
  const polys =
    type === 'Polygon'
      ? [geom.coordinates]
      : type === 'MultiPolygon'
      ? geom.coordinates
      : [];
  let total = 0;
  for (const poly of polys) {
    if (!poly || !poly.length) continue;
    const [outer, ...holes] = poly;
    total += ringArea(outer || []);
    for (const hole of holes) {
      total -= ringArea(hole || []);
    }
  }
  return total || Infinity;
}

function loadAdmPack(countryCode) {
  const code = (countryCode || '').toLowerCase();
  if (!code) return null;
  if (admPackCache.has(code)) return admPackCache.get(code);
  const filePath = path.join(ADM_PACK_DIR, `${code}.json`);
  if (!fs.existsSync(filePath)) {
    admPackCache.set(code, null);
    return null;
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  admPackCache.set(code, data);
  return data;
}

function lookupAdmPolygon(countryCode, lat, lon) {
  const pack = loadAdmPack(countryCode);
  if (!pack || !pack.features) return null;
  const pt = [lon, lat];
  let best = null;
  let bestArea = Infinity;
  for (const feature of pack.features) {
    if (!feature?.geometry) continue;
    if (pointInPolygon(pt, feature.geometry)) {
      const area = polygonArea(feature.geometry);
      if (area < bestArea) {
        bestArea = area;
        best = feature;
      }
    }
  }
  return best;
}

// Simple on-disk cache to avoid re-hitting Overpass-backed endpoints when rerunning
function ensureCacheDir() {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureCacheDir();
let cache = {};
try {
  if (fs.existsSync(CACHE_FILE)) {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  }
} catch (err) {
  console.warn(`⚠️  Failed to read cache ${CACHE_FILE}: ${err.message}`);
  cache = {};
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn(`⚠️  Failed to write cache ${CACHE_FILE}: ${err.message}`);
  }
}

function cacheKey(url) {
  return url;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

async function fetchJSONWithRetry(url, label) {
  const key = cacheKey(url);
  if (cache[key]) {
    return cache[key];
  }

  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      const result = await fetchJSON(url);
      cache[key] = result;
      saveCache();
      return result;
    } catch (err) {
      attempt += 1;
      const isRetryable =
        /HTTP 429/.test(err.message) ||
        /HTTP 5\d{2}/.test(err.message) ||
        /ECONNRESET/.test(err.message) ||
        /ETIMEDOUT/.test(err.message);

      if (!isRetryable || attempt > MAX_RETRIES) {
        throw err;
      }

      const backoff = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 200);
      const sleep = backoff + jitter;
      console.warn(`  ⚠️  ${label}: attempt ${attempt} failed (${err.message}). Retrying in ${sleep}ms...`);
      await delay(sleep);
    }
  }
}

function mapCountrySlug(value) {
  if (!value) return null;
  const raw = value.toString().trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (ALLOWED_COUNTRY_SLUGS.has(lower)) {
    return lower;
  }
  const upper = raw.toUpperCase();
  const slug = COUNTRY_SLUG_MAP[upper];
  if (slug && ALLOWED_COUNTRY_SLUGS.has(slug)) {
    return slug;
  }
  return null;
}

function loadSeedPoints() {
  if (!fs.existsSync(SEED_FILE)) {
    throw new Error(`Seed point file not found: ${SEED_FILE}`);
  }
  const payload = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const rawPoints = Array.isArray(payload) ? payload : payload.points;
  if (!rawPoints || !rawPoints.length) {
    throw new Error(`Seed file ${SEED_FILE} does not contain any points.`);
  }

  const normalized = rawPoints
    .map((point, idx) => {
      const slug = mapCountrySlug(point.country);
      if (!slug) {
        console.warn(`⚠️  Skipping seed point ${point.id || idx} (unsupported country ${point.country})`);
        return null;
      }
      if (typeof point.lat !== 'number' || typeof point.lon !== 'number') {
        console.warn(`⚠️  Skipping seed point ${point.id || idx} (invalid coordinates)`);
        return null;
      }
      return {
        id: point.id || `seed-${idx + 1}`,
        label: point.label || point.id || `Seed ${idx + 1}`,
        country: point.country,
        slug,
        lat: point.lat,
        lon: point.lon
      };
    })
    .filter(Boolean);

  if (!normalized.length) {
    throw new Error('No usable seed points after filtering. Please update seed-points.json.');
  }
  return normalized;
}

async function processPoint(point, index, total) {
  console.log(`[${index + 1}/${total}] Processing ${point.id} (${point.country})...`);
  
  try {
    // Local coarse country/admin hint (tiny on-disk index -> country -> per-country slice)
    let coarseCountry = coarseCountryLookup(point.lat, point.lon);
    if (!coarseCountry) {
      const fallbackSlug = mapCountrySlug(point.country) || point.slug;
      const fallbackCode = fallbackSlug ? SLUG_TO_COUNTRY[fallbackSlug] : null;
      if (fallbackCode && ALLOWED_COUNTRY_CODES.has(fallbackCode)) {
        coarseCountry = fallbackCode;
      }
    }
    const localAdmin = coarseCountry ? nearestLocality(point.lat, point.lon, coarseCountry) : null;

    // Step 1: Reverse geocode with 20km limit
    const geocodeUrl = `${BASE_URL}/api/reverse-geocode?lat=${point.lat}&lon=${point.lon}&limit=2&maxDistanceKm=${MAX_DISTANCE_KM}`;
    const geocodeData = await fetchJSONWithRetry(geocodeUrl, `Geocode ${point.id}`);
    
    if (!geocodeData.results || geocodeData.results.length === 0) {
      console.warn(`  ⚠️  No results within ${MAX_DISTANCE_KM}km for ${point.id}`);
      return null;
    }
    
    // Filter: nearest location must be <= 20km
    const nearestDistance = geocodeData.results[0]?.distanceKm;
    if (nearestDistance === undefined || nearestDistance > MAX_DISTANCE_KM) {
      console.warn(`  ⚠️  Nearest location (${nearestDistance?.toFixed(1)}km) exceeds ${MAX_DISTANCE_KM}km for ${point.id}`);
      return null;
    }
    
    const results = geocodeData.results.slice(0, 2);
    
    // Step 2: Get polygons for each result using local ADM pack
    const polygons = [];
    for (const result of results) {
      try {
        const poly = lookupAdmPolygon(result.country, result.lat, result.lon);
        polygons.push({ city: result, polygon: poly });
      } catch (err) {
        console.warn(`  ⚠️  Failed to get polygon for ${result.name}: ${err.message}`);
        polygons.push({ city: result, polygon: null });
      }
    }
    
    // Step 3: Get administrative area polygon for the GPS point itself (local pack)
    console.log(`  [${point.id}] Starting admin area lookup (local pack)...`);
    let adminArea = null;
    try {
      const poly = lookupAdmPolygon(point.country, point.lat, point.lon);
      if (poly) {
        const name = poly.properties?.name || poly.properties?.tags?.name || poly.properties?.tags?.['name:en'] || 'Unknown';
        const population = poly.properties?.population || poly.properties?.tags?.population || null;
        adminArea = {
          polygon: poly,
          adminLevel: poly.properties?.admin_level || null,
          name,
          population: population ? parseInt(population, 10) : null
        };
        console.log(`  [${point.id}] ✓ Admin area found: ${name}`);
      } else {
        console.log(`  [${point.id}] ⚠️  No admin polygon in local pack`);
      }
    } catch (err) {
      console.warn(`  [${point.id}] ⚠️  Exception getting admin area: ${err.message}`);
    }
    
    console.log(`  [${point.id}] Final adminArea value before return:`, adminArea ? `SET (${adminArea.name})` : (adminArea === null ? 'NULL' : 'UNDEFINED'));
    const result = {
      point,
      geocode: geocodeData,
      polygons,
      coarseCountry: coarseCountry || null,
      locality: localAdmin || null,
      adminArea: adminArea || null,  // Explicitly set to null if undefined
      metrics: geocodeData.metrics || null
    };
    console.log(`  [${point.id}] Returning result. Keys:`, Object.keys(result), `adminArea in result:`, 'adminArea' in result, `value:`, result.adminArea ? 'SET' : (result.adminArea === null ? 'NULL' : 'UNDEFINED'));
    return result;
  } catch (error) {
    console.error(`  ❌ Error processing ${point.id}: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('🎯 Generating Locate Me Gallery');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Output directory: ${OUTPUT_DIR}\n`);
  const points = loadSeedPoints();
  console.log(`📍 Loaded ${points.length} curated GPS points from seed file\n`);
  
  // Process each point
  console.log('🔄 Processing points through Locate-Me workflow...\n');
  const results = [];
  
  for (let i = 0; i < points.length; i++) {
    const result = await processPoint(points[i], i, points.length);
    if (result) {
      results.push(result);
    }
    
    // Small delay to avoid rate limiting
    if (i < points.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log(`\n✅ Processed ${results.length}/${points.length} points successfully\n`);
  
  // Save data
  const galleryData = {
    generated: new Date().toISOString(),
    baseUrl: BASE_URL,
    total: results.length,
    results: results
  };
  
  fs.writeFileSync(DATA_FILE, JSON.stringify(galleryData, null, 2));
  console.log(`💾 Saved gallery data to ${DATA_FILE}`);
  console.log(`\n📸 Next step: Run 'node scripts/generate-gallery-images.js' to create images`);
}

if (require.main === module) {
  main().catch(console.error);
}


