#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

const MAX_DISTANCE_KM = 20; // Filter out results where nearest city is > 20km (unless seed point has allowFar=true)
// Throttling / retry tuning for Overpass-backed endpoints
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 800; // base backoff; jitter is added
const CACHE_FILE = path.join(process.cwd(), 'data', 'gallery', 'overpass-cache.json');

// Use deployment URL if alias isn't working yet
const BASE_URL = process.env.BASE_URL || process.env.DEPLOYMENT_URL || 'https://levante-pitwall.vercel.app';
const USE_GEOBOUNDARIES = process.env.USE_GEOBOUNDARIES === 'true' || process.env.USE_GEOBOUNDARIES === '1';
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'gallery', 'locate-me');
const DATA_FILE = path.join(OUTPUT_DIR, 'gallery-data.json');
const SEED_FILE = path.join(OUTPUT_DIR, 'seed-points.json');
const GEOCODER_PATH = path.join(process.cwd(), 'data', 'geocoder', 'cities.min.json');
const GEOCODER_PATH_GZ = `${GEOCODER_PATH}.gz`;
const MAX_LOCALITY_CANDIDATES = 6000; // cap per-country locality sample to stay compact
const ADM_PACK_DIR = path.join(process.cwd(), 'public', 'adm-packs');
const ADM0_PATH_GZ = path.join(process.cwd(), 'public', 'adm0', 'countries.min.json.gz');

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

// ISO2 to ISO3 mapping for GeoBoundaries
const ISO2_TO_ISO3 = new Map([
  ['US', 'USA'],
  ['CA', 'CAN'],
  ['CO', 'COL'],
  ['IN', 'IND'],
  ['AR', 'ARG'],
  ['NL', 'NLD'],
  ['GH', 'GHA'],
  ['CH', 'CHE'],
  ['DE', 'DEU'],
  ['GB', 'GBR']
]);

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// --- Local, compact geocoder helpers (Step 1 + Step 2) ---
let geoData = null;
let countryBounds = null;
const countrySlices = new Map();
let countriesFc = null;

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

function loadCountries() {
  if (countriesFc) return countriesFc;
  if (!fs.existsSync(ADM0_PATH_GZ)) {
    throw new Error(`ADM0 dataset missing at ${ADM0_PATH_GZ}. Run node scripts/adm/build-adm0.js`);
  }
  const raw = zlib.gunzipSync(fs.readFileSync(ADM0_PATH_GZ)).toString();
  const fc = JSON.parse(raw);
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('ADM0 dataset malformed');
  }
  countriesFc = fc;
  return countriesFc;
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

function nearestLocalities(lat, lon, country, limit = 2, maxDistanceKm = MAX_DISTANCE_KM) {
  if (!country || !ALLOWED_COUNTRY_CODES.has(country)) return [];
  const slice = getCountrySlice(country);
  if (!slice.length) return [];
  const hits = [];
  for (const city of slice) {
    const d = distanceKm({ lat, lon }, { lat: city.lat, lon: city.lon });
    if (!Number.isFinite(d) || d > maxDistanceKm) continue;
    hits.push({
      name: city.name || city.ascii || 'Unknown',
      admin1: city.admin1 || null,
      admin2: city.admin2 || null,
      country: city.country,
      lat: city.lat,
      lon: city.lon,
      population: city.population,
      distanceKm: d,
      source: 'local-geocoder'
    });
  }
  hits.sort((a, b) => a.distanceKm - b.distanceKm);
  return hits.slice(0, limit);
}

// Simple on-disk cache to avoid re-hitting Overpass-backed endpoints when rerunning

// --- ADM pack helpers (local polygons; no GPS sent remotely) ---
const admPackCache = new Map(); // key: `${iso2}|${level}` -> FeatureCollection|null

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

function adm0CountryLookup(lat, lon) {
  const fc = loadCountries();
  const pt = [lon, lat];
  let best = null;
  let bestArea = Infinity;
  for (const feature of fc.features) {
    if (!feature?.geometry) continue;
    if (!pointInPolygon(pt, feature.geometry)) continue;
    const area = polygonArea(feature.geometry);
    if (area < bestArea) {
      bestArea = area;
      best = feature;
    }
  }
  const iso2 = best?.properties?.iso2;
  return iso2 ? String(iso2).trim().toUpperCase() : null;
}

