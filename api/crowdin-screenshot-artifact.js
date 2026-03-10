import { Storage } from '@google-cloud/storage';

const BUCKET_NAME = process.env.DASHBOARD_DATA_BUCKET || 'levante-dashboard-dev';
const PREFIX = process.env.CROWDIN_SCREENSHOT_ARTIFACT_PREFIX || 'pitwall/crowdin';
const OBJECT_NAME = process.env.CROWDIN_SCREENSHOT_ARTIFACT_OBJECT || 'crowdin-screenshot-artifact.json';

function normalizePrefix(prefix) {
  if (!prefix) return '';
  return String(prefix).endsWith('/') ? String(prefix) : `${String(prefix)}/`;
}

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON is not set');
  }
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (_e) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  return new Storage({ credentials });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const objectPath = `${normalizePrefix(PREFIX)}${OBJECT_NAME}`;
  try {
    const storage = getStorageClient();
    const file = storage.bucket(BUCKET_NAME).file(objectPath);
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(200).json({
        success: false,
        entries: [],
        error: `No screenshot artifact found at gs://${BUCKET_NAME}/${objectPath}`,
      });
    }
    const [contents] = await file.download();
    const json = JSON.parse(contents.toString('utf8'));
    return res.status(200).json({ success: true, ...json });
  } catch (error) {
    console.warn('crowdin-screenshot-artifact API warning:', error?.message || error);
    return res.status(200).json({
      success: false,
      entries: [],
      error: error?.message || 'Unknown error',
    });
  }
}

