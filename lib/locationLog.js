const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

const LOG_LIMIT = 200;

// Local dev fallback (also used if GCS is not configured)
const LOG_PATH =
  process.env.NODE_ENV === 'production'
    ? path.join('/tmp', 'location_log.json')
    : path.join(process.cwd(), 'data', 'location_log.json');

// Persistent (recommended): GCS object
const LOG_BUCKET = process.env.LOCATION_LOG_BUCKET || process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev';
const LOG_OBJECT = process.env.LOCATION_LOG_OBJECT || 'logs/locations.json';

let storageClient = null;

function getStorageClient() {
  if (storageClient !== null) return storageClient;
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  try {
    if (raw) {
      const creds = JSON.parse(raw);
      storageClient = new Storage({ credentials: creds, projectId: creds.project_id });
    } else {
      storageClient = new Storage();
    }
  } catch (error) {
    console.warn('location-log: GCS client init failed:', error.message);
    storageClient = null;
  }
  return storageClient;
}

function hasGcsConfig() {
  // If no credentials are available, Storage() may still work in some environments; treat it as "best effort".
  return !!LOG_BUCKET && !!LOG_OBJECT;
}

function ensureLocalLogFile() {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(LOG_PATH, '[]', 'utf8');
  }
}

async function readLogFromLocal() {
  try {
    ensureLocalLogFile();
    const raw = fs.readFileSync(LOG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('location-log: failed to read local log file', error);
    return [];
  }
}

async function writeLogToLocal(entries) {
  try {
    ensureLocalLogFile();
    fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('location-log: failed to write local log file', error);
    return false;
  }
}

async function readLogFromGcs() {
  const storage = getStorageClient();
  if (!storage) return null;
  try {
    const file = storage.bucket(LOG_BUCKET).file(LOG_OBJECT);
    const [exists] = await file.exists();
    if (!exists) return [];
    const [buf] = await file.download();
    const parsed = JSON.parse(buf.toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('location-log: failed to read GCS log', error.message);
    return null;
  }
}

async function writeLogToGcs(entries) {
  const storage = getStorageClient();
  if (!storage) return false;
  const bucket = storage.bucket(LOG_BUCKET);
  const file = bucket.file(LOG_OBJECT);

  // Concurrency-safe update: read generation, then write with ifGenerationMatch.
  // Retry on precondition failure to avoid clobbering concurrent writers.
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let generation = null;
      let exists = false;
      try {
        const [meta] = await file.getMetadata();
        generation = meta?.generation || null;
        exists = true;
      } catch (_) {
        exists = false;
        generation = null;
      }

      const options = exists
        ? { preconditionOpts: { ifGenerationMatch: Number(generation) } }
        : { preconditionOpts: { ifGenerationMatch: 0 } };

      await file.save(JSON.stringify(entries, null, 2), {
        contentType: 'application/json',
        resumable: false,
        ...options
      });

      return true;
    } catch (error) {
      const msg = error?.message || String(error);
      const isPrecondition = /conditionNotMet|Precondition|412/i.test(msg);
      if (!isPrecondition || attempt === maxRetries) {
        console.warn(`location-log: failed to write GCS log (${attempt}/${maxRetries}):`, msg);
        return false;
      }
      // brief backoff
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
  return false;
}

async function readLog() {
  if (process.env.NODE_ENV === 'production' && hasGcsConfig()) {
    const fromGcs = await readLogFromGcs();
    if (fromGcs !== null) return fromGcs;
  }
  return await readLogFromLocal();
}

async function appendLog(entry) {
  const entries = await readLog();
  entries.unshift(entry);
  if (entries.length > LOG_LIMIT) entries.length = LOG_LIMIT;

  let wrote = false;
  if (process.env.NODE_ENV === 'production' && hasGcsConfig()) {
    wrote = await writeLogToGcs(entries);
  }
  if (!wrote) {
    await writeLogToLocal(entries);
  }
  return entries;
}

module.exports = {
  LOG_PATH,
  LOG_BUCKET,
  LOG_OBJECT,
  appendLog,
  readLog
};

