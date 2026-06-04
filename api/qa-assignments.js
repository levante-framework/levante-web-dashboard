/**
 * LEVANTE-QA assignment list (read-only, GCS-backed).
 *
 * Serves the cached `qa-tests` assignment catalogue that levante-qa publishes to
 * gs://levante-tools/levante-qa/assignments.json (via `pnpm publish:assignments`).
 * The Pitwall "QA Runs" page uses it to populate the "Run an assignment" picker
 * without needing Firestore access of its own.
 *
 *   GET /api/qa-assignments → { assignments: [...], updatedAt, source, gcsUri }
 *
 * Auth reuses the same service-account pattern as the other Pitwall GCS
 * endpoints. The account only needs read access to the levante-tools bucket.
 */
import { Storage } from '@google-cloud/storage';

const BUCKET = process.env.QA_GCS_BUCKET || process.env.TOOLS_BUCKET || 'levante-tools';
const PREFIX = (process.env.QA_GCS_PREFIX || 'levante-qa').replace(/\/+$/, '');
const OBJECT = `${PREFIX}/assignments.json`;

let storageClient = null;

function getStorageClient() {
  if (storageClient !== null) return storageClient;
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  try {
    if (raw) {
      const credentials = JSON.parse(raw);
      storageClient = new Storage({ credentials, projectId: credentials.project_id });
    } else {
      storageClient = new Storage();
    }
  } catch (error) {
    console.warn('qa-assignments GCS client init failed:', error?.message || error);
    storageClient = null;
  }
  return storageClient;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const gcsUri = `gs://${BUCKET}/${OBJECT}`;
  const storage = getStorageClient();
  if (!storage) return res.status(200).json({ assignments: [], source: 'unavailable', gcsUri });

  try {
    const file = storage.bucket(BUCKET).file(OBJECT);
    const [exists] = await file.exists();
    if (!exists) return res.status(200).json({ assignments: [], source: 'empty', gcsUri });
    const [buf] = await file.download();
    const parsed = JSON.parse(buf.toString('utf-8'));
    return res.status(200).json({
      assignments: Array.isArray(parsed.assignments) ? parsed.assignments : [],
      updatedAt: parsed.updatedAt || null,
      source: 'gcs',
      gcsUri,
    });
  } catch (error) {
    console.warn('qa-assignments read error:', error?.message || error);
    return res.status(200).json({ assignments: [], source: 'error', error: error?.message || String(error), gcsUri });
  }
}
