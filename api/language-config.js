/**
 * Language Config API
 * GET:  Load language_config.json from GCS bucket
 * PUT:  Save language_config.json to GCS bucket
 *
 * Environment variables expected (configure in Vercel Project Settings):
 * - GCP_SERVICE_ACCOUNT_JSON: JSON string of the GCP service account key
 * - AUDIO_DEV_BUCKET: Bucket name (default: "levante-audio-dev")
 * - LANGUAGE_CONFIG_OBJECT: Object name (default: "language_config.json")
 */

import { Storage } from '@google-cloud/storage';

const BUCKET_NAME = process.env.AUDIO_DEV_BUCKET || 'levante-audio-dev';
const OBJECT_NAME = process.env.LANGUAGE_CONFIG_OBJECT || 'language_config.json';

function getStorageClient() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON is not set');
  }
  let credentials;
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch (e) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  return new Storage({ credentials });
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    switch (req.method) {
      case 'GET':
        return await handleGet(req, res);
      case 'PUT':
        return await handlePut(req, res);
      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('language-config API error:', error);
    const status = error.message?.includes('not set') ? 500 : 500;
    return res.status(status).json({ success: false, error: error.message });
  }
}

async function handleGet(_req, res) {
  try {
    const storage = getStorageClient();
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(OBJECT_NAME);

    const [exists] = await file.exists();
    if (!exists) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      return res.status(200).json({ success: true, languages: null, message: 'No remote language_config.json found' });
    }

    const [contents] = await file.download();
    const json = JSON.parse(contents.toString('utf8'));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json({ success: true, ...json });
  } catch (error) {
    // If credentials are missing or access denied, return a non-fatal response so clients can fallback
    console.warn('language-config GET warning:', error.message);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json({ success: false, languages: null, error: error.message });
  }
}

async function handlePut(req, res) {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid JSON body' });
    }

    const { languages, metadata } = payload;
    if (!languages || typeof languages !== 'object') {
      return res.status(400).json({ success: false, error: 'Missing or invalid languages object' });
    }

    const storage = getStorageClient();
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(OBJECT_NAME);

    const now = new Date().toISOString();
    const toWrite = JSON.stringify({ languages, metadata: { saved_at: now, ...(metadata || {}) } }, null, 2);
    await file.save(toWrite, { contentType: 'application/json', resumable: false, public: false, cacheControl: 'no-cache' });
    // Ensure the config is publicly readable so local tools (without creds) can fetch it
    try {
      await file.makePublic();
    } catch (e) {
      console.warn('language-config PUT warning: makePublic failed:', e?.message || e);
    }

    return res.status(200).json({ success: true, message: 'language_config saved', saved_at: now });
  } catch (error) {
    console.error('language-config PUT error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}


