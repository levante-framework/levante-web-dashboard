// Reverse geocoding API - optimized brute-force search without kdbush dependency
const fs = require('fs');
const path = require('path');
const DATA_PATH = path.join(process.cwd(), 'data', 'geocoder', 'cities.min.json');
const DATA_PATH_GZ = path.join(process.cwd(), 'data', 'geocoder', 'cities.min.json.gz');
const EARTH_RADIUS_KM = 6371;
const zlib = require('zlib');

let geoData = null;

function loadData() {
  if (geoData) return;
  
  try {
    let raw;
    const cwd = process.cwd();
    const gzPath = DATA_PATH_GZ;
    const jsonPath = DATA_PATH;
    
    // Check what files actually exist
    const gzExists = fs.existsSync(gzPath);
    const jsonExists = fs.existsSync(jsonPath);
    
    if (gzExists) {
      try {
        const gzBuffer = fs.readFileSync(gzPath);
        raw = zlib.gunzipSync(gzBuffer).toString();
      } catch (gzError) {
        throw new Error(`Failed to decompress ${gzPath}: ${gzError.message}`);
      }
    } else if (jsonExists) {
      raw = fs.readFileSync(jsonPath, 'utf8');
    } else {
      // Try alternative paths
      const altGz = path.join(cwd, 'data', 'geocoder', 'cities.min.json.gz');
      const altJson = path.join(cwd, 'data', 'geocoder', 'cities.min.json');
      if (fs.existsSync(altGz)) {
        raw = zlib.gunzipSync(fs.readFileSync(altGz)).toString();
      } else if (fs.existsSync(altJson)) {
        raw = fs.readFileSync(altJson, 'utf8');
      } else {
        throw new Error(`Dataset not found. Checked: ${gzPath}, ${jsonPath}, ${altGz}, ${altJson}. CWD: ${cwd}`);
      }
    }
    
    geoData = JSON.parse(raw);
    if (!Array.isArray(geoData) || geoData.length === 0) {
      throw new Error(`Dataset parsed but is empty or invalid (length: ${geoData?.length || 0})`);
    }
  } catch (error) {
    // Re-throw with more context
    throw new Error(`loadData failed: ${error.message}. Stack: ${error.stack?.substring(0, 200)}`);
  }
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRadians = (deg) => (deg * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon1 - lon2);
  const radLat1 = toRadians(lat1);
  const radLat2 = toRadians(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(radLat1) * Math.cos(radLat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function selectResults(results, limit) {
  if (!results.length) return [];
  const sorted = results.slice().sort((a, b) => a.distanceKm - b.distanceKm);
  if (limit === 1) {
    return [sorted[0]];
  }

  const preferredAdmin1 = sorted[0].admin1;
  const sameRegion = preferredAdmin1
    ? sorted.filter((entry) => entry.admin1 === preferredAdmin1)
    : [];

  if (sameRegion.length >= limit) {
    return sameRegion.slice(0, limit);
  }

  const combined = [];
  const seen = new Set();

  for (const entry of sameRegion) {
    combined.push(entry);
    seen.add(entry.id);
  }

  for (const entry of sorted) {
    if (combined.length >= limit) break;
    if (seen.has(entry.id)) continue;
    combined.push(entry);
    seen.add(entry.id);
  }

  return combined.slice(0, limit);
}

function findNearest(lat, lon, limit, maxDistanceKm) {
  const matches = [];

  // Quick bounding box filter: 1 degree lat/lon ≈ 111km, so we can pre-filter
  const latRange = maxDistanceKm ? maxDistanceKm / 111 : 90;
  const lonRange = maxDistanceKm ? maxDistanceKm / (111 * Math.cos(lat * Math.PI / 180)) : 180;

  // Scan all cities in bounding box to find true nearest
  for (const city of geoData) {
    if (!city || typeof city.lat !== 'number' || typeof city.lon !== 'number') continue;

    if (maxDistanceKm) {
      const latDiff = Math.abs(city.lat - lat);
      const lonDiff = Math.abs(city.lon - lon);
      if (latDiff > latRange || lonDiff > lonRange) continue;
    }

    const distanceKm = haversineDistance(lat, lon, city.lat, city.lon);
    if (maxDistanceKm && distanceKm > maxDistanceKm) continue;

    matches.push({
      id: city.id,
      name: city.name,
      ascii: city.ascii,
      lat: city.lat,
      lon: city.lon,
      country: city.country,
      admin1: city.admin1,
      admin2: city.admin2,
      population: city.population,
      distanceKm: Number(distanceKm.toFixed(2))
    });
  }

  // Sort by distance and return top N
  return selectResults(matches, limit);
}

module.exports = async function handler(req, res) {
  // Ensure we always return JSON, even on errors
  const sendError = (status, error, details) => {
    try {
      res.status(status).json({ error, ...details });
    } catch (e) {
      // If headers already sent, just log
      console.error('Failed to send error response:', e);
    }
  };

  try {
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

    try {
      loadData();
      if (!geoData || !Array.isArray(geoData) || geoData.length === 0) {
        const debugInfo = { 
          hasData: !!geoData, 
          isArray: Array.isArray(geoData),
          length: geoData?.length,
          dataPath: DATA_PATH,
          dataPathGz: DATA_PATH_GZ,
          existsGz: fs.existsSync(DATA_PATH_GZ),
          existsJson: fs.existsSync(DATA_PATH)
        };
        console.error('reverse-geocode: dataset empty or invalid', debugInfo);
        sendError(500, 'dataset_empty', { message: 'Dataset loaded but is empty or invalid', debug: debugInfo });
        return;
      }
    } catch (error) {
      const debugInfo = {
        message: error.message,
        stack: error.stack?.substring(0, 500), // Truncate stack for safety
        dataPath: DATA_PATH,
        dataPathGz: DATA_PATH_GZ,
        existsGz: fs.existsSync(DATA_PATH_GZ),
        existsJson: fs.existsSync(DATA_PATH)
      };
      console.error('reverse-geocode: dataset unavailable', error);
      sendError(500, 'dataset_missing', debugInfo);
      return;
    }

    const lat = toNumber(req.query.lat);
    const lon = toNumber(req.query.lon);

    if (lat === null || lon === null) {
      res.status(400).json({ error: 'invalid_coordinates', message: 'lat and lon query params are required numbers.' });
      return;
    }

    const limit = Math.max(1, Math.min(10, toNumber(req.query.limit) || 3));
    const maxDistanceKm = toNumber(req.query.maxDistanceKm) || 50; // optional filter

    let results = [];
    try {
      console.log('reverse-geocode: starting lookup', { lat, lon, limit, maxDistanceKm, datasetSize: geoData.length });
      results = findNearest(lat, lon, limit, maxDistanceKm);
      console.log('reverse-geocode: lookup complete', { resultCount: results.length });
    } catch (error) {
      console.error('reverse-geocode: lookup failed', error);
      sendError(500, 'lookup_failed', { 
        message: error.message || 'Unknown error', 
        stack: error.stack?.substring(0, 500) 
      });
      return;
    }

    res.status(200).json({
      lat,
      lon,
      results
    });
  } catch (error) {
    console.error('reverse-geocode: unhandled error', error);
    sendError(500, 'unexpected_error', {
      message: error?.message || 'Unknown error',
      stack: error?.stack?.substring(0, 500) || null
    });
  }
}