function loadAdmPack(countryCode, level) {
  const code = (countryCode || '').toString().trim().toLowerCase();
  const lvl = (level || '').toString().trim().toLowerCase(); // adm1|adm2
  if (!code || !lvl) return null;
  const key = `${code}|${lvl}`;
  if (admPackCache.has(key)) return admPackCache.get(key);
  const filePath = path.join(ADM_PACK_DIR, code, `${lvl}.json.gz`);
  if (!fs.existsSync(filePath)) {
    admPackCache.set(key, null);
    return null;
  }
  const raw = zlib.gunzipSync(fs.readFileSync(filePath)).toString();
  const data = JSON.parse(raw);
  admPackCache.set(key, data);
  return data;
}

function loadUsAdm3Pack(stateAbbr) {
  const st = (stateAbbr || '').toString().trim().toLowerCase();
  if (!st) return null;
  const key = `us|adm3|${st}`;
  if (admPackCache.has(key)) return admPackCache.get(key);
  const filePath = path.join(ADM_PACK_DIR, 'us', 'adm3', `${st}.json.gz`);
  if (!fs.existsSync(filePath)) {
    admPackCache.set(key, null);
    return null;
  }
  const raw = zlib.gunzipSync(fs.readFileSync(filePath)).toString();
  const data = JSON.parse(raw);
  admPackCache.set(key, data);
  return data;
}

function lookupAdmPolygon(countryCode, level, lat, lon) {
  const pack = loadAdmPack(countryCode, level);
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

function fetchJsonHttps(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    
    let timeout = setTimeout(() => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    
    const req = client.get(url, (res) => {
      clearTimeout(timeout);
      if (res.statusCode !== 200) {
        // Consume response body to prevent leaks
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
    });
    
    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      clearTimeout(timeout);
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    });
  });
}

async function lookupGeoBoundariesAreas(countryIso2Upper, lat, lon) {
  // GeoBoundaries: Try ADM4 first, then ADM3, then ADM2
  // Regional: ADM2 (always available)
  const iso3 = ISO2_TO_ISO3.get(countryIso2Upper);
  if (!iso3) {
    console.warn(`GeoBoundaries: No ISO3 mapping for ${countryIso2Upper}`);
    return { local: null, regional: null };
  }

  const baseUrl = process.env.GEOBOUNDARIES_API_URL || BASE_URL;
  const adm2Url = `${baseUrl}/api/geoboundaries-polygon?lat=${lat}&lon=${lon}&country=${iso3}&level=2`;
  const adm3Url = `${baseUrl}/api/geoboundaries-polygon?lat=${lat}&lon=${lon}&country=${iso3}&level=3`;
  const adm4Url = `${baseUrl}/api/geoboundaries-polygon?lat=${lat}&lon=${lon}&country=${iso3}&level=4`;

  try {
    console.log(`  🌍 Fetching GeoBoundaries for ${iso3} (ADM2, ADM3, ADM4)...`);
    
    // Try ADM4, ADM3, and ADM2 in parallel
    const [adm2Res, adm3Res, adm4Res] = await Promise.all([
      fetchJsonHttps(adm2Url, 30000).catch((err) => {
        console.warn(`  ⚠️  GeoBoundaries ADM2 failed for ${iso3}: ${err.message}`);
        return null;
      }),
      fetchJsonHttps(adm3Url, 30000).catch((err) => {
        // ADM3 might not be available - that's OK
        return null;
      }),
      fetchJsonHttps(adm4Url, 30000).catch((err) => {
        // ADM4 might not be available - that's OK
        return null;
      })
    ]);

    // Handle error responses
    if (adm2Res?.error) {
      console.warn(`  ⚠️  GeoBoundaries ADM2: ${adm2Res.message || adm2Res.error}`);
    }
    if (adm3Res?.error) {
      // ADM3 not available is expected for many countries
    }
    if (adm4Res?.error) {
      // ADM4 not available is expected for most countries
    }

    const adm2Feature = adm2Res?.feature || null;
    const adm3Feature = adm3Res?.feature || null;
    const adm4Feature = adm4Res?.feature || null;

    // Use ADM4 if available, otherwise ADM3, otherwise null
    const localFeature = adm4Feature || adm3Feature || null;
    const localLevel = adm4Feature ? 4 : (adm3Feature ? 3 : null);
    const localName = adm4Res?.name || adm3Res?.name || localFeature?.properties?.shapeName || null;

    if (adm2Feature || localFeature) {
      console.log(`  ✅ GeoBoundaries: ADM2=${!!adm2Feature}, Local=${localLevel ? `ADM${localLevel}` : 'none'}`);
    } else {
      console.warn(`  ⚠️  GeoBoundaries: No features found for ${iso3}`);
    }

    return {
      local: localFeature
        ? { polygon: localFeature, adminLevel: localLevel, name: localName || 'Unknown' }
        : null,
      regional: adm2Feature
        ? { polygon: adm2Feature, adminLevel: 2, name: adm2Res?.name || adm2Feature?.properties?.shapeName || 'Unknown' }
        : null
    };
  } catch (error) {
    console.warn(`  ⚠️  GeoBoundaries lookup failed for ${iso3}:`, error.message);
    return { local: null, regional: null };
  }
}

