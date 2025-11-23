import { Storage } from '@google-cloud/storage';

const DEFAULT_SOURCE_BUCKET = process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';

let storageClient = null;
function getStorage() {
  if (storageClient) return storageClient;
  try {
    const json = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (json) {
      const credentials = JSON.parse(json);
      storageClient = new Storage({ credentials, projectId: credentials.project_id });
    } else {
      storageClient = new Storage();
    }
  } catch (error) {
    console.error('delete-draft-audio: failed to init storage client', error);
    storageClient = null;
  }
  return storageClient;
}

function normalizePath(path) {
  return (path || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { files } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: 'invalid_request', message: 'No files provided for deletion.' });
      return;
    }

    const storage = getStorage();
    if (!storage) {
      res.status(500).json({ error: 'gcs_unavailable', message: 'Unable to initialize Google Cloud Storage client.' });
      return;
    }

    const results = [];

    for (const entry of files) {
      const bucketName = (entry && entry.bucket) || DEFAULT_SOURCE_BUCKET;
      const objectPath = normalizePath(entry && entry.path);

      if (!objectPath) {
        results.push({ status: 'error', reason: 'missing_path', bucket: bucketName });
        continue;
      }

      try {
        const bucket = storage.bucket(bucketName);
        const file = bucket.file(objectPath);
        const [exists] = await file.exists();

        if (!exists) {
          results.push({ status: 'missing', bucket: bucketName, path: objectPath });
          continue;
        }

        await file.delete();
        results.push({ status: 'deleted', bucket: bucketName, path: objectPath });
      } catch (error) {
        console.error('delete-draft-audio error:', error);
        results.push({ status: 'error', bucket: bucketName, path: objectPath, reason: error.message });
      }
    }

    const deleted = results.filter((item) => item.status === 'deleted').length;
    res.status(200).json({ deleted, results });
  } catch (error) {
    console.error('delete-draft-audio handler error', error);
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
}
