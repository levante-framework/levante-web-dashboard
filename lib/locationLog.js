const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

const LOG_PATH = path.join(process.cwd(), 'data', 'locations.json');
const LOG_LIMIT = 200;

// GCS configuration
const BUCKET_NAME = process.env.LOCATION_LOG_BUCKET || 'levante-assets-dev';
const GCS_LOG_PATH = 'logs/locations.json';

// In-memory store for fallback
let memoryLog = [];

function getStorageClient() {
  try {
    const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!serviceAccountJson) {
      console.warn('No GCS credentials found, using local file/memory store');
      return null;
    }
    const credentials = JSON.parse(serviceAccountJson);
    return new Storage({ 
      credentials,
      projectId: credentials.project_id 
    });
  } catch (error) {
    console.warn('Failed to initialize GCS client:', error.message);
    return null;
  }
}

async function readLogFromGCS() {
  const storage = getStorageClient();
  if (!storage) {
    console.log('location-log: No GCS client available');
    return null;
  }
  
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(GCS_LOG_PATH);
    
    const [exists] = await file.exists();
    if (!exists) {
      console.log(`location-log: GCS file ${BUCKET_NAME}/${GCS_LOG_PATH} does not exist yet, returning empty array`);
      return [];
    }
    
    const [contents] = await file.download();
    const parsed = JSON.parse(contents.toString('utf8'));
    const entries = Array.isArray(parsed) ? parsed : [];
    console.log(`location-log: Read ${entries.length} entries from GCS`);
    return entries;
  } catch (error) {
    console.error('location-log: Failed to read log from GCS:', error.message, error.stack);
    return null;
  }
}

async function writeLogToGCS(entries) {
  const storage = getStorageClient();
  if (!storage) {
    console.log('location-log: No GCS client available for write');
    return false;
  }
  
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(GCS_LOG_PATH);
    
    await file.save(JSON.stringify(entries, null, 2), {
      contentType: 'application/json',
      metadata: {
        cacheControl: 'public, max-age=0',
      },
    });
    
    console.log(`location-log: Successfully wrote ${entries.length} entries to GCS ${BUCKET_NAME}/${GCS_LOG_PATH}`);
    return true;
  } catch (error) {
    console.error('location-log: Failed to write log to GCS:', error.message, error.stack);
    return false;
  }
}

function ensureLogFile() {
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(LOG_PATH)) {
      fs.writeFileSync(LOG_PATH, '[]', 'utf8');
    }
  } catch (error) {
    // In Vercel, filesystem is read-only, so we'll use GCS or memory store
    console.warn('Cannot create log file (read-only filesystem):', error.message);
  }
}

async function readLog() {
  // Try GCS first (for persistence in Vercel)
  const gcsLog = await readLogFromGCS();
  if (gcsLog !== null) {
    memoryLog = gcsLog; // Cache in memory
    return gcsLog;
  }
  
  // Fallback to local file (for development)
  try {
    ensureLogFile();
    if (fs.existsSync(LOG_PATH)) {
      const raw = fs.readFileSync(LOG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : [];
      memoryLog = entries; // Cache in memory
      return entries;
    }
  } catch (error) {
    console.warn('location-log: failed to read log file:', error.message);
  }
  
  // Final fallback to memory store
  return memoryLog;
}

async function appendLog(entry) {
  try {
    const entries = await readLog();
    entries.unshift(entry);
    if (entries.length > LOG_LIMIT) {
      entries.length = LOG_LIMIT;
    }
    
    // Update memory store
    memoryLog = entries;
    
    // Try to write to GCS first (for persistence in Vercel)
    const gcsWritten = await writeLogToGCS(entries);
    if (gcsWritten) {
      console.log('location-log: written to GCS bucket');
      return entries;
    }
    
    // Fallback to local file (for development)
    try {
      ensureLogFile();
      fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2), 'utf8');
      console.log('location-log: written to local file');
    } catch (writeError) {
      // In Vercel, filesystem is read-only, so we just use memory store
      console.warn('location-log: using memory store (filesystem is read-only, GCS unavailable)');
    }
    
    return entries;
  } catch (error) {
    console.error('location-log: failed to append log entry', error);
    return null;
  }
}

module.exports = {
  LOG_PATH,
  BUCKET_NAME,
  GCS_LOG_PATH,
  appendLog,
  readLog,
};
