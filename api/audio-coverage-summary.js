import { Storage } from '@google-cloud/storage';

const DATA_BUCKET = process.env.DASHBOARD_DATA_BUCKET || 'levante-dashboard-dev';
const SUMMARY_PREFIX = process.env.AUDIO_COVERAGE_SUMMARY_PREFIX || 'pitwall/audio-coverage-summary';

let storageClient = null;
function getStorage() {
  if (storageClient) return storageClient;
  try {
    const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (raw) {
      const creds = JSON.parse(raw);
      storageClient = new Storage({ credentials: creds, projectId: creds.project_id });
    } else {
      storageClient = new Storage();
    }
  } catch (error) {
    console.warn('audio-coverage-summary: failed to init storage client', error.message);
    storageClient = null;
  }
  return storageClient;
}

function sanitizeBucketName(name) {
  return (name || '').toString().trim().replace(/[^a-zA-Z0-9._-]+/g, '_') || 'unknown-bucket';
}

function getObjectPath(bucketName) {
  const base = SUMMARY_PREFIX.endsWith('/') ? SUMMARY_PREFIX : `${SUMMARY_PREFIX}/`;
  return `${base}${sanitizeBucketName(bucketName)}.json`;
}

async function loadSummary(bucketName) {
  try {
    const storage = getStorage();
    if (!storage) return null;
    const bucket = storage.bucket(DATA_BUCKET);
    const file = bucket.file(getObjectPath(bucketName));
    const [exists] = await file.exists();
    if (!exists) return null;
    const [contents] = await file.download();
    const parsed = JSON.parse(contents.toString('utf8'));
    return parsed;
  } catch (error) {
    console.warn('audio-coverage-summary: load error', error.message);
    return null;
  }
}

async function saveSummary(bucketName, data) {
  const storage = getStorage();
  if (!storage) {
    throw new Error('GCS unavailable');
  }
  const bucket = storage.bucket(DATA_BUCKET);
  const file = bucket.file(getObjectPath(bucketName));
  const payload = JSON.stringify(data, null, 2);
  await file.save(payload, {
    contentType: 'application/json',
    resumable: false,
    metadata: { cacheControl: 'no-cache, max-age=0' }
  });
}

function validateSummary(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('Invalid summary payload');
  }
  const requiredNumbers = ['expectedCount', 'availableCount', 'missingCount', 'noTagCount'];
  for (const key of requiredNumbers) {
    const value = body[key];
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`Missing or invalid field: ${key}`);
    }
  }
  return {
    expectedCount: body.expectedCount,
    availableCount: body.availableCount,
    missingCount: body.missingCount,
    noTagCount: body.noTagCount,
    coveragePercent: typeof body.coveragePercent === 'number' && !Number.isNaN(body.coveragePercent)
      ? body.coveragePercent
      : (body.expectedCount > 0 ? Math.round((body.availableCount / body.expectedCount) * 1000) / 10 : 0),
    languages: Array.isArray(body.languages) ? body.languages : [],
    source: body.source || 'bucket',
    generatedAt: body.generatedAt || new Date().toISOString(),
    notes: body.notes || undefined,
    version: 1
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-cache');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const rawBucket = req.method === 'GET' ? req.query.bucket : req.body?.bucket;
  const defaultBucket = process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev';
  const bucketName = sanitizeBucketName(rawBucket || defaultBucket);

  try {
    if (req.method === 'GET') {
      const summary = await loadSummary(bucketName);
      if (!summary) {
        res.status(404).json({ error: 'not_found', message: 'No cached coverage summary', bucket: bucketName });
        return;
      }
      res.status(200).json({ bucket: bucketName, cached: true, summary });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const payload = validateSummary(req.body);
    payload.bucket = bucketName;
    payload.receivedAt = new Date().toISOString();

    await saveSummary(bucketName, payload);

    res.status(200).json({ ok: true, bucket: bucketName, savedAt: payload.receivedAt });
  } catch (error) {
    console.error('audio-coverage-summary error:', error);
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
}