function lookupTwoLevelAreas(countryIso2Lower, lat, lon, hintAdmin1 = null) {
  // Option (1): local boundary = smallest available admin level (try ADM5→ADM4→ADM3).
  // Regional boundary = ADM2.
  const pt = [lon, lat];

  const adm2Pack = loadAdmPack(countryIso2Lower, 'adm2');

  const bestContaining = (pack) => {
    if (!pack || !pack.features) return null;
    let best = null;
    let bestArea = Infinity;
    for (const feature of pack.features) {
      if (!feature?.geometry) continue;
      if (!pointInPolygon(pt, feature.geometry)) continue;
      const area = polygonArea(feature.geometry);
      if (!Number.isFinite(area)) continue;
      if (area < bestArea) {
        bestArea = area;
        best = feature;
      }
    }
    return best;
  };

  const adm2 = bestContaining(adm2Pack);
  let localFeature = null;
  let localLevel = null;
  if (countryIso2Lower === 'us') {
    const usPack = loadUsAdm3Pack(hintAdmin1);
    const f = bestContaining(usPack);
    if (f) {
      localFeature = f;
      localLevel = 3;
    }
  } else {
    for (const lvl of ['adm4', 'adm3']) {
      const pack = loadAdmPack(countryIso2Lower, lvl);
      const f = bestContaining(pack);
      if (f) {
        localFeature = f;
        localLevel = lvl === 'adm3' ? 3 : 4;
        break;
      }
    }
  }

  const blue = adm2 || null;                // Regional (ADM2)
  const red = localFeature || adm2 || null; // Local, fallback to ADM2 so red is always present when ADM2 exists

  return {
    local: blue
      ? { polygon: blue, adminLevel: 2, name: blue?.properties?.name || 'Unknown' }
      : null,
    regional: red
      ? { polygon: red, adminLevel: localFeature ? localLevel : 2, name: red?.properties?.name || 'Unknown' }
      : null
  };
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
        lon: point.lon,
        allowFar: !!point.allowFar
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
    // ADM0 seed (local point-in-polygon)
    const seededCountry = adm0CountryLookup(point.lat, point.lon);
    const fallbackCountry = (point.country || '').toString().trim().toUpperCase();
    let coarseCountry =
      (seededCountry && ALLOWED_COUNTRY_CODES.has(seededCountry) ? seededCountry : null) ||
      (fallbackCountry && ALLOWED_COUNTRY_CODES.has(fallbackCountry) ? fallbackCountry : null) ||
      null;
    if (!coarseCountry) {
      const fallbackSlug = mapCountrySlug(point.country) || point.slug;
      const fallbackCode = fallbackSlug ? SLUG_TO_COUNTRY[fallbackSlug] : null;
      if (fallbackCode && ALLOWED_COUNTRY_CODES.has(fallbackCode)) {
        coarseCountry = fallbackCode;
      }
    }
    if (!coarseCountry) {
      coarseCountry = coarseCountryLookup(point.lat, point.lon);
    }

    const localAdmin = coarseCountry ? nearestLocality(point.lat, point.lon, coarseCountry) : null;

    // Step 1: On-device reverse geocode (no network)
    const lookupStart = process.hrtime.bigint();
    const maxDistanceKm = point.allowFar ? 500 : MAX_DISTANCE_KM;
    const results = coarseCountry
      ? nearestLocalities(point.lat, point.lon, coarseCountry, 2, maxDistanceKm)
      : [];
    const lookupMs = Number((process.hrtime.bigint() - lookupStart) / 1000000n);

    if (!results.length) {
      console.warn(`  ⚠️  No results within ${maxDistanceKm}km for ${point.id}${point.allowFar ? ' (allowFar)' : ''}`);
      return null;
    }

    // Filter: nearest location must be <= MAX_DISTANCE_KM (unless allowFar)
    const nearestDistance = results[0]?.distanceKm;
    if (!point.allowFar && (nearestDistance === undefined || nearestDistance > MAX_DISTANCE_KM)) {
      console.warn(
        `  ⚠️  Nearest location (${nearestDistance?.toFixed(1)}km) exceeds ${MAX_DISTANCE_KM}km for ${point.id}`
      );
      return null;
    }

    const geocodeData = {
      lat: point.lat,
      lon: point.lon,
      results: results.map((r) => ({ ...r, distanceKm: Math.round(r.distanceKm * 10) / 10 })),
      metrics: {
        datasetFile: 'cities.min.json.gz',
        lookupMs,
        seedCountry: coarseCountry,
        seedMethod: seededCountry ? 'adm0' : 'seed-file',
        source: 'local'
      }
    };

    // Step 2/3: ADM polygons for the GPS point itself (local packs or GeoBoundaries API)
    const countryForPacks = (coarseCountry || '').toString().trim().toLowerCase();
    const countryForPacksUpper = (coarseCountry || '').toString().trim().toUpperCase();
    const admin1Hint = geocodeData?.results?.[0]?.admin1 || null;
    
    let local, regional;
    if (USE_GEOBOUNDARIES) {
      const result = await lookupGeoBoundariesAreas(countryForPacksUpper, point.lat, point.lon);
      local = result?.local || null;
      regional = result?.regional || null;
    } else {
      const result = lookupTwoLevelAreas(countryForPacks, point.lat, point.lon, admin1Hint);
      local = result.local;
      regional = result.regional;
    }
    
    // For gallery rendering:
    // - Blue (cityArea): ADM2 (regional) - GADM or GeoBoundaries ADM2
    // - Red (adminArea): Local = ADM3/4 (GADM) or ADM4 (GeoBoundaries)
    const cityArea = local || null;
    const adminArea = regional || null;

    // Keep legacy `polygons` array for the gallery UI, but make it represent the GPS-point ADM2 boundary.
    const polygons = [
      { city: geocodeData.results[0], polygon: cityArea?.polygon || null },
      geocodeData.results[1] ? { city: geocodeData.results[1], polygon: null } : null
    ].filter(Boolean);

    const result = {
      point,
      geocode: geocodeData,
      polygons,
      coarseCountry: coarseCountry || null,
      locality: localAdmin || null,
      adminArea: adminArea || null,  // Explicitly set to null if undefined
      cityArea: cityArea || null,
      metrics: geocodeData.metrics || null
    };
    return result;
  } catch (error) {
    console.error(`  ❌ Error processing ${point.id}: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('🎯 Generating Locate Me Gallery');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Using GeoBoundaries: ${USE_GEOBOUNDARIES ? 'YES (ADM2/ADM4)' : 'NO (GADM ADM2/ADM3)'}`);
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


