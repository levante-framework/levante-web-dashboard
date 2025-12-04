import { Storage } from '@google-cloud/storage';

const BUCKET_NAME = process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev';
const OBJECT_NAME = process.env.PREFLIGHT_LANGUAGE_SELECTION_OBJECT || 'preflight/language-selection.json';

function getStorageClient() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!serviceAccountJson) {
    throw new Error('GCP service account JSON not configured');
  }

  let credentials;
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch (error) {
    throw new Error('Invalid GCP service account JSON');
  }

  return new Storage({ credentials });
}

async function readSelectionFile(storage) {
  const bucket = storage.bucket(BUCKET_NAME);
  const file = bucket.file(OBJECT_NAME);
  const [exists] = await file.exists();
  if (!exists) {
    return null;
  }
  const [contents] = await file.download();
  return JSON.parse(contents.toString('utf8'));
}

async function writeSelectionFile(storage, payload) {
  const bucket = storage.bucket(BUCKET_NAME);
  const file = bucket.file(OBJECT_NAME);
  const body = JSON.stringify(payload, null, 2);
  await file.save(body, {
    resumable: false,
    contentType: 'application/json',
    cacheControl: 'no-cache'
  });
  try {
    await file.makePublic();
  } catch (error) {
    console.warn('preflight-language-selection: makePublic failed', error.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  let storage;
  try {
    storage = getStorageClient();
  } catch (error) {
    // Allow GET requests to succeed with a graceful fallback when creds are missing.
    if (req.method === 'GET') {
      return res.status(200).json({ success: false, languages: null, message: error.message });
    }
    console.error('preflight-language-selection: storage init failed', error);
    return res.status(500).json({ success: false, error: error.message });
  }

  try {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      const data = await readSelectionFile(storage);
      if (!data || !Array.isArray(data.languages)) {
        return res.status(200).json({ success: false, languages: null });
      }
      return res.status(200).json({ success: true, languages: data.languages, updatedAt: data.updatedAt || null });
    }

    // POST: persist new selection
    const payload = req.body;
    const languages = Array.isArray(payload?.languages) ? payload.languages.filter(lang => typeof lang === 'string' && lang.trim().length > 0) : null;
    if (!languages) {
      return res.status(400).json({ success: false, error: 'languages array required' });
    }

    const toWrite = {
      languages,
      updatedAt: new Date().toISOString()
    };
    await writeSelectionFile(storage, toWrite);
    return res.status(200).json({ success: true, updatedAt: toWrite.updatedAt });
  } catch (error) {
    console.error('preflight-language-selection error:', error);
    const status = req.method === 'GET' ? 200 : 500;
    return res.status(status).json({ success: false, error: error.message });
  }
}


