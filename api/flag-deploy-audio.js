import { Storage } from '@google-cloud/storage';

const DEFAULT_SOURCE_BUCKET = process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';
const QUEUE_PREFIX = process.env.AUDIO_DEPLOY_QUEUE_PREFIX || 'deploy-queue';
const QUEUE_OBJECT = process.env.AUDIO_DEPLOY_QUEUE_OBJECT || 'queue.json';

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
    console.warn('flag-deploy-audio: failed to init storage', error);
    storageClient = null;
  }
  return storageClient;
}

function sanitizeSegment(value) {
  return (value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

function sanitizeBucketName(value) {
  const cleaned = (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-.]/g, '');
  return cleaned || DEFAULT_SOURCE_BUCKET;
}

function getQueueObjectPath() {
  const prefix = QUEUE_PREFIX.replace(/\/+$/u, '');
  const object = QUEUE_OBJECT.replace(/^\/+/, '');
  if (prefix) {
    return `${prefix}/${object}`;
  }
  return object || 'deploy-queue/queue.json';
}

async function loadQueue(storage, bucketName) {
  const bucket = storage.bucket(bucketName);
  const objectPath = getQueueObjectPath();
  const file = bucket.file(objectPath);
  try {
    const [exists] = await file.exists();
    if (!exists) {
      return { entries: {}, updatedAt: null };
    }
    const [contents] = await file.download();
    const parsed = JSON.parse(contents.toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      const entries = parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
      return { entries, updatedAt: parsed.updatedAt || null };
    }
  } catch (error) {
    console.warn('flag-deploy-audio: failed to load queue', { bucketName, error });
  }
  return { entries: {}, updatedAt: null };
}

async function saveQueue(storage, bucketName, entries) {
  const bucket = storage.bucket(bucketName);
  const objectPath = getQueueObjectPath();
  const file = bucket.file(objectPath);
  const payload = {
    bucket: bucketName,
    updatedAt: new Date().toISOString(),
    entries
  };
  await file.save(JSON.stringify(payload, null, 2), {
    contentType: 'application/json',
    resumable: false,
    gzip: true
  });
  return payload;
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

  const storage = getStorage();
  if (!storage) {
    res.status(500).json({ error: 'gcs_unavailable', message: 'Unable to initialise Google Cloud Storage client.' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const bucketName = sanitizeBucketName(req.query.bucket);
      const queue = await loadQueue(storage, bucketName);
      res.status(200).json({ bucket: bucketName, ...queue });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const { files, action } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: 'no_files', message: 'No files provided for flagging.' });
      return;
    }

    const primaryBucket = sanitizeBucketName((files[0] && files[0].bucket) || req.body?.bucket || DEFAULT_SOURCE_BUCKET);
    const queue = await loadQueue(storage, primaryBucket);
    const entries = queue.entries || {};

    let flagged = 0;
    let cleared = 0;

    files.forEach((entry) => {
      const bucketName = sanitizeBucketName((entry && entry.bucket) || primaryBucket);
      const objectPath = sanitizeSegment(entry && entry.path);
      if (!bucketName || !objectPath) {
        return;
      }

      if (bucketName !== primaryBucket) {
        console.warn('flag-deploy-audio: skipping entry with mismatched bucket', { primaryBucket, bucketName, objectPath });
        return;
      }

      if (action === 'clear') {
        if (entries[objectPath]) {
          delete entries[objectPath];
          cleared += 1;
        }
        return;
      }

      entries[objectPath] = {
        bucket: bucketName,
        path: objectPath,
        flaggedAt: new Date().toISOString()
      };
      flagged += 1;
    });

    const payload = await saveQueue(storage, primaryBucket, entries);

    res.status(200).json({ bucket: primaryBucket, flagged, cleared, entries: payload.entries, updatedAt: payload.updatedAt });
  } catch (error) {
    console.error('flag-deploy-audio error', error);
    res.status(500).json({ error: 'internal_error', message: error.message || 'Unexpected error' });
  }
}
