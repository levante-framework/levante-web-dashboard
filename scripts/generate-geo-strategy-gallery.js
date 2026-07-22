#!/usr/bin/env node

/**
 * Generate Geo Strategy Gallery Data
 *
 * Builds de-identified location outputs for the 46 demo sites:
 * - Faux location shift (1km)
 * - H3 base/effective cells + outlines (adaptive by privacy threshold)
 * - WorldPop 1km tile summaries (7x7/5x5/3x3/1x1) for diagnostics
 * - ADM2 / ADM3 names + population estimate (filtered by threshold)
 * - Weather (original GPS)
 * - Population density (1km tile at original GPS)
 * - Nearest school (faux location, Overpass)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { Storage } = require('@google-cloud/storage');
const h3 = require('h3-js');

const OUTPUT_DIR = path.join(process.cwd(), 'public', 'gallery', 'geo-strategy');
const DATA_FILE = path.join(OUTPUT_DIR, 'gallery-data.json');
const SEED_FILE = path.join(process.cwd(), 'public', 'gallery', 'locate-me', 'seed-points.json');
const ADM_PACK_DIR = path.join(process.cwd(), 'public', 'adm-packs');

const SHIFT_KM = Number(process.env.GEO_SHIFT_KM || 1);
const WEATHER_ROUNDING_DEG = Number(process.env.GEO_WEATHER_ROUNDING_DEG || 0);
const SCHOOL_RADIUS_M = Number(process.env.GEO_SCHOOL_RADIUS_M || 5000);

// H3 configuration
// Policy-imposed minimum population threshold
const POP_THRESHOLD = Number(process.env.GEO_POP_THRESHOLD || 20000);

// "Happy medium" for effeciency & privacy
const H3_BASE_RES = Number(process.env.GEO_H3_BASE_RES || 5);

// Policy-imposed minimum hex size
const H3_EFFECTIVE_MAX_RES = Number(process.env.GEO_H3_EFFECTIVE_MAX_RES || 7);
const H3_POPULATION_SOURCE = String(process.env.GEO_H3_POPULATION_SOURCE || 'kontur').toLowerCase();

// Tile summaries for diagnostics -- no longer used for production
const TILE_SIZES = [1, 3, 5, 7];
const TILE_HALF_KM = 0.5;

const WORLDPOP_CACHE_PATH = path.join(process.cwd(), 'data', 'gallery', 'geo-strategy-worldpop-cache.json');
const WEATHER_CACHE_PATH = path.join(process.cwd(), 'data', 'gallery', 'geo-strategy-weather-cache.json');
const AIR_QUALITY_CACHE_PATH = path.join(process.cwd(), 'data', 'gallery', 'geo-strategy-air-quality-cache.json');
// AQICN / WAQI token for the privacy-masked air quality lookup (server-only).
const WAQI_TOKEN = process.env.WAQI_TOKEN || process.env.AQICN_TOKEN || '';
const OVERPASS_CACHE_PATH = path.join(process.cwd(), 'data', 'gallery', 'geo-strategy-overpass-cache.json');
const KONTUR_H3_CACHE_PATH = path.join(process.cwd(), 'data', 'gallery', 'kontur-h3-population-cache.json');

const BOUNDARY_PACKS_BUCKET = process.env.BOUNDARY_PACKS_BUCKET || 'levante-assets-draft';
const BOUNDARY_PACKS_PREFIX = process.env.BOUNDARY_PACKS_PREFIX || 'maps/boundaries';
let gcsStorage = null;
let gcsInitialized = false;

const SHIFT_DIRECTIONS = [
  { id: 'N', dx: 0, dy: 1 },
  { id: 'NE', dx: 1, dy: 1 },
  { id: 'E', dx: 1, dy: 0 },
  { id: 'SE', dx: 1, dy: -1 },
  { id: 'S', dx: 0, dy: -1 },
  { id: 'SW', dx: -1, dy: -1 },
  { id: 'W', dx: -1, dy: 0 },
  { id: 'NW', dx: -1, dy: 1 }
];

// Map ISO2 country codes to ISO3 codes for WorldPop API
// New countries should be added here
const ISO2_TO_ISO3 = {
  US: 'USA',
  CA: 'CAN',
  CO: 'COL',
  IN: 'IND',
  AR: 'ARG',
  NL: 'NLD',
  GH: 'GHA',
  CH: 'CHE',
  DE: 'DEU',
  GB: 'GBR'
};

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const arg of args) {
    if (arg.startsWith('--pop-threshold=')) {
      out.popThreshold = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--shift-km=')) {
      out.shiftKm = Number(arg.split('=')[1]);
    } else if (arg === '--augment-air-quality') {
      out.augmentAirQuality = true;
    } else if (arg === '--augment-weather') {
      out.augmentWeather = true;
    } else if (arg.startsWith('--files=')) {
      out.files = arg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

function initializeGCS() {
  if (gcsInitialized) return gcsStorage;
  gcsInitialized = true;
  try {
    const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (serviceAccountJson) {
      const credentials = JSON.parse(serviceAccountJson);
      gcsStorage = new Storage({
        projectId: credentials.project_id,
        credentials: credentials
      });
    } else {
      gcsStorage = new Storage();
    }
  } catch (_) {
    gcsStorage = null;
  }
  return gcsStorage;
}

async function loadAdmPackFromGCS(countryCode, relativePath) {
  const storage = initializeGCS();
  if (!storage) return null;
  const bucket = storage.bucket(BOUNDARY_PACKS_BUCKET);
  const remotePath = `${BOUNDARY_PACKS_PREFIX}/${countryCode}/${relativePath}`;
  try {
    const [exists] = await bucket.file(remotePath).exists();
    if (!exists) return null;
    const [file] = await bucket.file(remotePath).download();
    const raw = zlib.gunzipSync(file).toString('utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function loadJsonGz(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  } catch (_) {
    return null;
  }
}

const admPackCache = new Map();

async function loadAdmPack(countryIso2, level) {
  const iso = (countryIso2 || '').toLowerCase();
  const key = `${iso}|${level}`;
  if (admPackCache.has(key)) return admPackCache.get(key);

  const fileName = `${level}.json.gz`;
  const localPath = path.join(ADM_PACK_DIR, iso, fileName);
  if (fs.existsSync(localPath)) {
    const data = loadJsonGz(localPath);
    admPackCache.set(key, data);
    return data;
  }

  const gcsData = await loadAdmPackFromGCS(iso, fileName);
  if (gcsData) {
    admPackCache.set(key, gcsData);
    return gcsData;
  }

  admPackCache.set(key, null);
  return null;
}

function kmToLatDelta(km) {
  return km / 111.0;
}

function kmToLonDelta(km, lat) {
  const denom = 111.0 * Math.cos(lat * Math.PI / 180);
  return denom ? (km / denom) : 0;
}

function roundCoordFixed(value, decimals = 6) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function buildKmSquareGeometry(centerLon, centerLat, halfKm) {
  const latOffset = kmToLatDelta(halfKm);
  const lonOffset = kmToLonDelta(halfKm, centerLat);
  const ring = [
    [roundCoordFixed(centerLon - lonOffset), roundCoordFixed(centerLat - latOffset)],
    [roundCoordFixed(centerLon + lonOffset), roundCoordFixed(centerLat - latOffset)],
    [roundCoordFixed(centerLon + lonOffset), roundCoordFixed(centerLat + latOffset)],
    [roundCoordFixed(centerLon - lonOffset), roundCoordFixed(centerLat + latOffset)],
    [roundCoordFixed(centerLon - lonOffset), roundCoordFixed(centerLat - latOffset)]
  ];
  return { type: 'Polygon', coordinates: [ring] };
}

function distanceKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + sinDLon * sinDLon * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
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

function pickDirection(id) {
  const hash = crypto.createHash('sha256').update(String(id || '')).digest('hex');
  const idx = parseInt(hash.slice(0, 8), 16) % SHIFT_DIRECTIONS.length;
  return SHIFT_DIRECTIONS[idx];
}

function shiftLocation(point, shiftKm) {
  const dir = pickDirection(point.id);
  const diag = shiftKm / Math.sqrt(2);
  const dxKm = dir.dx !== 0 && dir.dy !== 0 ? dir.dx * diag : dir.dx * shiftKm;
  const dyKm = dir.dx !== 0 && dir.dy !== 0 ? dir.dy * diag : dir.dy * shiftKm;
  const newLat = point.lat + kmToLatDelta(dyKm);
  const newLon = point.lon + kmToLonDelta(dxKm, point.lat);
  return {
    lat: roundCoordFixed(newLat, 6),
    lon: roundCoordFixed(newLon, 6),
    direction: dir.id,
    shiftKm: shiftKm
  };
}

let worldPopCache = null;
let konturH3Cache = null;
const h3PopulationCache = new Map();

function loadKonturH3Cache() {
  if (konturH3Cache) return konturH3Cache;
  try {
    if (fs.existsSync(KONTUR_H3_CACHE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(KONTUR_H3_CACHE_PATH, 'utf8'));
      const out = {};
      if (parsed && typeof parsed === 'object' && parsed.resolutions && typeof parsed.resolutions === 'object') {
        for (const [resKey, values] of Object.entries(parsed.resolutions)) {
          if (values && typeof values === 'object') out[String(resKey)] = values;
        }
      } else {
        // Backward-compatible flat map support: { "6|cellId": 1234 }
        for (const [k, v] of Object.entries(parsed || {})) {
          if (typeof v !== 'number') continue;
          const parts = String(k).split('|');
          if (parts.length !== 2) continue;
          const [res, cellId] = parts;
          if (!out[res]) out[res] = {};
          out[res][cellId] = Math.round(v);
        }
      }
      konturH3Cache = out;
    } else {
      konturH3Cache = {};
    }
  } catch (_) {
    konturH3Cache = {};
  }
  return konturH3Cache;
}

function lookupKonturH3Population(cellId, resolution) {
  if (!cellId) return null;
  const cache = loadKonturH3Cache();
  const resKey = String(resolution);
  const exact = cache[resKey] && cache[resKey][cellId];
  if (typeof exact === 'number' && Number.isFinite(exact) && exact >= 0) {
    return Math.round(exact);
  }

  // If we only have finer Kontur cells (for example r6) we can aggregate descendants
  // to estimate coarser cells (for example r5).
  const availableRes = Object.keys(cache)
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
  const finerRes = availableRes.find((r) => r > resolution);
  if (!Number.isInteger(finerRes)) return null;
  if (!cache[String(finerRes)]) return null;
  let sum = 0;
  let seen = 0;
  try {
    const children = h3.cellToChildren(cellId, finerRes);
    for (const child of children) {
      const value = cache[String(finerRes)][child];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        sum += value;
        seen += 1;
      }
    }
  } catch (_) {
    return null;
  }
  return seen ? Math.round(sum) : null;
}

function loadWorldPopCache() {
  if (worldPopCache) return worldPopCache;
  try {
    if (fs.existsSync(WORLDPOP_CACHE_PATH)) {
      worldPopCache = JSON.parse(fs.readFileSync(WORLDPOP_CACHE_PATH, 'utf8'));
    } else {
      worldPopCache = {};
    }
  } catch (_) {
    worldPopCache = {};
  }
  return worldPopCache;
}

function saveWorldPopCache() {
  try {
    fs.mkdirSync(path.dirname(WORLDPOP_CACHE_PATH), { recursive: true });
    fs.writeFileSync(WORLDPOP_CACHE_PATH, JSON.stringify(worldPopCache || {}, null, 2));
  } catch (_) {}
}

async function estimatePopulationFromWorldPop(geometry, countryCode) {
  if (!geometry || !geometry.type || !geometry.coordinates) return null;
  if (!countryCode) return null;

  const iso3Code = ISO2_TO_ISO3[countryCode.toUpperCase()];
  if (!iso3Code) return null;

  const geomStr = JSON.stringify(geometry);
  const cacheKey = crypto.createHash('sha256').update(geomStr + iso3Code).digest('hex').substring(0, 16);

  const cache = loadWorldPopCache();
  const cached = cache[cacheKey];
  const now = Date.now();
  if (cached && cached.expiresAt && now < cached.expiresAt && cached.population !== null) {
    return cached.population;
  }

  try {
    const scriptPath = path.join(__dirname, 'estimate-population-worldpop.py');
    const geojson = { type: 'Feature', geometry: geometry };
    const geojsonStr = JSON.stringify(geojson);
    const escapedGeojson = geojsonStr.replace(/'/g, "'\\''");
    const venvPython = path.join(__dirname, '..', 'venv', 'bin', 'python3');
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : 'python3';
    const result = execSync(
      `"${pythonCmd}" "${scriptPath}" "${iso3Code}" '${escapedGeojson}'`,
      {
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        cwd: path.dirname(scriptPath)
      }
    );

    const population = parseInt(result.trim(), 10);
    if (Number.isNaN(population) || population < 0) return null;
    const resultValue = Math.round(population);
    cache[cacheKey] = {
      fetchedAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      population: resultValue
    };
    saveWorldPopCache();
    return resultValue;
  } catch (error) {
    const msg = error?.message || '';
    if (msg.includes('WorldPop raster not found')) {
      console.warn(`WorldPop raster not found for ${iso3Code}. Run: ./scripts/download-worldpop-rasters.sh ${iso3Code}`);
    }
    return null;
  }
}

function h3CellToPolygonGeometry(cellId) {
  const boundaryLatLon = h3.cellToBoundary(cellId);
  if (!Array.isArray(boundaryLatLon) || !boundaryLatLon.length) return null;
  const ring = boundaryLatLon.map(([lat, lon]) => [roundCoordFixed(lon, 6), roundCoordFixed(lat, 6)]);
  if (!ring.length) return null;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!last || first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

async function buildH3ResolutionInfo(lat, lon, countryCode, res, threshold) {
  const cellId = h3.latLngToCell(lat, lon, res);
  const cacheKey = `${countryCode || ''}|${cellId}`;
  let cached = h3PopulationCache.get(cacheKey);
  let population = cached ? cached.population : undefined;
  let source = cached ? cached.source : null;
  let geometry = null;
  if (population === undefined) {
    if (H3_POPULATION_SOURCE === 'kontur' || H3_POPULATION_SOURCE === 'auto') {
      population = lookupKonturH3Population(cellId, res);
      source = typeof population === 'number' ? 'kontur' : null;
    }
    if (population === undefined || population === null) {
      geometry = h3CellToPolygonGeometry(cellId);
      population = geometry ? await estimatePopulationFromWorldPop(geometry, countryCode) : null;
      source = typeof population === 'number' ? 'worldpop' : source;
    }
    h3PopulationCache.set(cacheKey, { population, source });
  }
  if (!geometry) {
    geometry = h3CellToPolygonGeometry(cellId);
  }
  const popValue = typeof population === 'number' ? population : null;
  return {
    id: cellId,
    resolution: res,
    population: popValue,
    populationSource: source || null,
    privacyMet: typeof popValue === 'number' ? popValue >= threshold : false,
    outline: geometry
      ? {
          type: 'Feature',
          properties: {
            source: 'h3',
            id: cellId,
            resolution: res,
            population: popValue,
            populationSource: source || null,
            privacyMet: typeof popValue === 'number' ? popValue >= threshold : false
          },
          geometry
        }
      : null
  };
}

class Location {
  constructor(point, options) {
    this.point = point;
    this.options = options;
  }

  async resolveH3Cells(faux) {
    const countryCode = this.point.country;
    const threshold = this.options.popThreshold;
    const baseRes = this.options.h3BaseRes;
    const maxRes = this.options.h3EffectiveMaxRes;

    const base = await buildH3ResolutionInfo(faux.lat, faux.lon, countryCode, baseRes, threshold);
    const candidates = [];
    for (let res = maxRes; res >= 0; res--) {
      candidates.push(await buildH3ResolutionInfo(faux.lat, faux.lon, countryCode, res, threshold));
    }
    const effective = candidates.find((c) => c.privacyMet) || candidates[candidates.length - 1];
    const candidateByResolution = {};
    candidates.forEach((candidate) => {
      candidateByResolution[String(candidate.resolution)] = {
        id: candidate.id,
        population: candidate.population,
        populationSource: candidate.populationSource || null,
        privacyMet: candidate.privacyMet === true
      };
    });
    return {
      scheme: 'h3_v1',
      threshold,
      base,
      effective,
      candidates: candidateByResolution,
      outlines: {
        type: 'FeatureCollection',
        features: [base.outline, effective.outline].filter(Boolean)
      }
    };
  }

  async build() {
    const point = this.point;
    const options = this.options;
    const faux = shiftLocation(point, options.shiftKm);
    // Tile summaries are retained for comparability/density context; H3 is the primary privacy geometry.
    const tileGrid = await buildTilePopulationGrid(faux, point.country);
    const totals = {};
    for (const size of TILE_SIZES) {
      const entry = sumTileGrid(tileGrid, size);
      totals[String(size)] = { ...entry, size };
    }
    const selection = selectTileGrid(totals, options.popThreshold);

    const adm2 = await resolveAdmArea(point.country, faux.lat, faux.lon, 'adm2', options.popThreshold);
    const adm3 = await resolveAdmArea(point.country, faux.lat, faux.lon, 'adm3', options.popThreshold);

    const weather = await getCurrentWeatherForPoint(point.lat, point.lon).catch(() => null);
    const elevationM = weather?.elevationM ?? null;

    // Privacy-masked air quality: request an area around the faux location, then
    // pick the station closest to the raw seed point (raw GPS used only locally).
    const airQuality = await getAirQualityForPoint(point.lat, point.lon, faux).catch(() => null);

    const densityTile = buildKmSquareGeometry(point.lon, point.lat, TILE_HALF_KM);
    const densityPop = await estimatePopulationFromWorldPop(densityTile, point.country);
    const populationDensityPerKm2 = typeof densityPop === 'number' ? densityPop : null;

    const school = await fetchNearestSchool(faux.lat, faux.lon);
    // Resolve base/effective H3 cells for the de-identified area representation.
    const h3Cells = await this.resolveH3Cells(faux);

    return {
      id: point.id,
      label: point.label,
      country: point.country,
      gps: {
        lat: point.lat,
        lon: point.lon
      },
      fauxLocation: faux,
      tileGrid: {
        sizeSelected: selection?.size || null,
        populationSelected: selection?.total ?? null,
        areaKm2: selection?.size ? selection.size * selection.size : null,
        totals: Object.fromEntries(
          Object.entries(totals).map(([size, entry]) => [size, entry.total])
        )
      },
      h3: h3Cells,
      adm: {
        adm2: adm2 || null,
        adm3: adm3 || null,
        populationThreshold: options.popThreshold
      },
      weather: weather ? {
        temperatureC: weather.temperatureC,
        humidity: weather.humidity ?? null,
        heatIndexC: weather.heatIndexC ?? null,
        cloudCover: weather.cloudCover ?? null,
        windKph: weather.windKph ?? null,
        description: weather.description,
        observedAt: weather.observedAt,
        query: weather.query
      } : null,
      airQuality: airQuality || null,
      altitudeM: elevationM,
      populationDensityPerKm2,
      nearestSchool: school
    };
  }
}

async function buildTilePopulationGrid(center, countryCode) {
  const grid = new Map();
  const offsets = [-3, -2, -1, 0, 1, 2, 3];
  for (const dy of offsets) {
    const tileLat = center.lat + kmToLatDelta(dy);
    for (const dx of offsets) {
      const tileLon = center.lon + kmToLonDelta(dx, tileLat);
      const key = `${dy},${dx}`;
      const geom = buildKmSquareGeometry(tileLon, tileLat, TILE_HALF_KM);
      const tilePop = await estimatePopulationFromWorldPop(geom, countryCode);
      grid.set(key, tilePop);
    }
  }
  return grid;
}

function sumTileGrid(grid, size) {
  const half = Math.floor(size / 2);
  let total = 0;
  let hasAny = false;
  let tileCount = 0;
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const key = `${dy},${dx}`;
      const pop = grid.get(key);
      tileCount += 1;
      if (typeof pop === 'number' && pop >= 0) {
        total += pop;
        hasAny = true;
      }
    }
  }
  return { total, hasAny, tileCount };
}

function selectTileGrid(totals, threshold) {
  for (const size of TILE_SIZES) {
    const entry = totals[String(size)];
    if (entry && entry.hasAny && entry.total >= threshold) {
      return { size, total: entry.total, tileCount: entry.tileCount };
    }
  }
  const fallback = totals['7'] || totals['5'] || totals['3'] || totals['1'] || null;
  if (!fallback) return null;
  const size = fallback.size || 7;
  return { size, total: fallback.total, tileCount: fallback.tileCount };
}

function featureName(feature, level) {
  if (!feature?.properties) return `${level}-unknown`;
  return (
    feature.properties.name ||
    feature.properties.NAME_1 ||
    feature.properties.NAME_2 ||
    feature.properties.NAME_3 ||
    feature.properties.shapeName ||
    feature.properties.NAME ||
    feature.properties.name_en ||
    `${level}-unknown`
  );
}

function bestContainingFeature(features, lon, lat) {
  if (!Array.isArray(features) || !features.length) return null;
  const pt = [lon, lat];
  let best = null;
  let bestArea = Infinity;
  for (const f of features) {
    if (!f?.geometry) continue;
    if (!pointInPolygon(pt, f.geometry)) continue;
    const area = geometryAreaApprox(f.geometry);
    if (area < bestArea) {
      bestArea = area;
      best = f;
    }
  }
  return best;
}

async function resolveAdmArea(country, lat, lon, level, popThreshold) {
  const pack = await loadAdmPack(country, level);
  if (!pack?.features?.length) return null;
  const feature = bestContainingFeature(pack.features, lon, lat);
  if (!feature) return null;
  const name = featureName(feature, level);
  const population = await estimatePopulationFromWorldPop(feature.geometry, country);
  if (typeof population === 'number' && population < popThreshold) return null;
  return {
    level,
    name,
    population: typeof population === 'number' ? population : null
  };
}

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

/**
 * NWS heat index (°C) from dry-bulb °C and relative humidity %.
 * Steadman approximation below 80°F, Rothfusz regression above.
 */
