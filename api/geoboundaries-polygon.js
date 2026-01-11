const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const area = require('@turf/area').default;
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const { Storage } = require('@google-cloud/storage');
const { Storage } = require('@google-cloud/storage');

const GEOBOUNDARIES_BASE_URL = 'https://www.geoboundaries.org/api/current/gbOpen';
// Use Google Cloud Storage bucket for large files (avoids GitHub size limits)
const GEOBOUNDARIES_BUCKET = process.env.GEOBOUNDARIES_BUCKET || 'levante-geoboundaries';
const GEOBOUNDARIES_BUCKET_PREFIX = 'geoboundaries';
// Fallback to local directory for development
const GEOBOUNDARIES_CACHE_DIR = path.join(process.cwd(), 'data', 'geoboundaries');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (not used for pre-downloaded files)

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

const COUNTRY_SYNONYMS = new Map([
  ['usa', 'USA'],
  ['us', 'USA'],
  ['united states', 'USA'],
  ['canada', 'CAN'],
  ['ca', 'CAN'],
  ['colombia', 'COL'],
  ['co', 'COL'],
  ['india', 'IND'],
  ['in', 'IND'],
  ['argentina', 'ARG'],
  ['ar', 'ARG'],
  ['netherlands', 'NLD'],
  ['nl', 'NLD'],
  ['ghana', 'GHA'],
  ['gh', 'GHA'],
  ['switzerland', 'CHE'],
  ['ch', 'CHE'],
  ['germany', 'DEU'],
  ['de', 'DEU'],
  ['united kingdom', 'GBR'],
  ['gb', 'GBR'],
  ['uk', 'GBR']
]);

const SUPPORTED_COUNTRIES = new Set(Array.from(ISO2_TO_ISO3.values()));

function normalizeCountry(input) {
  const lower = (input || '').trim().toLowerCase();
  if (COUNTRY_SYNONYMS.has(lower)) {
    return COUNTRY_SYNONYMS.get(lower);
  }
  const upper = (input || '').trim().toUpperCase();
  if (ISO2_TO_ISO3.has(upper)) {
    return ISO2_TO_ISO3.get(upper);
  }
  if (SUPPORTED_COUNTRIES.has(upper)) {
    return upper;
  }
  return null;
}

function ensureCacheDir() {
  if (!fs.existsSync(GEOBOUNDARIES_CACHE_DIR)) {
    fs.mkdirSync(GEOBOUNDARIES_CACHE_DIR, { recursive: true });
  }
}

function getCachePath(iso3, level) {
  return path.join(GEOBOUNDARIES_CACHE_DIR, `${iso3}_ADM${level}.json.gz`);
}

async function loadCachedGeoBoundaries(iso3, level) {
  // Try GCS bucket first (production)
  if (GEOBOUNDARIES_BUCKET && GEOBOUNDARIES_BUCKET !== 'levante-geoboundaries' || process.env.VERCEL) {
    try {
      const storage = new Storage();
      const bucket = storage.bucket(GEOBOUNDARIES_BUCKET);
      const fileName = `${GEOBOUNDARIES_BUCKET_PREFIX}/${iso3}_ADM${level}.json.gz`;
      const file = bucket.file(fileName);
      
      const [exists] = await file.exists();
      if (exists) {
        console.log(`geoboundaries-polygon: Loading from GCS: ${fileName}`);
        const [buf] = await file.download();
        const json = zlib.gunzipSync(buf).toString('utf8');
        return JSON.parse(json);
      }
    } catch (error) {
      // Fallback to local file if GCS fails
      console.warn(`geoboundaries-polygon: GCS load failed, trying local: ${error.message}`);
    }
  }
  
  // Fallback to local file (development)
  const cachePath = getCachePath(iso3, level);
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  
  try {
    const stats = fs.statSync(cachePath);
    const age = Date.now() - stats.mtimeMs;
    if (age > CACHE_TTL_MS) {
      return null; // Cache expired
    }
    
    const buf = fs.readFileSync(cachePath);
    const json = zlib.gunzipSync(buf).toString('utf8');
    return JSON.parse(json);
  } catch (error) {
    console.warn(`geoboundaries-polygon: Failed to load cache for ${iso3} ADM${level}:`, error.message);
    return null;
  }
}

function saveCachedGeoBoundaries(iso3, level, geojson) {
  try {
    ensureCacheDir();
    const cachePath = getCachePath(iso3, level);
    const json = JSON.stringify(geojson);
    const compressed = zlib.gzipSync(json);
    fs.writeFileSync(cachePath, compressed);
  } catch (error) {
    console.warn(`geoboundaries-polygon: Failed to save cache for ${iso3} ADM${level}:`, error.message);
  }
}

