import { Storage } from '@google-cloud/storage';

const BUCKET_NAME = process.env.AUDIO_DEV_BUCKET || 'levante-assets-dev';
const OBJECT_NAME = process.env.EMBEDDING_ADVISORY_OBJECT || 'validation/embedding-advisory.json';

function getStorageClient() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON is not set');
  }
  let credentials;
  try {
    credentials = JSON.parse(serviceAccountJson);
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

  try {
    const storage = getStorageClient();
    const file = storage.bucket(BUCKET_NAME).file(OBJECT_NAME);
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(200).json({
        success: false,
        advisoryOnly: true,
        entries: [],
        error: `No advisory artifact found at gs://${BUCKET_NAME}/${OBJECT_NAME}`,
      });
    }
    const [contents] = await file.download();
    const json = JSON.parse(contents.toString('utf8'));
    return res.status(200).json({ success: true, ...json });
  } catch (error) {
    console.warn('embedding-advisory API warning:', error?.message || error);
    return res.status(200).json({
      success: false,
      advisoryOnly: true,
      entries: [],
      error: error?.message || 'Unknown error',
    });
  }
}

