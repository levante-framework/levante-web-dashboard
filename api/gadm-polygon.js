const fs = require('fs');
const os = require('os');
const path = require('path');
const shapefile = require('shapefile');
const unzipper = require('unzipper');
const { Storage } = require('@google-cloud/storage');
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const area = require('@turf/area').default;
const gadmConfig = require('../config/gadm-bucket-files.json');

const BUCKET_NAME = process.env.GADM_BUCKET_NAME || 'levante-assets-dev';
const bucketCache = new Map();
const loadingCache = new Map();

function getStorageClient() {
  try {
    const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!serviceAccountJson) {
      console.warn('gadm-polygon: no GCS credentials available');
      return null;
    }
    const credentials = JSON.parse(serviceAccountJson);
    return new Storage({ credentials, projectId: credentials.project_id });
  } catch (error) {
    console.warn('gadm-polygon: Failed to create storage client', error.message);
    return null;
  }
}

const storageClient = getStorageClient();

function normalizeCountry(code) {
  return (code || '').trim().toUpperCase();
}

async function findShapefile(dir) {
  // GADM shapefiles are named like gadm41_USA_0.shp, gadm41_USA_1.shp, etc.
  // Higher number = more specific (3 = municipality, 2 = county, 1 = state, 0 = country)
  // We want to prioritize level 2 or 3 for more accurate boundaries
  const allShpFiles = [];
  
  async function collectShpFiles(currentDir) {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const resolved = path.join(currentDir, entry.name);
      if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.shp') {
        allShpFiles.push(resolved);
      }
      if (entry.isDirectory()) {
        await collectShpFiles(resolved);
      }
    }
  }
  
  await collectShpFiles(dir);
  
  if (allShpFiles.length === 0) {
    return null;
  }
  
  // Sort by filename to prioritize higher levels (gadm41_XXX_3.shp > gadm41_XXX_2.shp > ...)
  allShpFiles.sort((a, b) => {
    const aMatch = a.match(/_(\d+)\.shp$/);
    const bMatch = b.match(/_(\d+)\.shp$/);
    if (aMatch && bMatch) {
      return parseInt(bMatch[1]) - parseInt(aMatch[1]); // Descending: prefer 3, then 2, then 1, then 0
    }
    return a.localeCompare(b);
  });
  
  // Prefer level 2 or 3, but fall back to any available
  for (const shpFile of allShpFiles) {
    const levelMatch = shpFile.match(/_(\d+)\.shp$/);
    if (levelMatch) {
      const level = parseInt(levelMatch[1]);
      if (level >= 2) {
        return shpFile; // Prefer level 2 or 3
      }
    }
  }
  
  // Fall back to first file if no level 2+ found
  return allShpFiles[0];
}

async function loadCountryFeatures(countryCode) {
  const normalized = normalizeCountry(countryCode);
  if (!normalized) {
    throw new Error('Country code is required');
  }
  if (bucketCache.has(normalized)) {
    return bucketCache.get(normalized);
  }
  if (!storageClient) {
    throw new Error('GCS client unavailable');
  }
  if (!gadmConfig[normalized]) {
    throw new Error(`No bucket path configured for country ${normalized}`);
  }
  if (loadingCache.has(normalized)) {
    return loadingCache.get(normalized);
  }

  const loadPromise = (async () => {
    const bucket = storageClient.bucket(BUCKET_NAME);
    const filePath = gadmConfig[normalized];
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `gadm-${normalized}-`));
    const zipDest = path.join(tempDir, path.basename(filePath));
    await bucket.file(filePath).download({ destination: zipDest });
    await new Promise((resolve, reject) => {
      fs.createReadStream(zipDest)
        .pipe(unzipper.Extract({ path: tempDir }))
        .on('close', resolve)
        .on('error', reject);
    });
    const shpPath = await findShapefile(tempDir);
    if (!shpPath) {
      throw new Error(`No .shp file found inside ${filePath}`);
    }
    const source = await shapefile.open(shpPath);
    const features = [];
    while (true) {
      const result = await source.read();
      if (result.done) break;
      features.push(result.value);
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    bucketCache.set(normalized, features);
    return features;
  })().finally(() => {
    loadingCache.delete(normalized);
  });

  loadingCache.set(normalized, loadPromise);
  return loadPromise;
}

function createGeoJSONFeature(feature) {
  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: feature.properties || {}
  };
}

function normalizePoint(lat, lon) {
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    throw new Error('Invalid coordinates');
  }
  return [lonNum, latNum];
}

function getAdminLevel(feature) {
  // GADM features have GID_0, GID_1, GID_2, GID_3 properties
  // Higher number = more specific (3 = municipality, 0 = country)
  const props = feature.properties || {};
  if (props.GID_3) return 3;
  if (props.GID_2) return 2;
  if (props.GID_1) return 1;
  if (props.GID_0) return 0;
  return -1; // Unknown level
}

function calculatePolygonArea(feature) {
  try {
    // Convert to GeoJSON Feature for turf.js
    const geoJsonFeature = createGeoJSONFeature(feature);
    return area(geoJsonFeature); // Returns area in square meters
  } catch (error) {
    // Fallback: estimate from bounding box
    return Infinity;
  }
}

async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const { country, lat, lon } = req.query;
  if (!country) {
    res.status(400).json({ error: 'country_required' });
    return;
  }
  if (!lat || !lon) {
    res.status(400).json({ error: 'coordinates_required' });
    return;
  }

  let features;
  try {
    features = await loadCountryFeatures(country);
  } catch (error) {
    console.error('gadm-polygon: failed to load features', error);
    res.status(500).json({ error: 'failed_to_load_country_data' });
    return;
  }

  const point = normalizePoint(lat, lon);
  
  // Find ALL polygons that contain the point
  const matchingFeatures = [];
  for (const feature of features) {
    if (!feature || !feature.geometry) {
      continue;
    }
    try {
      if (booleanPointInPolygon(point, feature.geometry)) {
        matchingFeatures.push(feature);
      }
    } catch (error) {
      console.warn('gadm-polygon: failed to test point in polygon', error.message);
    }
  }

  if (matchingFeatures.length === 0) {
    res.status(404).json({ error: 'polygon_not_found' });
    return;
  }

  // Find the most specific polygon:
  // 1. Prefer higher administrative level (GID_3 > GID_2 > GID_1 > GID_0)
  // 2. If same level, prefer smaller area (more specific)
  let bestFeature = matchingFeatures[0];
  let bestLevel = getAdminLevel(bestFeature);
  let bestArea = calculatePolygonArea(bestFeature);

  for (let i = 1; i < matchingFeatures.length; i++) {
    const feature = matchingFeatures[i];
    const level = getAdminLevel(feature);
    const featureArea = calculatePolygonArea(feature);

    // Prefer higher level, or same level with smaller area
    if (level > bestLevel || (level === bestLevel && featureArea < bestArea)) {
      bestFeature = feature;
      bestLevel = level;
      bestArea = featureArea;
    }
  }

  res.status(200).json({ 
    feature: createGeoJSONFeature(bestFeature),
    adminLevel: bestLevel,
    candidates: matchingFeatures.length
  });
}

module.exports = handler;