function downloadGeoBoundaries(iso3, level) {
  return new Promise((resolve, reject) => {
    const url = `${GEOBOUNDARIES_BASE_URL}/${iso3}/ADM${level}/`;
    console.log(`geoboundaries-polygon: Fetching metadata from ${url}`);
    
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        console.error(`geoboundaries-polygon: Metadata fetch failed: HTTP ${res.statusCode}`);
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const metadata = JSON.parse(data);
          const downloadUrl = metadata?.gjDownloadURL;
          
          if (!downloadUrl) {
            console.error(`geoboundaries-polygon: No download URL in metadata for ${iso3} ADM${level}`);
            reject(new Error('No download URL in metadata'));
            return;
          }
          
          console.log(`geoboundaries-polygon: Downloading GeoJSON from ${downloadUrl}`);
          
          // Download the actual GeoJSON file
          https.get(downloadUrl, (geoRes) => {
            if (geoRes.statusCode !== 200) {
              console.error(`geoboundaries-polygon: GeoJSON download failed: HTTP ${geoRes.statusCode}`);
              reject(new Error(`Download failed: HTTP ${geoRes.statusCode}`));
              return;
            }
            
            let geoData = '';
            let totalSize = 0;
            geoRes.on('data', (chunk) => { 
              geoData += chunk; 
              totalSize += chunk.length;
            });
            geoRes.on('end', () => {
              try {
                console.log(`geoboundaries-polygon: Downloaded ${(totalSize / 1024 / 1024).toFixed(2)}MB for ${iso3} ADM${level}`);
                const geojson = JSON.parse(geoData);
                if (!geojson.features || geojson.features.length === 0) {
                  console.warn(`geoboundaries-polygon: No features in GeoJSON for ${iso3} ADM${level}`);
                  reject(new Error('No features in GeoJSON'));
                  return;
                }
                console.log(`geoboundaries-polygon: Parsed ${geojson.features.length} features for ${iso3} ADM${level}`);
                saveCachedGeoBoundaries(iso3, level, geojson);
                resolve(geojson);
              } catch (error) {
                console.error(`geoboundaries-polygon: Failed to parse GeoJSON: ${error.message}`);
                reject(new Error(`Failed to parse GeoJSON: ${error.message}`));
              }
            });
          }).on('error', (err) => {
            console.error(`geoboundaries-polygon: Download error: ${err.message}`);
            reject(err);
          });
        } catch (error) {
          console.error(`geoboundaries-polygon: Failed to parse metadata: ${error.message}`);
          reject(new Error(`Failed to parse metadata: ${error.message}`));
        }
      });
    }).on('error', (err) => {
      console.error(`geoboundaries-polygon: Metadata fetch error: ${err.message}`);
      reject(err);
    });
  });
}

function computeArea(feature) {
  try {
    return area(feature);
  } catch {
    return Infinity;
  }
}

function pickBestFeature(features, lat, lon) {
  const pt = [lon, lat];
  const candidates = [];

  for (const feature of features) {
    if (!feature?.geometry) continue;
    try {
      if (booleanPointInPolygon(pt, feature.geometry)) {
        candidates.push(feature);
      }
    } catch (error) {
      // Skip invalid geometries
      continue;
    }
  }

  if (!candidates.length) {
    return null;
  }

  // Prefer smaller area (more specific boundary)
  candidates.sort((a, b) => {
    const areaA = computeArea(a);
    const areaB = computeArea(b);
    return areaA - areaB;
  });

  return candidates[0];
}

async function loadGeoBoundaries(iso3, level) {
  // Try GCS bucket or local pre-downloaded file
  const cached = await loadCachedGeoBoundaries(iso3, level);
  if (cached) {
    console.log(`geoboundaries-polygon: Using cached data for ${iso3} ADM${level}`);
    return cached;
  }
  
  // Fallback: Download if not cached (for development/testing)
  console.log(`geoboundaries-polygon: Cache miss, attempting download for ${iso3} ADM${level}`);
  try {
    const result = await downloadGeoBoundaries(iso3, level);
    console.log(`geoboundaries-polygon: Successfully downloaded ${iso3} ADM${level}`);
    return result;
  } catch (error) {
    console.error(`geoboundaries-polygon: Failed to download ${iso3} ADM${level}:`, error.message);
    return null;
  }
}

async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const { lat, lon, country, level = '2' } = req.query;
  const latNum = Number(lat);
  const lonNum = Number(lon);
  const levelNum = Number(level);

  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    res.status(400).json({ error: 'invalid_coordinates' });
    return;
  }

  if (![2, 4].includes(levelNum)) {
    res.status(400).json({ error: 'invalid_level', allowed: [2, 4] });
    return;
  }

  const iso3 = normalizeCountry(country);
  if (!iso3) {
    res.status(400).json({ error: 'unsupported_country', allowed: Array.from(SUPPORTED_COUNTRIES) });
    return;
  }

  try {
    const geojson = await loadGeoBoundaries(iso3, levelNum);
    if (!geojson?.features?.length) {
      // Return 200 with error message instead of 404, so client can distinguish
      // between "API not found" (404) and "data not available" (200 with error)
      res.status(200).json({ error: 'polygon_not_found', source: 'geoboundaries', message: 'No boundaries available' });
      return;
    }

    const bestFeature = pickBestFeature(geojson.features, latNum, lonNum);
    if (!bestFeature) {
      // Return 200 with error message instead of 404
      res.status(200).json({ error: 'polygon_not_found', source: 'geoboundaries', message: 'No polygon contained the point' });
      return;
    }

    res.status(200).json({
      feature: bestFeature,
      adminLevel: levelNum,
      source: 'geoboundaries',
      name: bestFeature?.properties?.shapeName || bestFeature?.properties?.shapeISO || 'Unknown'
    });
  } catch (error) {
    console.error('geoboundaries-polygon: error', error);
    res.status(502).json({ error: 'geoboundaries_failed', message: error.message });
  }
}

module.exports = handler;
