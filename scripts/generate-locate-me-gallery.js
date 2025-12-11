#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const MAX_DISTANCE_KM = 20; // Filter out results where nearest city is > 20km
// Throttling / retry tuning for Overpass-backed endpoints
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 800; // base backoff; jitter is added
const CACHE_FILE = path.join(process.cwd(), 'data', 'gallery', 'overpass-cache.json');

const BASE_URL = process.env.BASE_URL || 'https://levante-audio-dashboard.vercel.app';
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'gallery', 'locate-me');
const DATA_FILE = path.join(OUTPUT_DIR, 'gallery-data.json');
const SEED_FILE = path.join(OUTPUT_DIR, 'seed-points.json');

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

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
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
    
    // Step 2: Get polygons for each result
    const polygons = [];
    for (const result of results) {
      try {
        const polygonSlug = mapCountrySlug(result.country);
        if (!polygonSlug) {
          console.warn(`  ⚠️  Skipping polygon for ${result.name} (${result.country}) - unsupported country`);
          continue;
        }
        const polygonUrl = `${BASE_URL}/api/gadm-polygon?country=${polygonSlug}&lat=${result.lat}&lon=${result.lon}`;
        const polygonData = await fetchJSONWithRetry(polygonUrl, `Polygon ${result.name || result.id || point.id}`);
        polygons.push({
          city: result,
          polygon: polygonData.feature
        });
      } catch (err) {
        console.warn(`  ⚠️  Failed to get polygon for ${result.name}: ${err.message}`);
        polygons.push({
          city: result,
          polygon: null
        });
      }
    }
    
    // Step 3: Get administrative area polygon for the GPS point itself
    console.log(`  [${point.id}] Starting admin area query...`);
    let adminArea = null;
    try {
      const adminSlug = point.slug || mapCountrySlug(point.country);
      if (!adminSlug) {
        console.warn(`  ⚠️  Seed point ${point.id} uses unsupported country ${point.country}`);
        return null;
      }
      const adminUrl = `${BASE_URL}/api/gadm-polygon?country=${adminSlug}&lat=${point.lat}&lon=${point.lon}`;
      console.log(`  [${point.id}] Querying admin area: ${adminUrl}`);
      const adminData = await fetchJSONWithRetry(adminUrl, `Admin ${point.id}`);
      console.log(`  [${point.id}] Admin response received. Error: ${adminData.error || 'none'}, Has feature: ${!!adminData.feature}`);
      if (adminData.feature) {
        // Extract name from various possible locations
        const name = adminData.feature.properties?.name || 
                    adminData.feature.properties?.tags?.name || 
                    adminData.feature.properties?.tags?.['name:en'] ||
                    'Unknown';
        // Extract population
        const population = adminData.feature.properties?.population || 
                          adminData.feature.properties?.tags?.population ||
                          adminData.feature.properties?.tags?.['population:date'] ||
                          null;
        adminArea = {
          polygon: adminData.feature,
          adminLevel: adminData.adminLevel,
          name: name,
          population: population ? parseInt(population, 10) : null
        };
        console.log(`  [${point.id}] ✓ Admin area found: ${name} (level ${adminData.adminLevel})`);
      } else {
        console.log(`  [${point.id}] ⚠️  No feature in admin area response`);
      }
      console.log(`  [${point.id}] Admin area after query:`, adminArea ? `SET (${adminArea.name})` : 'NULL');
    } catch (err) {
      console.warn(`  [${point.id}] ⚠️  Exception getting admin area: ${err.message}`);
      console.warn(`  [${point.id}] Error stack:`, err.stack?.substring(0, 200));
    }
    
    console.log(`  [${point.id}] Final adminArea value before return:`, adminArea ? `SET (${adminArea.name})` : (adminArea === null ? 'NULL' : 'UNDEFINED'));
    const result = {
      point,
      geocode: geocodeData,
      polygons,
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