function computeHeatIndexC(tempC, relativeHumidity) {
  const T = Number(tempC);
  const RH = Number(relativeHumidity);
  if (!Number.isFinite(T) || !Number.isFinite(RH)) return null;
  if (RH < 0 || RH > 100) return null;

  const Tf = (T * 9) / 5 + 32;
  let HI = 0.5 * (Tf + 61.0 + (Tf - 68.0) * 1.2 + RH * 0.094);
  HI = (HI + Tf) / 2;

  if (HI >= 80) {
    HI =
      -42.379 +
      2.04901523 * Tf +
      10.14333127 * RH -
      0.22475541 * Tf * RH -
      0.00683783 * Tf * Tf -
      0.05481717 * RH * RH +
      0.00122874 * Tf * Tf * RH +
      0.00085282 * Tf * RH * RH -
      0.00000199 * Tf * Tf * RH * RH;

    if (RH < 13 && Tf >= 80 && Tf <= 112) {
      HI -= ((13 - RH) / 4) * Math.sqrt((17 - Math.abs(Tf - 95)) / 17);
    } else if (RH > 85 && Tf >= 80 && Tf <= 87) {
      HI += ((RH - 85) / 10) * ((87 - Tf) / 5);
    }
  }

  return Math.round((((HI - 32) * 5) / 9) * 10) / 10;
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

function roundToStep(value, step) {
  if (!step) return value;
  const n = Number(value);
  const s = Number(step);
  if (!Number.isFinite(n) || !Number.isFinite(s) || s <= 0) return n;
  return Math.round(n / s) * s;
}

async function getCurrentWeatherForPoint(lat, lon) {
  const step = WEATHER_ROUNDING_DEG;
  const rLat = roundToStep(lat, step);
  const rLon = roundToStep(lon, step);
  // v2 cache key: humidity / heat index / cloud cover from Open-Meteo `current=`
  const key = `${rLat.toFixed(4)},${rLon.toFixed(4)}|${step}|v2`;

  const cache = loadWeatherCache();
  const cached = cache[key];
  const now = Date.now();
  if (cached && cached.expiresAt && now < cached.expiresAt && cached.weather) {
    return cached.weather;
  }

  const since = now - lastWeatherFetchAt;
  if (since < 150) {
    await new Promise((r) => setTimeout(r, 150 - since));
  }
  lastWeatherFetchAt = Date.now();

  const currentVars = [
    'temperature_2m',
    'relative_humidity_2m',
    'weather_code',
    'wind_speed_10m',
    'cloud_cover'
  ].join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(rLat)}&longitude=${encodeURIComponent(rLon)}&current=${encodeURIComponent(currentVars)}&timezone=auto`;
  const json = await fetchJsonHttps(url);
  const cw = json?.current;
  if (!cw) return null;

  const temperatureC = Number(cw.temperature_2m);
  const humidity = Number(cw.relative_humidity_2m);
  const weathercode = Number(cw.weather_code);
  const cloudCover = Number(cw.cloud_cover);
  const heatIndexC = computeHeatIndexC(temperatureC, humidity);

  const weather = {
    temperatureC,
    humidity: Number.isFinite(humidity) ? humidity : null,
    heatIndexC: Number.isFinite(heatIndexC) ? heatIndexC : null,
    cloudCover: Number.isFinite(cloudCover) ? cloudCover : null,
    windKph: Number(cw.wind_speed_10m),
    weathercode,
    description: weatherCodeDescription(weathercode),
    observedAt: cw.time || null,
    elevationM: typeof json?.elevation === 'number' ? json.elevation : null,
    query: { lat: rLat, lon: rLon, roundingDeg: step }
  };

  cache[key] = {
    fetchedAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
    weather
  };
  saveWeatherCache();
  return weather;
}

let airQualityCache = null;
let lastAqiFetchAt = 0;

function loadAirQualityCache() {
  if (airQualityCache) return airQualityCache;
  try {
    airQualityCache = fs.existsSync(AIR_QUALITY_CACHE_PATH)
      ? JSON.parse(fs.readFileSync(AIR_QUALITY_CACHE_PATH, 'utf8'))
      : {};
  } catch (_) {
    airQualityCache = {};
  }
  return airQualityCache;
}

function saveAirQualityCache() {
  try {
    fs.mkdirSync(path.dirname(AIR_QUALITY_CACHE_PATH), { recursive: true });
    fs.writeFileSync(AIR_QUALITY_CACHE_PATH, JSON.stringify(airQualityCache || {}, null, 2));
  } catch (_) {}
}

function aqiCategoryLabel(aqi) {
  const n = Number(aqi);
  if (!Number.isFinite(n)) return 'Unknown';
  if (n <= 50) return 'Good';
  if (n <= 100) return 'Moderate';
  if (n <= 150) return 'Unhealthy for sensitive groups';
  if (n <= 200) return 'Unhealthy';
  if (n <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

async function rateLimitAqi() {
  const since = Date.now() - lastAqiFetchAt;
  if (since < 250) await new Promise((r) => setTimeout(r, 250 - since));
  lastAqiFetchAt = Date.now();
}

/**
 * Privacy-masked air quality for a seed point.
 * - Requests a 10km x 10km area around the faux (shifted) location, expanding to
 *   25/50km only if no reporting station falls inside.
 * - Picks the station closest to the RAW seed GPS (used only locally here).
 * - Enriches via the chosen station's public id (no coordinates involved).
 */
async function getAirQualityForPoint(rawLat, rawLon, faux) {
  if (!WAQI_TOKEN) return null;

  const cache = loadAirQualityCache();
  const key = `${roundCoordFixed(faux.lat, 2)},${roundCoordFixed(faux.lon, 2)}`;
  const now = Date.now();
  if (cache[key] && cache[key].expiresAt && now < cache[key].expiresAt) {
    return cache[key].airQuality || null;
  }

  const buildBox = (lat, lon, sizeKm) => {
    const half = sizeKm / 2;
    const dLat = kmToLatDelta(half);
    const dLon = kmToLonDelta(half, lat);
    return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
  };

  let stations = null;
  let usedAreaKm = 10;
  for (const sizeKm of [10, 25, 50]) {
    const bb = buildBox(faux.lat, faux.lon, sizeKm).map((v) => roundCoordFixed(v, 5)).join(',');
    await rateLimitAqi();
    const url = `https://api.waqi.info/v2/map/bounds/?latlng=${encodeURIComponent(bb)}&networks=all&token=${encodeURIComponent(WAQI_TOKEN)}`;
    const json = await fetchJsonHttps(url).catch(() => null);
    const arr = json && json.status === 'ok' && Array.isArray(json.data) ? json.data : [];
    const valid = arr
      .map((s) => ({ uid: s.uid, lat: Number(s.lat), lon: Number(s.lon), aqi: Number(s.aqi), name: s?.station?.name || null }))
      .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && Number.isFinite(s.aqi));
    if (valid.length) {
      stations = valid;
      usedAreaKm = sizeKm;
      break;
    }
  }
  if (!stations) return null;

  let nearest = null;
  let nearestDist = Infinity;
  for (const s of stations) {
    const d = distanceKm({ lat: rawLat, lon: rawLon }, { lat: s.lat, lon: s.lon });
    if (Number.isFinite(d) && d < nearestDist) {
      nearestDist = d;
      nearest = s;
    }
  }
  if (!nearest) return null;

  let aqi = nearest.aqi;
  let dominantPollutant = null;
  let pm25 = null;
  let pm10 = null;
  let observedAt = null;
  try {
    if (nearest.uid != null) {
      await rateLimitAqi();
      const detail = await fetchJsonHttps(
        `https://api.waqi.info/feed/@${encodeURIComponent(String(nearest.uid).replace(/[^0-9]/g, ''))}/?token=${encodeURIComponent(WAQI_TOKEN)}`
      ).catch(() => null);
      const d = detail && detail.status === 'ok' ? detail.data : null;
      if (d) {
        if (Number.isFinite(Number(d.aqi))) aqi = Number(d.aqi);
        dominantPollutant = d.dominentpol || null;
        observedAt = d?.time?.iso || d?.time?.s || null;
        if (d.iaqi) {
          if (Number.isFinite(Number(d.iaqi.pm25?.v))) pm25 = Number(d.iaqi.pm25.v);
          if (Number.isFinite(Number(d.iaqi.pm10?.v))) pm10 = Number(d.iaqi.pm10.v);
        }
      }
    }
  } catch (_) {
    // Enrichment is best-effort.
  }

  const airQuality = {
    aqi: Number(aqi),
    category: aqiCategoryLabel(aqi),
    pm25,
    pm10,
    dominantPollutant,
    stationName: nearest.name || null,
    distanceKm: Math.round(nearestDist * 10) / 10,
    observedAt,
    requestedAreaKm: usedAreaKm
  };

  cache[key] = { fetchedAt: now, expiresAt: now + 30 * 60 * 1000, airQuality };
  saveAirQualityCache();
  return airQuality;
}

