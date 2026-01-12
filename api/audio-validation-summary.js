import { Storage } from '@google-cloud/storage';

const DATA_BUCKET = process.env.DASHBOARD_DATA_BUCKET || 'levante-dashboard-dev';
const SUMMARY_PREFIX = process.env.AUDIO_VALIDATION_SUMMARY_PREFIX || 'pitwall/audio-validation-summary';

// In-memory fallback for local/dev environments without GCS credentials
const inMemorySummaries = new Map(); // key -> summary payload

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
    console.warn('audio-validation-summary: failed to init storage client', error.message);
    storageClient = null;
  }
  return storageClient;
}

function sanitizeKey(name) {
  return (name || '').toString().trim().replace(/[^a-zA-Z0-9._-]+/g, '_') || 'latest';
}

function getObjectPath(key) {
  const base = SUMMARY_PREFIX.endsWith('/') ? SUMMARY_PREFIX : `${SUMMARY_PREFIX}/`;
  return `${base}${sanitizeKey(key)}.json`;
}

async function loadSummary(key) {
  try {
    const storage = getStorage();
    if (!storage) return inMemorySummaries.get(key) || null;
    const bucket = storage.bucket(DATA_BUCKET);
    const file = bucket.file(getObjectPath(key));
    const [exists] = await file.exists();
    if (!exists) return null;
    const [contents] = await file.download();
    return JSON.parse(contents.toString('utf8'));
  } catch (error) {
    console.warn('audio-validation-summary: load error', error.message);
    return null;
  }
}

async function saveSummary(key, data) {
  const storage = getStorage();
  if (!storage) {
    inMemorySummaries.set(key, data);
    return 'memory';
  }
  const bucket = storage.bucket(DATA_BUCKET);
  const file = bucket.file(getObjectPath(key));
  const payload = JSON.stringify(data, null, 2);
  await file.save(payload, {
    contentType: 'application/json',
    resumable: false,
    metadata: { cacheControl: 'no-cache, max-age=0' }
  });
  inMemorySummaries.set(key, data);
  return 'gcs';
}

function validateLanguageRow(row) {
  if (!row || typeof row !== 'object') throw new Error('Invalid language row');
  const lang = (row.lang || row.language || '').toString().trim();
  if (!lang) throw new Error('Missing lang');
  const total = Number(row.total ?? row.validatedCount ?? 0);
  if (!Number.isFinite(total) || total < 0) throw new Error(`Invalid total for ${lang}`);
  const avgSimilarity = row.avgSimilarity;
  if (avgSimilarity != null && (typeof avgSimilarity !== 'number' || Number.isNaN(avgSimilarity))) {
    throw new Error(`Invalid avgSimilarity for ${lang}`);
  }
  const counts = row.counts || {};
  for (const k of ['excellent', 'good', 'acceptable', 'needsReview']) {
    const v = counts[k];
    if (v != null && (!Number.isFinite(v) || v < 0)) throw new Error(`Invalid counts.${k} for ${lang}`);
  }
  return {
    lang,
    total,
    avgSimilarity: typeof avgSimilarity === 'number' ? avgSimilarity : null,
    counts: {
      excellent: Number.isFinite(counts.excellent) ? counts.excellent : 0,
      good: Number.isFinite(counts.good) ? counts.good : 0,
      acceptable: Number.isFinite(counts.acceptable) ? counts.acceptable : 0,
      needsReview: Number.isFinite(counts.needsReview) ? counts.needsReview : 0
    },
    passPercent: typeof row.passPercent === 'number' && !Number.isNaN(row.passPercent) ? row.passPercent : null,
    meaningAvg: typeof row.meaningAvg === 'number' && !Number.isNaN(row.meaningAvg) ? row.meaningAvg : null
  };
}

function validateSummary(body) {
  if (!body || typeof body !== 'object') throw new Error('Invalid summary payload');
  const languagesIn = Array.isArray(body.languages) ? body.languages : [];
  const languages = languagesIn.map(validateLanguageRow);
  const overall = body.overall && typeof body.overall === 'object' ? body.overall : {};

  const total = Number(overall.total ?? 0);
  if (!Number.isFinite(total) || total < 0) throw new Error('Invalid overall.total');
  const avgSimilarity = overall.avgSimilarity;
  if (avgSimilarity != null && (typeof avgSimilarity !== 'number' || Number.isNaN(avgSimilarity))) {
    throw new Error('Invalid overall.avgSimilarity');
  }

  const thresholds = body.thresholds && typeof body.thresholds === 'object' ? body.thresholds : {};
  const normalizedThresholds = {
    excellentMin: Number.isFinite(thresholds.excellentMin) ? thresholds.excellentMin : 0.95,
    goodMin: Number.isFinite(thresholds.goodMin) ? thresholds.goodMin : 0.85,
    acceptableMin: Number.isFinite(thresholds.acceptableMin) ? thresholds.acceptableMin : 0.7
  };

  // Always update generatedAt to current time when saving
  return {
    version: 1,
    generatedAt: new Date().toISOString(), // Always use current time
    source: body.source || 'audio-validation-page',
    sourceFile: body.sourceFile || undefined,
    notes: body.notes || undefined,
    thresholds: normalizedThresholds,
    overall: {
      total,
      avgSimilarity: typeof avgSimilarity === 'number' ? avgSimilarity : null,
      needsReviewCount: Number.isFinite(overall.needsReviewCount) ? overall.needsReviewCount : undefined,
      passPercent: typeof overall.passPercent === 'number' && !Number.isNaN(overall.passPercent) ? overall.passPercent : null
    },
    languages
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

  const key = sanitizeKey(req.method === 'GET' ? req.query.key : req.body?.key);

  try {
    if (req.method === 'GET') {
      const summary = await loadSummary(key);
      if (!summary) {
        res.status(404).json({ error: 'not_found', message: 'No cached audio validation summary', key });
        return;
      }
      res.status(200).json({ key, cached: true, summary, source: getStorage() ? 'gcs_or_default' : 'memory' });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const payload = validateSummary(req.body);
    payload.key = key;
    payload.receivedAt = new Date().toISOString();
    const savedTo = await saveSummary(key, payload);
    res.status(200).json({ ok: true, key, savedAt: payload.receivedAt, savedTo });
  } catch (error) {
    console.error('audio-validation-summary error:', error);
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
}


