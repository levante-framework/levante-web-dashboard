import { Storage } from '@google-cloud/storage';

const DEFAULT_DRAFT_BUCKET = process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';

const OBJECT_PATH = process.env.PARTNER_AUDIO_TRANSLATIONS_OBJECT_PATH || 'audio/item_bank_translations.csv';

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) return null;
  try {
    const credentials = JSON.parse(raw);
    return new Storage({ credentials, projectId: credentials.project_id });
  } catch (_) {
    return null;
  }
}

async function readFromGcs(storage, bucketName, objectPath) {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(objectPath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  const csvText = contents.toString('utf8');
  if (!String(csvText || '').trim()) return null;
  return csvText;
}

async function readFromPublicUrl(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    const csvText = await response.text();
    if (!String(csvText || '').trim()) return null;
    return csvText;
  } catch (_) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  try {
    const storage = getStorageClient();
    const tried = [];

    if (storage) {
      tried.push(`gcs://${DEFAULT_DRAFT_BUCKET}/${OBJECT_PATH}`);
      const csvText = await readFromGcs(storage, DEFAULT_DRAFT_BUCKET, OBJECT_PATH);
      if (csvText) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(csvText);
      }
    }

    // Public fallback for environments without configured GCS credentials.
    const publicUrls = [
      `https://storage.googleapis.com/${DEFAULT_DRAFT_BUCKET}/${OBJECT_PATH}`
    ];
    for (const url of publicUrls) {
      tried.push(url);
      const csvText = await readFromPublicUrl(url);
      if (!csvText) continue;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(csvText);
    }

    return res.status(404).json({
      ok: false,
      error: 'translations_not_found',
      tried
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'internal_error',
      message: error?.message || String(error)
    });
  }
}