let overpassCache = null;

function loadOverpassCache() {
  if (overpassCache) return overpassCache;
  try {
    if (fs.existsSync(OVERPASS_CACHE_PATH)) {
      overpassCache = JSON.parse(fs.readFileSync(OVERPASS_CACHE_PATH, 'utf8'));
    } else {
      overpassCache = {};
    }
  } catch (_) {
    overpassCache = {};
  }
  return overpassCache;
}

function saveOverpassCache() {
  try {
    fs.mkdirSync(path.dirname(OVERPASS_CACHE_PATH), { recursive: true });
    fs.writeFileSync(OVERPASS_CACHE_PATH, JSON.stringify(overpassCache || {}, null, 2));
  } catch (_) {}
}

async function fetchNearestSchool(lat, lon) {
  const key = `${roundCoordFixed(lat, 3)},${roundCoordFixed(lon, 3)}|${SCHOOL_RADIUS_M}`;
  const cache = loadOverpassCache();
  const cached = cache[key];
  const now = Date.now();
  if (cached && cached.expiresAt && now < cached.expiresAt) {
    return cached.school || null;
  }

  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="school"](around:${SCHOOL_RADIUS_M},${lat},${lon});
      way["amenity"="school"](around:${SCHOOL_RADIUS_M},${lat},${lon});
      relation["amenity"="school"](around:${SCHOOL_RADIUS_M},${lat},${lon});
    );
    out center 30;
  `;

  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  try {
    const json = await fetchJsonHttps(url);
    const elements = Array.isArray(json?.elements) ? json.elements : [];
    let best = null;
    let bestDist = Infinity;
    for (const el of elements) {
      const lat0 = el.lat || el?.center?.lat;
      const lon0 = el.lon || el?.center?.lon;
      if (!Number.isFinite(lat0) || !Number.isFinite(lon0)) continue;
      const d = distanceKm({ lat, lon }, { lat: lat0, lon: lon0 });
      if (d < bestDist) {
        bestDist = d;
        best = {
          name: el?.tags?.name || 'Unnamed school',
          distanceKm: d,
          source: 'overpass',
          lat: lat0,
          lon: lon0
        };
      }
    }

    cache[key] = {
      fetchedAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      school: best
    };
    saveOverpassCache();
    return best;
  } catch (_) {
    return null;
  }
}

async function buildEntry(point, options) {
  const location = new Location(point, options);
  return location.build();
}

// Surgically add `airQuality` to an already-generated gallery data file using
// each point's existing gps + fauxLocation. This avoids recomputing H3/ADM/tile
// data (which would require warm population caches) and only adds air quality.
async function augmentAirQualityForFile(file) {
  if (!fs.existsSync(file)) {
    console.warn(`  skip (missing): ${file}`);
    return;
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const points = Array.isArray(data.points) ? data.points : [];
  let updated = 0;
  for (const p of points) {
    const lat = Number(p?.gps?.lat);
    const lon = Number(p?.gps?.lon);
    const fLat = Number(p?.fauxLocation?.lat);
    const fLon = Number(p?.fauxLocation?.lon);
    if (![lat, lon, fLat, fLon].every(Number.isFinite)) {
      p.airQuality = p.airQuality || null;
      console.log(`  ${p.id}: skipped (missing coords)`);
      continue;
    }
    const aq = await getAirQualityForPoint(lat, lon, { lat: fLat, lon: fLon }).catch(() => null);
    p.airQuality = aq || null;
    if (aq) updated += 1;
    console.log(
      `  ${p.id}: ${aq ? `AQI ${aq.aqi} (${aq.category})${aq.pm25 != null ? ` · PM2.5 ${aq.pm25}` : ''} @ ${aq.stationName || '?'} ${aq.distanceKm}km` : 'N/A'}`
    );
  }
  data.airQualityGeneratedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`Augmented ${updated}/${points.length} points with air quality in ${file}`);
}

// Refresh weather (humidity / heat index / cloud cover) on existing gallery files
// without recomputing H3/ADM/tile population.
async function augmentWeatherForFile(file) {
  if (!fs.existsSync(file)) {
    console.warn(`  skip (missing): ${file}`);
    return;
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const points = Array.isArray(data.points) ? data.points : [];
  let updated = 0;
  for (const p of points) {
    const lat = Number(p?.gps?.lat);
    const lon = Number(p?.gps?.lon);
    if (![lat, lon].every(Number.isFinite)) {
      p.weather = p.weather || null;
      console.log(`  ${p.id}: skipped (missing coords)`);
      continue;
    }
    const weather = await getCurrentWeatherForPoint(lat, lon).catch(() => null);
    if (weather) {
      p.weather = {
        temperatureC: weather.temperatureC,
        humidity: weather.humidity ?? null,
        heatIndexC: weather.heatIndexC ?? null,
        cloudCover: weather.cloudCover ?? null,
        windKph: weather.windKph ?? null,
        description: weather.description,
        observedAt: weather.observedAt,
        query: weather.query
      };
      if (typeof weather.elevationM === 'number' && (p.altitudeM == null || !Number.isFinite(p.altitudeM))) {
        p.altitudeM = weather.elevationM;
      }
      updated += 1;
      console.log(
        `  ${p.id}: ${Math.round(weather.temperatureC)}°C` +
          `${weather.heatIndexC != null ? ` (HI ${weather.heatIndexC}°)` : ''}` +
          ` · ${weather.description}` +
          `${weather.humidity != null ? ` · RH ${Math.round(weather.humidity)}%` : ''}` +
          `${weather.cloudCover != null ? ` · cloud ${Math.round(weather.cloudCover)}%` : ''}`
      );
    } else {
      console.log(`  ${p.id}: N/A`);
    }
  }
  data.weatherGeneratedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`Augmented ${updated}/${points.length} points with weather in ${file}`);
}

async function main() {
  const argv = parseArgs();

  if (argv.augmentAirQuality) {
    if (!WAQI_TOKEN) {
      throw new Error('WAQI_TOKEN (or AQICN_TOKEN) is required for --augment-air-quality');
    }
    const files = argv.files && argv.files.length
      ? argv.files
      : [DATA_FILE, path.join(OUTPUT_DIR, 'gallery-data-20000.json')];
    for (const f of files) {
      console.log(`Augmenting air quality: ${f}`);
      await augmentAirQualityForFile(f);
    }
    return;
  }

  if (argv.augmentWeather) {
    const files = argv.files && argv.files.length
      ? argv.files
      : [DATA_FILE, path.join(OUTPUT_DIR, 'gallery-data-20000.json')];
    for (const f of files) {
      console.log(`Augmenting weather: ${f}`);
      await augmentWeatherForFile(f);
    }
    return;
  }

  const options = {
    popThreshold: Number.isFinite(argv.popThreshold) ? argv.popThreshold : POP_THRESHOLD,
    shiftKm: Number.isFinite(argv.shiftKm) ? argv.shiftKm : SHIFT_KM,
    h3BaseRes: H3_BASE_RES,
    h3EffectiveMaxRes: H3_EFFECTIVE_MAX_RES
  };

  console.log('Geo Strategy config:');
  console.log(`- Population threshold: ${options.popThreshold}`);
  console.log(`- H3 base resolution: ${options.h3BaseRes}`);
  console.log(`- H3 effective max resolution: ${options.h3EffectiveMaxRes}`);
  console.log(`- H3 population source: ${H3_POPULATION_SOURCE}`);
  console.log(`- Kontur H3 cache path: ${KONTUR_H3_CACHE_PATH}`);

  if (!fs.existsSync(SEED_FILE)) {
    throw new Error(`Seed file not found: ${SEED_FILE}`);
  }
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const points = Array.isArray(seed?.points) ? seed.points : [];
  const entries = [];

  for (const point of points) {
    console.log(`Processing ${point.id}...`);
    entries.push(await buildEntry(point, options));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceSeedFile: path.relative(process.cwd(), SEED_FILE),
    populationThreshold: options.popThreshold,
    shiftKm: options.shiftKm,
    tiles: {
      tileKm: 1,
      sizes: TILE_SIZES,
      gridSize: 7
    },
    h3: {
      scheme: 'h3_v1',
      baseResolution: options.h3BaseRes,
      effectiveResolutionSearchMax: options.h3EffectiveMaxRes,
      effectiveRule: 'Use highest H3 resolution (smallest cell) whose estimated population is >= populationThreshold',
      populationSource: H3_POPULATION_SOURCE
    },
    points: entries
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
  console.log(`Saved ${entries.length} entries to ${DATA_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
