#!/usr/bin/env node

/**
 * Generate Gallery Images
 * 
 * Takes the gallery data and generates images showing:
 * - Two location cards with city info
 * - Map with GPS point, circle, and polygons
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const sharp = require('sharp');

// Load environment variables from .env file if it exists (do not log secrets)
try {
  const dotenv = require('dotenv');
  const envPath = path.join(process.cwd(), '.env');
  // override=true ensures reruns in the same shell pick up updated .env values.
  dotenv.config({ path: envPath, override: true, quiet: true });
} catch (e) {
  // dotenv not installed or .env file doesn't exist - that's okay
}

const DATA_FILE = path.join(process.cwd(), 'public', 'gallery', 'locate-me', 'gallery-data.json');
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'gallery', 'locate-me', 'images');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function formatDistance(km) {
  if (km < 1) return `${(km * 1000).toFixed(0)} m`;
  return `${km.toFixed(1)} km`;
}

function formatBytes(bytes) {
  if (!bytes) return 'N/A';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function validateMapboxStaticImagesToken(token) {
  return new Promise((resolve) => {
    if (!token) return resolve(false);
    // Tiny request just to verify Static Images access.
    const url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/0,0,0/1x1?access_token=${encodeURIComponent(token)}`;
    const req = https.get(url, (res) => {
      // Consume data to avoid socket leaks.
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
  });
}

function formatPopulation(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return 'Unknown';
  try {
    return Math.round(num).toLocaleString();
  } catch (_) {
    return String(Math.round(num));
  }
}

// --- Weather (Open-Meteo) ---
const WEATHER_CACHE_PATH = path.join(process.cwd(), 'data', 'gallery', 'weather-cache.json');
let weatherCache = null;
let lastWeatherFetchAt = 0;

function loadWeatherCache() {
  if (weatherCache) return weatherCache;
  try {
    if (fs.existsSync(WEATHER_CACHE_PATH)) {
      weatherCache = JSON.parse(fs.readFileSync(WEATHER_CACHE_PATH, 'utf8'));
    } else {
      weatherCache = {};
    }
  } catch (_) {
    weatherCache = {};
  }
  return weatherCache;
}

function saveWeatherCache() {
  try {
    fs.mkdirSync(path.dirname(WEATHER_CACHE_PATH), { recursive: true });
    fs.writeFileSync(WEATHER_CACHE_PATH, JSON.stringify(weatherCache || {}, null, 2));
  } catch (_) {}
}

function weatherCodeDescription(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return 'Unknown';
  const map = {
    0: 'Clear',
    1: 'Mostly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Rime fog',
    51: 'Light drizzle',
    53: 'Drizzle',
    55: 'Heavy drizzle',
    56: 'Freezing drizzle',
    57: 'Heavy freezing drizzle',
    61: 'Light rain',
    63: 'Rain',
    65: 'Heavy rain',
    66: 'Freezing rain',
    67: 'Heavy freezing rain',
    71: 'Light snow',
    73: 'Snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Light showers',
    81: 'Showers',
    82: 'Heavy showers',
    85: 'Snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm (hail)',
    99: 'Thunderstorm (heavy hail)'
  };
  return map[c] || 'Unknown';
}

function roundToStep(value, step) {
  const n = Number(value);
  const s = Number(step);
  if (!Number.isFinite(n) || !Number.isFinite(s) || s <= 0) return n;
  return Math.round(n / s) * s;
}

function fetchJsonHttps(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode !== 200) {
              return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            }
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function getCurrentWeatherForPoint(lat, lon) {
  // Cache key is rounded so reruns don't hammer Open-Meteo.
  const step = 0.1; // ~11km at equator; good enough for a gallery legend snapshot
  const rLat = roundToStep(lat, step);
  const rLon = roundToStep(lon, step);
  const key = `${rLat.toFixed(2)},${rLon.toFixed(2)}`;

  const cache = loadWeatherCache();
  const cached = cache[key];
  const now = Date.now();
  if (cached && cached.expiresAt && now < cached.expiresAt && cached.weather) {
    return cached.weather;
  }

  // Light throttle (avoid bursts)
  const since = now - lastWeatherFetchAt;
  if (since < 150) {
    await new Promise((r) => setTimeout(r, 150 - since));
  }
  lastWeatherFetchAt = Date.now();

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(rLat)}&longitude=${encodeURIComponent(rLon)}&current_weather=true&timezone=auto`;
  const json = await fetchJsonHttps(url);
  const cw = json?.current_weather;
  if (!cw) return null;

  const weather = {
    temperatureC: Number(cw.temperature),
    windKph: Number(cw.windspeed),
    weathercode: Number(cw.weathercode),
    description: weatherCodeDescription(cw.weathercode),
    observedAt: cw.time || null,
    query: { lat: rLat, lon: rLon, roundingDeg: step }
  };

  cache[key] = {
    fetchedAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000,
    weather
  };
  saveWeatherCache();
  return weather;
}

let citiesMinCache = null;
let citiesByCountryCache = null;
let usPlacePackCache = new Map();
let usTractPackCache = new Map();

function loadGzFeatureCollection(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const json = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    return json && json.features ? json : null;
  } catch (_) {
    return null;
  }
}

function geometryAreaApprox(geom) {
  if (!geom || !geom.type || !geom.coordinates) return Infinity;
  const ringArea = (ring = []) => {
    if (!ring || ring.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum / 2);
  };
  const polys =
    geom.type === 'Polygon'
      ? [geom.coordinates]
      : geom.type === 'MultiPolygon'
      ? geom.coordinates
      : [];
  let total = 0;
  for (const poly of polys) {
    if (!poly || !poly.length) continue;
    const [outer, ...holes] = poly;
    total += ringArea(outer || []);
    for (const hole of holes) total -= ringArea(hole || []);
  }
  return total || Infinity;
}

function bestContainingFeature(features, lon, lat) {
  if (!Array.isArray(features) || !features.length) return null;
  const pt = [lon, lat];
  let best = null;
  let bestArea = Infinity;
  for (const f of features) {
    if (!f?.geometry) continue;
    if (!pointInPolygonGeometry(pt, f.geometry)) continue;
    const area = geometryAreaApprox(f.geometry);
    if (area < bestArea) {
      bestArea = area;
      best = f;
    }
  }
  return best;
}

function loadUsPlaceFeature(stateAbbr, lon, lat) {
  const st = (stateAbbr || '').toString().trim().toLowerCase();
  if (!st) return null;
  const filePath = path.join(process.cwd(), 'public', 'adm-packs', 'us', 'adm3-place', `${st}.json.gz`);
  if (usPlacePackCache.has(st)) {
    const pack = usPlacePackCache.get(st);
    return pack ? bestContainingFeature(pack.features || [], lon, lat) : null;
  }
  const pack = fs.existsSync(filePath) ? loadGzFeatureCollection(filePath) : null;
  usPlacePackCache.set(st, pack);
  return pack ? bestContainingFeature(pack.features || [], lon, lat) : null;
}

function loadUsTractFeature(stateAbbr, lon, lat) {
  const st = (stateAbbr || '').toString().trim().toLowerCase();
  if (!st) return null;
  const filePath = path.join(process.cwd(), 'public', 'adm-packs', 'us', 'adm3', `${st}.json.gz`);
  if (usTractPackCache.has(st)) {
    const pack = usTractPackCache.get(st);
    return pack ? bestContainingFeature(pack.features || [], lon, lat) : null;
  }
  const pack = fs.existsSync(filePath) ? loadGzFeatureCollection(filePath) : null;
  usTractPackCache.set(st, pack);
  return pack ? bestContainingFeature(pack.features || [], lon, lat) : null;
}

function loadCitiesMin() {
  if (citiesMinCache) return citiesMinCache;
  const gzPath = path.join(process.cwd(), 'data', 'geocoder', 'cities.min.json.gz');
  const rawPath = path.join(process.cwd(), 'data', 'geocoder', 'cities.min.json');
  let buf = null;
  if (fs.existsSync(gzPath)) {
    buf = zlib.gunzipSync(fs.readFileSync(gzPath));
  } else if (fs.existsSync(rawPath)) {
    buf = fs.readFileSync(rawPath);
  } else {
    return null;
  }
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    citiesMinCache = Array.isArray(parsed) ? parsed : null;
    return citiesMinCache;
  } catch (_) {
    return null;
  }
}

function citiesByCountry() {
  if (citiesByCountryCache) return citiesByCountryCache;
  const arr = loadCitiesMin();
  const map = new Map();
  if (!arr) {
    citiesByCountryCache = map;
    return map;
  }
  for (const c of arr) {
    const cc = (c?.country || '').toString().trim().toUpperCase();
    if (!cc) continue;
    if (!map.has(cc)) map.set(cc, []);
    map.get(cc).push(c);
  }
  citiesByCountryCache = map;
  return map;
}

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

function pointInPolygonGeometry(pt, geom) {
  if (!geom) return false;
  const type = geom.type;
  const polys =
    type === 'Polygon'
      ? [geom.coordinates]
      : type === 'MultiPolygon'
      ? geom.coordinates
      : [];
  for (const poly of polys) {
    if (!poly || !poly.length) continue;
    const [outer, ...holes] = poly;
    if (!outer || outer.length < 4) continue;
    if (!pointInRing(pt, outer)) continue;
    let inHole = false;
    for (const hole of holes) {
      if (hole && hole.length >= 4 && pointInRing(pt, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function estimatePopulationFromCities(geometry, countryCode) {
  const cc = (countryCode || '').toString().trim().toUpperCase();
  if (!geometry || !cc) return null;
  const bbox = bboxFromGeometry(geometry);
  if (!bbox) return null;
  const list = citiesByCountry().get(cc) || [];
  if (!list.length) return null;

  const pt = [0, 0];
  let total = 0;
  for (const c of list) {
    const lon = Number(c?.lon);
    const lat = Number(c?.lat);
    const pop = Number(c?.population) || 0;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || pop <= 0) continue;
    if (lon < bbox.minLon || lon > bbox.maxLon || lat < bbox.minLat || lat > bbox.maxLat) continue;
    pt[0] = lon;
    pt[1] = lat;
    if (pointInPolygonGeometry(pt, geometry)) total += pop;
  }
  return total || null;
}

function safeStatBytes(filePath) {
  try {
    return fs.statSync(filePath).size || 0;
  } catch (_) {
    return 0;
  }
}

function estimatePolygonPackDownload(point, adminArea, cityArea, polygons, usLocalSource = null) {
  // Estimate the bytes a client would download to compute polygons for this point.
  // This represents ONLY the polygon packs (not basemap tiles), per the Locate-Me runtime behavior.
  const code = (point?.country || '').toString().trim().toLowerCase();
  const localLevel = adminArea?.adminLevel || null; // local boundary level (ADM3 or ADM2 fallback)
  const needsAdm3 = localLevel === 3;
  const parts = [];
  let total = 0;

  const adm2Path = path.join(process.cwd(), 'public', 'adm-packs', code, 'adm2.json.gz');
  const adm2Bytes = safeStatBytes(adm2Path);
  if (adm2Bytes) {
    total += adm2Bytes;
    parts.push('ADM2');
  }

  if (needsAdm3) {
    if (code === 'us') {
      const state = (polygons?.[0]?.city?.admin1 || '').toString().trim().toLowerCase();
      const usePlace = usLocalSource === 'place';
      const useTract = usLocalSource === 'tract' || !usePlace;
      if (usePlace) {
        const placePath = path.join(process.cwd(), 'public', 'adm-packs', 'us', 'adm3-place', `${state}.json.gz`);
        const placeBytes = safeStatBytes(placePath);
        if (placeBytes) {
          total += placeBytes;
          parts.push('ADM3(place)');
        } else {
          parts.push('ADM3(place?)');
        }
      } else if (useTract) {
        const adm3Path = path.join(process.cwd(), 'public', 'adm-packs', 'us', 'adm3', `${state}.json.gz`);
        const adm3Bytes = safeStatBytes(adm3Path);
        if (adm3Bytes) {
          total += adm3Bytes;
          parts.push('ADM3(tract)');
        } else {
          parts.push('ADM3(tract?)');
        }
      }
    } else {
      const adm3Path = path.join(process.cwd(), 'public', 'adm-packs', code, 'adm3.json.gz');
      const adm3Bytes = safeStatBytes(adm3Path);
      if (adm3Bytes) {
        total += adm3Bytes;
        parts.push('ADM3');
      } else {
        parts.push('ADM3?');
      }
    }
  }

  // If we couldn't stat any pack, return 0 with a placeholder.
  const detail = parts.length ? parts.join('+') : 'Unknown';
  return { totalBytes: total, detail };
}

// Mapbox Static Images API helpers
function calculateZoomForWidth(lat, widthKm) {
  // Convert widthKm to longitudinal degrees at the given latitude.
  // (Longitude degrees shrink by cos(latitude).)
  const cos = Math.cos((lat * Math.PI) / 180) || 1e-12;
  const degreesLon = widthKm / (111.0 * cos);
  const zoom = Math.log2(360 / degreesLon);
  return Math.round(zoom * 10) / 10;
}

// Douglas-Peucker algorithm for polygon simplification
function simplifyPolygon(geometry, tolerance = 0.0001) {
  if (!geometry || !geometry.coordinates) return geometry;

  // Helper function for uniform sampling - non-recursive
  const uniformSample = (ring, maxPoints = 32) => {
    if (!ring || ring.length <= maxPoints) return ring;
    const step = Math.max(1, Math.floor(ring.length / maxPoints));
    const sampled = [];
    for (let i = 0; i < ring.length - 1; i += step) {
      sampled.push(ring[i]);
    }
    const lastPt = ring[ring.length - 1];
    if (sampled.length === 0 || 
        Math.abs(sampled[sampled.length - 1][0] - lastPt[0]) > 0.000001 ||
        Math.abs(sampled[sampled.length - 1][1] - lastPt[1]) > 0.000001) {
      sampled.push(lastPt);
    }
    const firstPt = sampled[0];
    const finalLast = sampled[sampled.length - 1];
    if (Math.abs(firstPt[0] - finalLast[0]) > 0.000001 || Math.abs(firstPt[1] - finalLast[1]) > 0.000001) {
      sampled.push([firstPt[0], firstPt[1]]);
    }
    return sampled.length >= 4 ? sampled : ring;
  };

  const simplifyRing = (ring, maxDepth = 5, depth = 0) => {
    // For rings > 100 points, skip Douglas-Peucker entirely - use uniform sampling immediately
    if (ring && ring.length > 100) {
      return uniformSample(ring, 20);
    }
    
    // For rings > 50 points at any depth, use uniform sampling
    if (ring && ring.length > 50 && depth > 0) {
      return uniformSample(ring, 20);
    }
    
    // Prevent infinite recursion - use uniform sampling immediately (suppress warning)
    if (depth > maxDepth) {
      return uniformSample(ring, 20);
    }
    
    // For any ring at depth > 2, use uniform sampling
    if (depth > 2) {
      return uniformSample(ring, 20);
    }
    
    // Ensure ring has at least 4 points (needed for valid Polygon)
    if (!ring || ring.length < 4) return ring;
    
    // Validate and clean coordinates first
    const cleanedRing = ring.filter(coord => {
      if (!Array.isArray(coord) || coord.length < 2) return false;
      const [lon, lat] = coord;
      return typeof lon === 'number' && typeof lat === 'number' &&
             isFinite(lon) && isFinite(lat) &&
             lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
    });
    
    if (cleanedRing.length < 4) return ring; // Can't simplify if too few valid points
    
    // Ensure ring is closed (first and last point match) - use tolerance for comparison
    const first = cleanedRing[0];
    const last = cleanedRing[cleanedRing.length - 1];
    const lonDiff = Math.abs(first[0] - last[0]);
    const latDiff = Math.abs(first[1] - last[1]);
    const isClosed = lonDiff < 0.000001 && latDiff < 0.000001;
    const workingRing = isClosed ? cleanedRing : [...cleanedRing, first];
    
    // For very high tolerance (>= 0.1), use uniform sampling instead of Douglas-Peucker
    if (tolerance >= 0.1) {
      // Use uniform sampling with fewer points for high tolerance
      const maxPoints = tolerance >= 1.0 ? 20 : (tolerance >= 0.5 ? 25 : 30);
      return uniformSample(workingRing, maxPoints);
    }
    
    // For rings > 50 points, skip Douglas-Peucker and use uniform sampling
    if (workingRing.length > 50) {
      return uniformSample(workingRing, 20);
    }
    
    // If ring is already minimal, return as-is (but ensure closed)
    if (workingRing.length <= 4) {
      const firstPt = workingRing[0];
      const lastPt = workingRing[workingRing.length - 1];
      const closed = (Math.abs(firstPt[0] - lastPt[0]) < 0.000001 && Math.abs(firstPt[1] - lastPt[1]) < 0.000001)
        ? workingRing 
        : [...workingRing.slice(0, -1), firstPt];
      return closed;
    }
    
    let maxDistance = 0;
    let index = 0;
    const start = workingRing[0];
    const end = workingRing[workingRing.length - 1];

    for (let i = 1; i < workingRing.length - 1; i++) {
      const d = pointToLineDistance(workingRing[i], start, end);
      if (d > maxDistance) {
        maxDistance = d;
        index = i;
      }
    }

    if (maxDistance > tolerance) {
      // Ensure slices are actually smaller to prevent infinite recursion
      const slice1 = workingRing.slice(0, index + 1);
      const slice2 = workingRing.slice(index);
      
      // Safety check: if slices aren't getting smaller, use uniform sampling
      if (slice1.length >= workingRing.length || slice2.length >= workingRing.length) {
        return uniformSample(workingRing, 20);
      }
      
      // Safety check: if ring is still very large after slicing, use uniform sampling
      if (slice1.length > 100 || slice2.length > 100 || workingRing.length > 150) {
        return uniformSample(workingRing, 20);
      }
      
      // Additional safety: if we're already deep in recursion, use uniform sampling
      if (depth > 1) {
        return uniformSample(workingRing, 20);
      }
      
      const rec1 = simplifyRing(slice1, maxDepth, depth + 1);
      const rec2 = simplifyRing(slice2, maxDepth, depth + 1);
      // Merge: remove duplicate point at junction
      const simplified = [...rec1.slice(0, -1), ...rec2];
      // Ensure closed and at least 4 points
      const firstPt = simplified[0];
      const lastPt = simplified[simplified.length - 1];
      const closed = (Math.abs(firstPt[0] - lastPt[0]) < 0.000001 && Math.abs(firstPt[1] - lastPt[1]) < 0.000001)
        ? simplified 
        : [...simplified, firstPt];
      return closed.length >= 4 ? closed : ring;
    } else {
      // Keep at least 4 points (start, 2 points, close)
      const minimal = [workingRing[0], workingRing[1], workingRing[workingRing.length - 2], workingRing[workingRing.length - 1]];
      // Ensure closed
      const firstPt = minimal[0];
      const lastPt = minimal[minimal.length - 1];
      return (Math.abs(firstPt[0] - lastPt[0]) < 0.000001 && Math.abs(firstPt[1] - lastPt[1]) < 0.000001)
        ? minimal 
        : [...minimal, firstPt];
    }
  };

  const pointToLineDistance = (point, lineStart, lineEnd) => {
    const x = point[0];
    const y = point[1];
    const x1 = lineStart[0];
    const y1 = lineStart[1];
    const x2 = lineEnd[0];
    const y2 = lineEnd[1];

    const A = x - x1;
    const B = y - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const len_sq = C * C + D * D;
    let param = -1;
    if (len_sq !== 0) {
      param = dot / len_sq;
    }

    let xx, yy;
    if (param < 0) {
      xx = x1;
      yy = y1;
    } else if (param > 1) {
      xx = x2;
      yy = y2;
    } else {
      xx = x1 + param * C;
      yy = y1 + param * D;
    }

    const dx = x - xx;
    const dy = y - yy;
    return Math.sqrt(dx * dx + dy * dy);
  };

  if (geometry.type === 'Polygon') {
    const simplified = geometry.coordinates.map(ring => simplifyRing(ring, 5, 0));
    // Validate: ensure all rings have at least 4 points and are closed
    const validRings = simplified.filter(ring => {
      if (!ring || ring.length < 4) return false;
      // Ensure ring is closed
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) return false;
      // Validate all coordinates
      return ring.every(coord => {
        if (!Array.isArray(coord) || coord.length < 2) return false;
        const [lon, lat] = coord;
        return typeof lon === 'number' && typeof lat === 'number' &&
               isFinite(lon) && isFinite(lat) &&
               lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
      });
    });
    if (validRings.length === 0) {
      // Return original if simplification made it invalid
      return geometry;
    }
    return {
      type: 'Polygon',
      coordinates: validRings
    };
  } else if (geometry.type === 'MultiPolygon') {
    const simplified = geometry.coordinates.map(poly => poly.map(ring => simplifyRing(ring, 5, 0)));
    // Validate: ensure all polygons have at least one valid ring
    const validPolygons = simplified.filter(poly => {
      if (!poly || poly.length === 0) return false;
      return poly.some(ring => {
        if (!ring || ring.length < 4) return false;
        // Ensure ring is closed - allow small floating point differences
        const first = ring[0];
        const last = ring[ring.length - 1];
        const lonDiff = Math.abs(first[0] - last[0]);
        const latDiff = Math.abs(first[1] - last[1]);
        if (lonDiff > 0.000001 || latDiff > 0.000001) return false; // Allow tiny floating point differences
        // Validate coordinates
        return ring.every(coord => {
          if (!Array.isArray(coord) || coord.length < 2) return false;
          const [lon, lat] = coord;
          return typeof lon === 'number' && typeof lat === 'number' &&
                 isFinite(lon) && isFinite(lat) &&
                 lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
        });
      });
    });
    if (validPolygons.length === 0) {
      // Return original if simplification made it invalid
      return geometry;
    }
    return {
      type: 'MultiPolygon',
      coordinates: validPolygons
    };
  }
  return geometry;
}

// Fix common polygon geometry issues
function fixPolygonGeometry(geometry) {
  if (!geometry || !geometry.coordinates) return geometry;
  
  const fixRing = (ring) => {
    if (!Array.isArray(ring) || ring.length < 3) return ring;
    
    // Filter invalid coordinates
    const valid = ring.filter(coord => {
      if (!Array.isArray(coord) || coord.length < 2) return false;
      const [lon, lat] = coord;
      return typeof lon === 'number' && typeof lat === 'number' &&
             isFinite(lon) && isFinite(lat) &&
             lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
    });
    
    if (valid.length < 4) return ring; // Need at least 4 points for valid polygon
    
    // Ensure ring is closed - check with tolerance for floating point precision
    const first = valid[0];
    const last = valid[valid.length - 1];
    const lonDiff = Math.abs(first[0] - last[0]);
    const latDiff = Math.abs(first[1] - last[1]);
    if (lonDiff > 0.000001 || latDiff > 0.000001) {
      return [...valid, first];
    }
    return valid;
  };
  
  if (geometry.type === 'Polygon') {
    const fixed = geometry.coordinates.map(fixRing).filter(ring => ring && ring.length >= 4);
    if (fixed.length === 0) return geometry;
    return { type: 'Polygon', coordinates: fixed };
  }
  
  if (geometry.type === 'MultiPolygon') {
    const fixed = geometry.coordinates.map(poly => 
      poly.map(fixRing).filter(ring => ring && ring.length >= 4)
    ).filter(poly => poly.length > 0);
    if (fixed.length === 0) return geometry;
    return { type: 'MultiPolygon', coordinates: fixed };
  }
  
  return geometry;
}

// Validate GeoJSON feature with comprehensive checks
function isValidGeoJSONFeature(feature) {
  if (!feature || !feature.geometry) return false;
  const geom = feature.geometry;
  
  // Check for valid geometry type
  const validTypes = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon'];
  if (!geom.type || !validTypes.includes(geom.type)) return false;
  
  if (!geom.coordinates || !Array.isArray(geom.coordinates)) return false;
  
  if (geom.type === 'Polygon') {
    if (geom.coordinates.length === 0) return false;
    // Check each ring
    for (const ring of geom.coordinates) {
      if (!Array.isArray(ring) || ring.length < 4) return false;
      // Check that coordinates are valid numbers
      for (const coord of ring) {
        if (!Array.isArray(coord) || coord.length < 2) return false;
        const [lon, lat] = coord;
        if (typeof lon !== 'number' || typeof lat !== 'number' || 
            !isFinite(lon) || !isFinite(lat) ||
            lon < -180 || lon > 180 || lat < -90 || lat > 90) {
          return false;
        }
      }
      // Check that first and last coordinates match (closed ring) - allow small floating point differences
      const first = ring[0];
      const last = ring[ring.length - 1];
      const lonDiff = Math.abs(first[0] - last[0]);
      const latDiff = Math.abs(first[1] - last[1]);
      if (lonDiff > 0.000001 || latDiff > 0.000001) return false; // Allow tiny floating point differences
    }
    return true;
  }
  
  if (geom.type === 'MultiPolygon') {
    if (geom.coordinates.length === 0) return false;
    for (const poly of geom.coordinates) {
      if (!Array.isArray(poly) || poly.length === 0) return false;
      for (const ring of poly) {
        if (!Array.isArray(ring) || ring.length < 4) return false;
        // Validate coordinates
        for (const coord of ring) {
          if (!Array.isArray(coord) || coord.length < 2) return false;
          const [lon, lat] = coord;
          if (typeof lon !== 'number' || typeof lat !== 'number' || 
              !isFinite(lon) || !isFinite(lat) ||
              lon < -180 || lon > 180 || lat < -90 || lat > 90) {
            return false;
          }
        }
        // Check closed ring - allow small floating point differences
        const first = ring[0];
        const last = ring[ring.length - 1];
        const lonDiff = Math.abs(first[0] - last[0]);
        const latDiff = Math.abs(first[1] - last[1]);
        if (lonDiff > 0.000001 || latDiff > 0.000001) return false; // Allow tiny floating point differences
      }
    }
    return true;
  }
  
  // Point - validate coordinates
  if (geom.type === 'Point') {
    if (!Array.isArray(geom.coordinates) || geom.coordinates.length < 2) return false;
    const [lon, lat] = geom.coordinates;
    return typeof lon === 'number' && typeof lat === 'number' && 
           isFinite(lon) && isFinite(lat) &&
           lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
  }
  
  // LineString - validate coordinates
  if (geom.type === 'LineString') {
    if (!Array.isArray(geom.coordinates) || geom.coordinates.length < 2) return false;
    return geom.coordinates.every(coord => {
      if (!Array.isArray(coord) || coord.length < 2) return false;
      const [lon, lat] = coord;
      return typeof lon === 'number' && typeof lat === 'number' && 
             isFinite(lon) && isFinite(lat) &&
             lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
    });
  }
  
  // Other types - basic validation
  return true;
}

function geometryToBoundingBoxPolygon(geometry) {
  if (!geometry || !geometry.coordinates) return null;

  const collectPoints = coords => {
    if (!coords) return [];
    if (typeof coords[0] === 'number') {
      const [lon, lat] = coords;
      if (isFinite(lon) && isFinite(lat)) {
        return [[lon, lat]];
      }
      return [];
    }
    return coords.flatMap(collectPoints);
  };

  const points = collectPoints(geometry.coordinates);
  if (!points.length) return null;

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  if (!isFinite(minLon) || !isFinite(maxLon) || !isFinite(minLat) || !isFinite(maxLat)) {
    return null;
  }

  // Expand bbox slightly so zero-width polygons still render
  const padding = 0.001;
  minLon -= padding;
  maxLon += padding;
  minLat -= padding;
  maxLat += padding;

  const ring = [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat]
  ];
  return { type: 'Polygon', coordinates: [ring] };
}

function createBoundingBoxFeature(geometry, stroke, fillOpacity) {
  if (!geometry) return null;
  const bboxPolygon = geometryToBoundingBoxPolygon(geometry);
  if (!bboxPolygon) return null;
  return {
    type: 'Feature',
    geometry: bboxPolygon,
    properties: {
      stroke,
      'stroke-width': 2,
      'stroke-opacity': 0.9,
      fill: stroke,
      'fill-opacity': fillOpacity
    }
  };
}


// Round coordinates to 3 decimals to shrink URL size
function roundCoord(value) {
  return Math.round(value * 1000) / 1000;
}

// Compute bbox of Polygon/MultiPolygon
function bboxFromGeometry(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const walk = (coords) => {
    if (typeof coords[0] === 'number') {
      const [lon, lat] = coords;
      if (typeof lon === 'number' && typeof lat === 'number') {
        minLon = Math.min(minLon, lon);
        maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
      }
    } else if (Array.isArray(coords)) {
      coords.forEach(walk);
    }
  };
  walk(geometry.coordinates);
  if (!isFinite(minLon) || !isFinite(maxLon) || !isFinite(minLat) || !isFinite(maxLat)) return null;
  return { minLon, minLat, maxLon, maxLat };
}

// Create an octagon around a bbox
function octagonFromBBox(bbox) {
  if (!bbox) return null;
  const cx = (bbox.minLon + bbox.maxLon) / 2;
  const cy = (bbox.minLat + bbox.maxLat) / 2;
  const rx = Math.max((bbox.maxLon - bbox.minLon) / 2, 0.01);
  const ry = Math.max((bbox.maxLat - bbox.minLat) / 2, 0.01);
  const points = [];
  for (let i = 0; i < 32; i++) {
    const ang = (i / 32) * 2 * Math.PI;
    points.push([roundCoord(cx + rx * Math.cos(ang)), roundCoord(cy + ry * Math.sin(ang))]);
  }
  points.push(points[0]);
  return { type: 'Polygon', coordinates: [points] };
}



// Simplify polygon/multipolygon to a single outline with limited vertices.
// If `focusPoint` is provided ([lon,lat]), prefer the MultiPolygon component that contains it.
function simplifyToOutline(geometry, maxPoints = 32, focusPoint = null) {
  if (!geometry || !geometry.coordinates) return null;
  const fixed = fixPolygonGeometry(geometry);
  if (!fixed || !fixed.coordinates) return null;

  const pointInRing = (pt, ring) => {
    const [px, py] = pt;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersect = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  };

  const pointInPolyCoords = (pt, polyCoords) => {
    if (!Array.isArray(polyCoords) || !polyCoords.length) return false;
    const [outer, ...holes] = polyCoords;
    if (!outer || outer.length < 4) return false;
    if (!pointInRing(pt, outer)) return false;
    for (const hole of holes) {
      if (hole && hole.length >= 4 && pointInRing(pt, hole)) return false;
    }
    return true;
  };

  const ringArea = (ring) => {
    if (!ring || ring.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum / 2);
  };

  const downsampleRing = (ring) => {
    if (!Array.isArray(ring) || ring.length < 4) return null;
    const step = Math.max(1, Math.floor(ring.length / maxPoints));
    const sampled = [];
    for (let i = 0; i < ring.length; i += step) sampled.push(ring[i]);
    const first = sampled[0];
    const last = sampled[sampled.length - 1];
    if (first && last && (first[0] !== last[0] || first[1] !== last[1])) sampled.push(first);
    return sampled.length >= 4 ? sampled : null;
  };

  if (fixed.type === 'Polygon') {
    const ring = downsampleRing(fixed.coordinates[0]);
    if (!ring) return null;
    return { type: 'Polygon', coordinates: [ring] };
  }

  if (fixed.type === 'MultiPolygon') {
    // Prefer polygon component that contains the focus point (if provided).
    if (focusPoint && Array.isArray(focusPoint) && focusPoint.length === 2) {
      for (const poly of fixed.coordinates) {
        if (!poly || !poly.length) continue;
        if (pointInPolyCoords(focusPoint, poly)) {
          const ring = downsampleRing(poly[0]);
          if (ring) return { type: 'Polygon', coordinates: [ring] };
        }
      }
    }

    // Fallback: choose component with largest outer-ring area (more stable than point-count).
    const candidates = fixed.coordinates
      .map((poly) => {
        const outer = poly && poly[0] ? poly[0] : null;
        return outer ? { area: ringArea(outer), ring: downsampleRing(outer) } : null;
      })
      .filter((x) => x && x.ring);
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.area - a.area);
    return { type: 'Polygon', coordinates: [candidates[0].ring] };
  }

  return null;
}

function buildGeoJSONOverlay(point, polygons, adminArea, cityArea) {
  const features = [];

  // GPS point marker
  features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
    properties: { 'marker-color': '#da3d16', 'marker-size': 'large' }
  });

  // 2-mile circle
  const twoMileKm = 1.60934;
  const twoMilePoints = 24;
  const twoMileRing = [];
  for (let i = 0; i < twoMilePoints; i++) {
    const angle = (i / twoMilePoints) * 2 * Math.PI;
    const latOffset = (twoMileKm / 111.0) * Math.cos(angle);
    const lonOffset = (twoMileKm / (111.0 * Math.cos(point.lat * Math.PI / 180))) * Math.sin(angle);
    twoMileRing.push([roundCoord(point.lon + lonOffset), roundCoord(point.lat + latOffset)]);
  }
  twoMileRing.push(twoMileRing[0]);
  features.push({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [twoMileRing] },
    properties: { stroke: '#22c55e', 'stroke-width': 3, fill: '#22c55e', 'fill-opacity': 0.12 }
  });
  console.log(`    Added 2-mile circle with ${twoMileRing.length} points`);

  // Outer circle: 5-mile radius, half the resolution to shrink payload
  const fiveMileKm = 8.0467;
  const fiveMilePoints = 32;
  const fiveMileRing = [];
  for (let i = 0; i < fiveMilePoints; i++) {
    const angle = (i / fiveMilePoints) * 2 * Math.PI;
    const latOffset = (fiveMileKm / 111.0) * Math.cos(angle);
    const lonOffset = (fiveMileKm / (111.0 * Math.cos(point.lat * Math.PI / 180))) * Math.sin(angle);
    fiveMileRing.push([roundCoord(point.lon + lonOffset), roundCoord(point.lat + latOffset)]);
  }
  fiveMileRing.push(fiveMileRing[0]);
  features.push({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [fiveMileRing] },
    properties: { stroke: '#16a34a', 'stroke-width': 2, fill: '#16a34a', 'fill-opacity': 0.08 }
  });
  console.log(`    Added 5-mile circle with ${fiveMileRing.length} points`);

  // Add outline overlays from source polygons (very small payload)
  // Red = Local; Blue = Regional (ADM2).
  // For US, prefer a "place/city" boundary as local (in-between tract and county).
  const country = (point?.country || '').toString().trim().toUpperCase();
  const stateHint = (polygons?.[0]?.city?.admin1 || '').toString().trim();

  let redFeature = adminArea?.polygon || null;
  let blueFeature = cityArea?.polygon || (Array.isArray(polygons) ? polygons[0]?.polygon : null);
  if (country === 'US' && stateHint) {
    const place = loadUsPlaceFeature(stateHint, point.lon, point.lat);
    if (place) {
      redFeature = place;
    } else {
      const tract = loadUsTractFeature(stateHint, point.lon, point.lat);
      if (tract) redFeature = tract;
    }
  }

  const redGeomSrc = redFeature?.geometry || null;
  const blueGeomSrc = blueFeature?.geometry || null;

  const sameLevel = (adminArea?.adminLevel && cityArea?.adminLevel && adminArea.adminLevel === cityArea.adminLevel);
  const normName = (s) => (s || '').toString().trim().toLowerCase();
  const redName = normName(redFeature?.properties?.name || adminArea?.name || adminArea?.polygon?.properties?.name);
  const blueName = normName(
    cityArea?.name ||
      cityArea?.polygon?.properties?.name ||
      (Array.isArray(polygons) ? polygons[0]?.polygon?.properties?.name : '')
  );
  // Some GeoBoundaries countries repeat the same named boundary across multiple admin levels
  // (e.g., Aberdeen City appears at ADM2 and ADM3). When that happens, outlines can overlap
  // and the red local line becomes hard to see.
  const sameName = !!(redName && blueName && redName === blueName);

  const redStroke = sameLevel ? 6 : sameName ? 9 : 4;
  const redOpacity = sameLevel ? 0.55 : sameName ? 0.95 : 0.85;
  const blueStroke = 3;
  const blueOpacity = sameName ? 0.90 : 1.0;

  if (redGeomSrc) {
    const outline = simplifyToOutline(redGeomSrc, 32, [point.lon, point.lat]);
    const geom = outline || octagonFromBBox(bboxFromGeometry(redGeomSrc));
    if (geom) {
      features.push({
        type: 'Feature',
        geometry: geom,
        properties: { stroke: '#dc2626', 'stroke-width': redStroke, 'stroke-opacity': redOpacity, fill: 'none', 'fill-opacity': 0 }
      });
    }
  }

  if (blueGeomSrc) {
    const outline = simplifyToOutline(blueGeomSrc, 32, [point.lon, point.lat]);
    const geom = outline || octagonFromBBox(bboxFromGeometry(blueGeomSrc));
    if (geom) {
      features.push({
        type: 'Feature',
        geometry: geom,
        properties: { stroke: '#2563eb', 'stroke-width': blueStroke, 'stroke-opacity': blueOpacity, fill: 'none', 'fill-opacity': 0 }
      });
    }
  }

  console.log(`    Total features in overlay: ${features.length} (Point + circles + outlines)`);

  return { type: 'FeatureCollection', features };
}

function downloadMapboxStaticImage(point, polygons, adminArea, cityArea, outputPath, token) {
  return new Promise((resolve, reject) => {
    let url = undefined;
    const zoom = calculateZoomForWidth(point.lat, 16.0934); // ~10 miles width
    // Some Mapbox tokens are configured with URL (referrer) restrictions. Server-side requests
    // don't include a Referer header by default, so allow specifying one.
    const requestHeaders = {
      Referer: process.env.MAPBOX_REFERER || 'https://levante-pitwall.vercel.app/'
    };
    const doGet = (u) => https.get(u, { headers: requestHeaders }, handleResponse);

    // Build overlay
    let overlay = buildGeoJSONOverlay(point, polygons, adminArea, cityArea);
    let overlayJson = JSON.stringify(overlay);
    let overlayEncoded = encodeURIComponent(overlayJson);

    const polygonCount = overlay.features.filter(f => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon').length;
    const pointCount = overlay.features.filter(f => f.geometry.type === 'Point').length;
    console.log(`    Building overlay: ${overlay.features.length} features (${pointCount} points, ${polygonCount} polygons)`);
    overlay.features.forEach((f, idx) => {
      console.log(`      Feature ${idx + 1}: ${f.geometry.type}${f.properties ? ` (${Object.keys(f.properties).join(', ')})` : ''}`);
    });

    let isFallbackRequest = false;

    const requestMinimalOverlay = () => {
      if (isFallbackRequest) return;
      isFallbackRequest = true;

      const radiusKm = 1.60934;
      const minimalCirclePoints = 24;
      const circlePoints = [];
      for (let i = 0; i < minimalCirclePoints; i++) {
        const angle = (i / minimalCirclePoints) * 2 * Math.PI;
        const latOffset = (radiusKm / 111.0) * Math.cos(angle);
        const lonOffset = (radiusKm / (111.0 * Math.cos(point.lat * Math.PI / 180))) * Math.sin(angle);
        circlePoints.push([roundCoord(point.lon + lonOffset), roundCoord(point.lat + latOffset)]);
      }
      circlePoints.push(circlePoints[0]);

      const minimalOverlay = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
            properties: { 'marker-color': '#da3d16', 'marker-size': 'large' }
          },
          {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [circlePoints] },
            properties: { stroke: '#22c55e', 'stroke-width': 3, fill: '#22c55e', 'fill-opacity': 0.15 }
          }
        ]
      };
      const minimalEncoded = encodeURIComponent(JSON.stringify(minimalOverlay));
      const minimalUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${minimalEncoded})/${point.lon},${point.lat},${zoom}/1200x900@2x?access_token=${token}`;

      if (minimalUrl.length <= 8000) {
        console.log(`    Using minimal overlay (point + circle) - URL length: ${minimalUrl.length}`);
        doGet(minimalUrl);
      } else {
        console.warn(`    Minimal overlay also too long, falling back to simple map`);
        const simpleUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${point.lon},${point.lat},${zoom}/1200x900@2x?access_token=${token}`;
        doGet(simpleUrl);
      }
    };

    function handleResponse(res) {
      if (res.statusCode === 200) {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', async () => {
          try {
            const buffer = Buffer.concat(chunks);
            const nearestName = (polygons && polygons[0] && polygons[0].city && polygons[0].city.name)
              ? (() => {
                  const nm = polygons[0].city.name;
                  const km = polygons[0].city.distanceKm;
                  return (typeof km === 'number' && isFinite(km)) ? `${nm} (${km.toFixed(1)} km)` : nm;
                })()
              : 'City candidate';
            const localLevel = adminArea?.adminLevel || null;
            const countryUpper = (point?.country || '').toString().trim().toUpperCase();
            const stateHint = (polygons?.[0]?.city?.admin1 || '').toString().trim();

            let usLocalSource = null; // 'place' | 'tract' | null
            let effectiveLocalPolygon = adminArea?.polygon || null;
            let effectiveLocalName = (adminArea && adminArea.name) ? adminArea.name : (adminArea?.polygon?.properties?.name || 'Local outline');

            if (countryUpper === 'US' && stateHint) {
              const place = loadUsPlaceFeature(stateHint, point.lon, point.lat);
              if (place) {
                usLocalSource = 'place';
                effectiveLocalPolygon = place;
                effectiveLocalName = place?.properties?.name || effectiveLocalName;
              } else {
                const tract = loadUsTractFeature(stateHint, point.lon, point.lat);
                if (tract) {
                  usLocalSource = 'tract';
                  effectiveLocalPolygon = tract;
                  effectiveLocalName = tract?.properties?.name || effectiveLocalName;
                }
              }
            }

            const localName = effectiveLocalName;
            const cityAreaName = (cityArea && cityArea.name)
              ? cityArea.name
              : (cityArea?.polygon?.properties?.name || polygons?.[0]?.polygon?.properties?.name || 'City outline');
            const cityLevel = cityArea?.adminLevel || null;
            const escapeXml = (s = '') => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

            // Population: better estimate by summing GeoNames city populations inside the polygon.
            // Note: this is approximate (GeoNames cities5000-derived, filtered to pop>=1000).
            const localPopEst = estimatePopulationFromCities(effectiveLocalPolygon?.geometry, point?.country);
            const bluePopEst = estimatePopulationFromCities(cityArea?.polygon?.geometry, point?.country);
            const localPopText = localPopEst ? formatPopulation(localPopEst) : 'Unknown';
            const bluePopText = bluePopEst ? formatPopulation(bluePopEst) : 'Unknown';

            // Polygon pack download estimate (not basemap tiles)
            const dl = estimatePolygonPackDownload(point, adminArea, cityArea, polygons, usLocalSource);
            const dlText = `${formatBytes(dl.totalBytes)} (${dl.detail})`;

            // Weather snapshot (gallery has explicit coordinates, so this can be direct)
            let weatherLine = 'Weather: Unknown';
            let weatherTimeLine = '';
            try {
              const wx = await getCurrentWeatherForPoint(point.lat, point.lon);
              if (wx && Number.isFinite(wx.temperatureC)) {
                weatherLine = `Weather: ${Math.round(wx.temperatureC)}°C · ${wx.description || 'Unknown'}`;
                if (wx.observedAt) {
                  weatherTimeLine = `Observed: ${wx.observedAt}`;
                }
              }
            } catch (e) {
              // ignore; keep unknown
            }

            // Draw a pixel-space scale bar + label as ONE attached overlay (bottom-left).
            // This avoids any projection mismatch where the label "floats" away from the bar.
            const mapW = 2400; // 1200x900@2x
            const mapH = 1800;

            // Attached scale widget (label reflects the *actual* length represented by the bar)
            // Mapbox Static Images API request uses `@2x`, so pixel density is 2x.
            const TARGET_KM = 10;
            const meters = TARGET_KM * 1000;
            const latRad = (point.lat * Math.PI) / 180;

            // meters-per-pixel at zoom depends on whether the style behaves like 256px or 512px tiles.
            // At `@2x`, each output pixel represents half the distance.
            const pixelRatio = 2;
            const mPerPx256 = ((156543.03392 * Math.cos(latRad)) / Math.pow(2, zoom)) / pixelRatio;
            const mPerPx512 = ((78271.51696 * Math.cos(latRad)) / Math.pow(2, zoom)) / pixelRatio;
            const pxLen256 = meters / (mPerPx256 || 1e-9);
            const pxLen512 = meters / (mPerPx512 || 1e-9);

            const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
            const candidate = (mPerPx, pxLen) => {
              const unclamped = Math.round(pxLen);
              const barPx = clamp(unclamped, 70, 300);
              const kmActual = (barPx * (mPerPx || 0)) / 1000;
              const err = Math.abs(kmActual - TARGET_KM);
              // Prefer: closer to 10km and not heavily clamped.
              const clampPenalty = Math.abs(barPx - unclamped) * 0.05;
              return { barPx, kmActual, err: err + clampPenalty };
            };

            // Heuristic: choose the tile-size assumption that yields a more plausible km length for our bar.
            const c256 = candidate(mPerPx256, pxLen256);
            const c512 = candidate(mPerPx512, pxLen512);
            const chosen = (c256.err <= c512.err) ? c256 : c512;
            const barPx = chosen.barPx;
            const kmActual = chosen.kmActual;

            const scaleOverlayW = barPx + 50;
            const scaleOverlayH = 64;
            const barX1 = 20;
            const barX2 = barX1 + barPx;
            const barY = 40;
            const tickH = 10;

            const labelText = Number.isFinite(kmActual) ? `${kmActual.toFixed(1)} km` : 'Scale';
            const labelW = 76;
            const labelH = 26;
            const labelX = Math.round((barX1 + barX2) / 2 - labelW / 2);
            const labelY = 10;

            const scaleOverlaySvg = Buffer.from(`<svg width="${scaleOverlayW}" height="${scaleOverlayH}" viewBox="0 0 ${scaleOverlayW} ${scaleOverlayH}" xmlns="http://www.w3.org/2000/svg">
  <style>
    text { font-family: 'Inter', 'Helvetica', 'Arial', sans-serif; font-size: 14px; fill: #111827; font-weight: 700; }
  </style>
  <g>
    <line x1="${barX1}" y1="${barY}" x2="${barX2}" y2="${barY}" stroke="#111827" stroke-width="3" stroke-opacity="0.8" />
    <line x1="${barX1}" y1="${barY - tickH/2}" x2="${barX1}" y2="${barY + tickH/2}" stroke="#111827" stroke-width="3" stroke-opacity="0.8" />
    <line x1="${barX2}" y1="${barY - tickH/2}" x2="${barX2}" y2="${barY + tickH/2}" stroke="#111827" stroke-width="3" stroke-opacity="0.8" />
    <rect x="${labelX}" y="${labelY}" width="${labelW}" height="${labelH}" rx="8" ry="8" fill="white" fill-opacity="0.86" stroke="#e5e7eb" stroke-width="1"/>
    <text x="${Math.round(labelX + labelW/2)}" y="${Math.round(labelY + labelH/2) + 5}" text-anchor="middle">${escapeXml(labelText)}</text>
  </g>
</svg>`);
            const legendSvg = Buffer.from(`<svg width="780" height="820" viewBox="0 0 260 276" xmlns="http://www.w3.org/2000/svg">
  <style>
    text { font-family: 'Inter', 'Helvetica', 'Arial', sans-serif; font-size: 11px; fill: #111827; }
  </style>
  <rect x="12" y="12" width="236" height="252" rx="10" ry="10" fill="white" fill-opacity="0.85" stroke="#e5e7eb" stroke-width="1" />
  <rect x="24" y="32" width="18" height="18" fill="#da3d16" stroke="#da3d16" stroke-width="2" />
  <text x="50" y="46">GPS point</text>
  <rect x="24" y="62" width="18" height="18" fill="#22c55e" fill-opacity="0.26" stroke="#16a34a" stroke-width="2" />
  <text x="50" y="76">2 &amp; 10-mile circles</text>
  <rect x="24" y="92" width="18" height="18" fill="none" stroke="#dc2626" stroke-width="3" />
  <text x="50" y="106">Red: Local (ADM${escapeXml(String(localLevel || ''))}) ${escapeXml(localName)}</text>
  <text x="50" y="120">Pop: ${escapeXml(localPopText)}</text>
  <rect x="24" y="140" width="18" height="18" fill="none" stroke="#2563eb" stroke-width="3" />
  <text x="50" y="154">Blue: Regional (ADM${escapeXml(String(cityLevel || ''))}) ${escapeXml(cityAreaName)}</text>
  <text x="50" y="168">Pop: ${escapeXml(bluePopText)}</text>
  <text x="50" y="198">Polygons downloaded: ${escapeXml(dlText)}</text>
  <text x="50" y="224">${escapeXml(weatherLine)}</text>
  <text x="50" y="240">${escapeXml(weatherTimeLine)}</text>
</svg>`);
            await sharp(buffer)
              .composite([
                { input: legendSvg, left: 20, top: 20 },
                { input: scaleOverlaySvg, left: 20, top: mapH - scaleOverlayH - 20 }
              ])
              .webp({ quality: 85 })
              .toFile(outputPath);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      } else {
        let errorBody = '';
        res.on('data', chunk => {
          errorBody += chunk;
        });
        res.on('end', () => {
          if (!isFallbackRequest) {
            console.warn(`    Non-200 response (${res.statusCode}), attempting minimal overlay once`);
            return requestMinimalOverlay();
          }
          const errorMsg = errorBody.substring(0, 200);
          console.error('    Mapbox API error:', res.statusCode, errorMsg);
          reject(new Error('Mapbox API ' + res.statusCode + ': ' + errorMsg));
        });
      }
    }

if (token && !token.includes('rJcFIG214AriISLbB6B5aw')) {
      url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${overlayEncoded})/${point.lon},${point.lat},${zoom}/1200x900@2x?access_token=${token}`;
      
      // Increased URL length limit - Chrome supports up to 2MB, but we'll use 32KB for safety
      // Mapbox Static Images API should handle this, but if it fails we'll fall back
      const MAX_URL_LENGTH = 32000;
      let simplificationAttempts = 0;
      // More gradual tolerance progression to preserve shape better
      // Start with very small tolerance and increase gradually
      const toleranceSteps = [0.0001, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0];
      let currentTolerance = toleranceSteps[0];

      while (url && url.length > MAX_URL_LENGTH && simplificationAttempts < toleranceSteps.length) {
        simplificationAttempts++;
        currentTolerance = toleranceSteps[simplificationAttempts - 1];
        console.warn(`    URL too long (${url.length} chars). Attempting simplification with tolerance: ${currentTolerance}`);

        const simplifiedFeatures = overlay.features.map(feature => {
          if (feature.geometry && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')) {
            // Simplify and fix geometry
            let simplified = simplifyPolygon(feature.geometry, currentTolerance);
            simplified = fixPolygonGeometry(simplified); // Fix any issues introduced by simplification
            return { ...feature, geometry: simplified };
          }
          return feature;
        }).filter(isValidGeoJSONFeature); // Filter out invalid features
        
        if (simplifiedFeatures.length === 0) {
          console.warn(`    All features became invalid after simplification, skipping simplification`);
          break; // Stop simplification attempts
        }
        
        overlay = { type: 'FeatureCollection', features: simplifiedFeatures };
        overlayJson = JSON.stringify(overlay);
        overlayEncoded = encodeURIComponent(overlayJson);
        url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${overlayEncoded})/${point.lon},${point.lat},${zoom}/1200x900@2x?access_token=${token}`;
      }

      if (url && url.length > MAX_URL_LENGTH) {
        console.warn(`    URL still too long after simplification (${url.length} chars), trying minimal overlay (point + circle + scale)`);
        // Try minimal overlay with just point, circle, and scale bar
        const radiusKm = 1.60934;
        const circlePoints = [];
        for (let i = 0; i < 64; i++) {
          const angle = (i / 64) * 2 * Math.PI;
          const latOffset = (radiusKm / 111.0) * Math.cos(angle);
          const lonOffset = (radiusKm / (111.0 * Math.cos(point.lat * Math.PI / 180))) * Math.sin(angle);
          circlePoints.push([point.lon + lonOffset, point.lat + latOffset]);
        }
        circlePoints.push(circlePoints[0]);
        
        const minimalOverlay = {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
              properties: { 'marker-color': '#da3d16', 'marker-size': 'large' }
            },
            {
              type: 'Feature',
              geometry: { type: 'Polygon', coordinates: [circlePoints] },
              properties: { stroke: '#22c55e', 'stroke-width': 3, fill: '#22c55e', 'fill-opacity': 0.15 }
            }
          ]
        };
        const minimalEncoded = encodeURIComponent(JSON.stringify(minimalOverlay));
        const minimalUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${minimalEncoded})/${point.lon},${point.lat},${zoom}/1200x900@2x?access_token=${token}`;
        
        if (minimalUrl.length <= 8000) {
          console.log(`    Using minimal overlay (point + circle) - URL length: ${minimalUrl.length}`);
          doGet(minimalUrl);
        } else {
          console.warn(`    Minimal overlay also too long (${minimalUrl.length} chars), using simple map without overlays`);
          const simpleUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${point.lon},${point.lat},${zoom}/1200x900@2x?access_token=${token}`;
          doGet(simpleUrl);
        }
      } else {
        // Validate all features before sending
        const invalidFeatures = overlay.features.filter(f => !isValidGeoJSONFeature(f));
        if (invalidFeatures.length > 0) {
          console.warn(`    Found ${invalidFeatures.length} invalid features, filtering them out`);
          overlay.features = overlay.features.filter(f => isValidGeoJSONFeature(f));
          overlayJson = JSON.stringify(overlay);
          overlayEncoded = encodeURIComponent(overlayJson);
          url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${overlayEncoded})/${point.lon},${point.lat},${zoom}/1200x900@2x?access_token=${token}`;
        }
        
        // Final validation before sending
        if (overlay.features.length === 0) {
          console.warn(`    No valid features remaining, trying minimal overlay (point + circle + scale)`);
          // Build minimal overlay with point, circle, and scale
          const radiusKm = 1.60934;
          const circlePoints = [];
          for (let i = 0; i < 64; i++) {
            const angle = (i / 64) * 2 * Math.PI;
            const latOffset = (radiusKm / 111.0) * Math.cos(angle);
            const lonOffset = (radiusKm / (111.0 * Math.cos(point.lat * Math.PI / 180))) * Math.sin(angle);
            circlePoints.push([point.lon + lonOffset, point.lat + latOffset]);
          }
          circlePoints.push(circlePoints[0]);
          
          const scaleKm = 10;
          const scaleLatDegrees = scaleKm / 111.0;
          const scaleLonDegrees = scaleKm / (111.0 * Math.cos(point.lat * Math.PI / 180));
          const padFactor = 1.25;
          const padLat = (8.0467 / 111.0) * padFactor;
          const scaleLat = point.lat - padLat;
          const padLon = (8.0467 / (111.0 * Math.cos(point.lat * Math.PI / 180))) * padFactor;
          const scaleLon = point.lon - padLon;
          const tickLength = 0.005;
          
          const minimalOverlay = {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
                properties: { 'marker-color': '#da3d16', 'marker-size': 'large' }
              },
              {
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [circlePoints] },
                properties: { stroke: '#22c55e', 'stroke-width': 3, fill: '#22c55e', 'fill-opacity': 0.15 }
              },
              {
                type: 'Feature',
                geometry: {
                  type: 'LineString',
                  coordinates: [[scaleLon, scaleLat], [scaleLon + scaleLonDegrees, scaleLat]]
                },
                properties: { stroke: '#111827', 'stroke-width': 1, 'stroke-opacity': 0.65 }
              },
              {
                type: 'Feature',
                geometry: {
                  type: 'LineString',
                  coordinates: [[scaleLon, scaleLat - tickLength], [scaleLon, scaleLat + tickLength]]
                },
                properties: { stroke: '#111827', 'stroke-width': 1, 'stroke-opacity': 0.65 }
              },
              {
                type: 'Feature',
                geometry: {
                  type: 'LineString',
                  coordinates: [[scaleLon + scaleLonDegrees, scaleLat - tickLength], [scaleLon + scaleLonDegrees, scaleLat + tickLength]]
                },
                properties: { stroke: '#111827', 'stroke-width': 1, 'stroke-opacity': 0.65 }
              }
            ]
          };
          const minimalEncoded = encodeURIComponent(JSON.stringify(minimalOverlay));
          const minimalUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${minimalEncoded})/${point.lon},${point.lat},${zoom}/1200x900@2x?access_token=${token}`;
          
          if (minimalUrl.length <= 8000) {
            console.log(`    Using minimal overlay - URL length: ${minimalUrl.length}`);
            doGet(minimalUrl);
          } else {
            console.warn(`    Minimal overlay too long, using simple map without overlays`);
            const simpleUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${point.lon},${point.lat},${zoom}/1200x900@2x?access_token=${token}`;
            doGet(simpleUrl);
          }
        } else {
          try {
            const testJson = JSON.parse(overlayJson);
            if (!testJson.type || testJson.type !== 'FeatureCollection' || !Array.isArray(testJson.features) || testJson.features.length === 0) {
              throw new Error('Invalid FeatureCollection structure');
            }
            // If validation passes, send the request
            if (url) {
              doGet(url);
            } else {
              reject(new Error('URL not initialized'));
            }
          } catch (validationError) {
            console.warn(`    GeoJSON validation failed: ${validationError.message}, trying minimal overlay`);
            // Build minimal overlay with point, circle, and scale
            const radiusKm = 1.60934;
            const circlePoints = [];
            for (let i = 0; i < 64; i++) {
              const angle = (i / 64) * 2 * Math.PI;
              const latOffset = (radiusKm / 111.0) * Math.cos(angle);
              const lonOffset = (radiusKm / (111.0 * Math.cos(point.lat * Math.PI / 180))) * Math.sin(angle);
              circlePoints.push([point.lon + lonOffset, point.lat + latOffset]);
            }
            circlePoints.push(circlePoints[0]);
            
            const scaleKm = 10;
            const scaleLatDegrees = scaleKm / 111.0;
            const scaleLonDegrees = scaleKm / (111.0 * Math.cos(point.lat * Math.PI / 180));
            const padFactor = 1.25;
          const padLat = (8.0467 / 111.0) * padFactor;
          const scaleLat = point.lat - padLat;
          const padLon = (8.0467 / (111.0 * Math.cos(point.lat * Math.PI / 180))) * padFactor;
          const scaleLon = point.lon - padLon;
            const tickLength = 0.005;
            
            const minimalOverlay = {
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
                  properties: { 'marker-color': '#da3d16', 'marker-size': 'large' }
                },
                {
                  type: 'Feature',
                  geometry: { type: 'Polygon', coordinates: [circlePoints] },
                  properties: { stroke: '#22c55e', 'stroke-width': 3, fill: '#22c55e', 'fill-opacity': 0.15 }
                },
                {
                  type: 'Feature',
                  geometry: {
                    type: 'LineString',
                    coordinates: [[scaleLon, scaleLat], [scaleLon + scaleLonDegrees, scaleLat]]
                  },
                  properties: { stroke: '#111827', 'stroke-width': 1, 'stroke-opacity': 0.65 }
                },
                {
                  type: 'Feature',
                  geometry: {
                    type: 'LineString',
                    coordinates: [[scaleLon, scaleLat - tickLength], [scaleLon, scaleLat + tickLength]]
                  },
                  properties: { stroke: '#111827', 'stroke-width': 1, 'stroke-opacity': 0.65 }
                },
                {
                  type: 'Feature',
                  geometry: {
                    type: 'LineString',
                    coordinates: [[scaleLon + scaleLonDegrees, scaleLat - tickLength], [scaleLon + scaleLonDegrees, scaleLat + tickLength]]
                  },
                  properties: { stroke: '#111827', 'stroke-width': 1, 'stroke-opacity': 0.65 }
                }
              ]
            };
            const minimalEncoded = encodeURIComponent(JSON.stringify(minimalOverlay));
            const minimalUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${minimalEncoded})/${point.lon},${point.lat},${zoom}/1200x900@2x?access_token=${token}`;
            
            if (minimalUrl.length <= 8000) {
              console.log(`    Using minimal overlay - URL length: ${minimalUrl.length}`);
              doGet(minimalUrl);
            } else {
              console.warn(`    Minimal overlay too long, using simple map without overlays`);
              const simpleUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${point.lon},${point.lat},${zoom}/1200x900@2x?access_token=${token}`;
              doGet(simpleUrl);
            }
          }
        }
      }
    } else {
      const errorMsg = 'Mapbox token required. Set MAPBOX_ACCESS_TOKEN environment variable.';
      console.error(`    Error: ${errorMsg}`);
      reject(new Error(errorMsg));
    }
  });
}

async function generateImage(data, index, total) {
  const { point, polygons = [], adminArea, cityArea } = data;
  // Get token from main scope (passed via closure) or process.env
  const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN;
  
  if (!mapboxToken) {
    console.error(`    Error: MAPBOX_ACCESS_TOKEN not set. Skipping ${point.id}`);
    return;
  }
  
  const imageFile = path.join(OUTPUT_DIR, `${point.id}.webp`);
  
  console.log(`[${index + 1}/${total}] Generating ${point.id}.webp...`);
  
  try {
    await downloadMapboxStaticImage(point, polygons, adminArea, cityArea, imageFile, mapboxToken);
    console.log(`[${index + 1}/${total}] Generated ${point.id}.webp`);
  } catch (error) {
    console.error(`[${index + 1}/${total}] Failed to generate ${point.id}.webp:`, error.message);
  }
}

async function main() {
  console.log('Generating Gallery Images\n');

  // Optional: only generate specific point ids (comma-separated), e.g.
  //   node scripts/generate-gallery-images.js --only=GB-aberdeen
  //   node scripts/generate-gallery-images.js --only GB-aberdeen,GB-glasgow
  const argv = process.argv.slice(2);
  const onlyIdx = argv.findIndex((a) => a === '--only');
  const onlyArg =
    argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ||
    (onlyIdx >= 0 ? argv[onlyIdx + 1] : null);
  const onlyIds = (onlyArg || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const onlySet = new Set(onlyIds.map((s) => s.toLowerCase()));
  if (onlySet.size) {
    console.log(`🔎 Only generating: ${Array.from(onlySet).join(', ')}`);
  }
  
  // Check for token early - must be exported in shell environment
  const token = process.env.MAPBOX_ACCESS_TOKEN;
  if (!token) {
    console.error('❌ ERROR: MAPBOX_ACCESS_TOKEN not found in environment');
    console.error('   The token must be exported in your shell before running this script');
    console.error('   Try: export MAPBOX_ACCESS_TOKEN=your_token_here');
    console.error('   Or: MAPBOX_ACCESS_TOKEN=your_token_here node scripts/generate-gallery-images.js\n');
    process.exit(1);
  } else {
    console.log(`✅ MAPBOX_ACCESS_TOKEN found\n`);
  }

  const tokenOk = await validateMapboxStaticImagesToken(token);
  if (!tokenOk) {
    console.error('❌ ERROR: MAPBOX_ACCESS_TOKEN is not authorized for the Mapbox Static Images API.');
    console.error('   The generator requires a token that can access `styles/v1/.../static/...`.');
    console.error('   Fix by using a token from a Mapbox account with Static Images enabled (and no restrictive URL rules), then retry.\n');
    process.exit(1);
  }
  
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`Error: Data file not found: ${DATA_FILE}`);
    console.error('   Run "node scripts/generate-locate-me-gallery.js" first');
    process.exit(1);
  }
  
  const galleryData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const allResults = galleryData.results;
  
  // Filter to only include results with polygons
  const resultsWithPolygons = allResults.filter((result) => {
    const hasCity = result?.cityArea?.polygon?.geometry;
    const hasAdmin = result?.adminArea?.polygon?.geometry;
    const legacy = result?.polygons && result.polygons.some((p) => p?.polygon?.geometry);
    return Boolean(hasCity || hasAdmin || legacy);
  });

  const filtered = onlySet.size
    ? resultsWithPolygons.filter((r) => {
        const id = (r?.point?.id || '').toString().toLowerCase();
        return id && onlySet.has(id);
      })
    : resultsWithPolygons;
  
  console.log(`Total results: ${allResults.length}`);
  console.log(`Results with polygons: ${resultsWithPolygons.length}`);
  console.log(`Filtered out: ${allResults.length - resultsWithPolygons.length} results without polygons\n`);
  if (onlySet.size) {
    console.log(`Processing ${filtered.length} (filtered) results...\n`);
  } else {
    console.log(`Processing ${resultsWithPolygons.length} results with polygons...\n`);
  }
  
  for (let i = 0; i < filtered.length; i++) {
    await generateImage(filtered[i], i, filtered.length);
  }
  
  console.log(`\nGenerated ${filtered.length} images in ${OUTPUT_DIR}`);
  console.log(`\n📄 Next step: Open public/gallery/locate-me/index.html to view the gallery`);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { generateImage };

