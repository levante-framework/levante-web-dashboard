const fs = require('fs');
const os = require('os');
const path = require('path');
const shapefile = require('shapefile');
const unzipper = require('unzipper');
const { Storage } = require('@google-cloud/storage');
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
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
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const resolved = path.join(dir, entry.name);
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.shp') {
      return resolved;
    }
    if (entry.isDirectory()) {
      const nested = await findShapefile(resolved);
      if (nested) return nested;
    }
  }
  return null;
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
  for (const feature of features) {
    if (!feature || !feature.geometry) {
      continue;
    }
    try {
      if (booleanPointInPolygon(point, feature.geometry)) {
        res.status(200).json({ feature: createGeoJSONFeature(feature) });
        return;
      }
    } catch (error) {
      console.warn('gadm-polygon: failed to test point in polygon', error.message);
    }
  }

  res.status(404).json({ error: 'polygon_not_found' });
}

module.exports = handler;

