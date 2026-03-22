import { Storage } from '@google-cloud/storage';

function getStorageClient() {
  try {
    const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!serviceAccountJson) return new Storage();
    const credentials = JSON.parse(serviceAccountJson);
    return new Storage({ credentials });
  } catch (error) {
    console.warn('storage-diagnostics: failed to initialize GCS client', error?.message || error);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  }

  const validationBucket = String(
    process.env.VALIDATION_BUCKET || process.env.TOOLS_BUCKET || 'levante-tools'
  ).trim();

  const diagnostics = {
    success: true,
    checkedAt: new Date().toISOString(),
    buckets: {
      validationBucketResolved: validationBucket,
      assetsDevBucketResolved: String(process.env.ASSETS_DEV_BUCKET || process.env.AUDIO_DEV_BUCKET || 'levante-assets-dev').trim(),
      assetsDraftBucketResolved: String(process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft').trim()
    },
    gcs: {
      clientInitialized: false,
      validationBucketAccessible: false,
      validationBucketError: null
    }
  };

  try {
    const storage = getStorageClient();
    diagnostics.gcs.clientInitialized = Boolean(storage);
    if (!storage) {
      diagnostics.gcs.validationBucketError = 'gcs_client_unavailable';
      return res.status(200).json(diagnostics);
    }

    try {
      await storage.bucket(validationBucket).getMetadata();
      diagnostics.gcs.validationBucketAccessible = true;
    } catch (error) {
      diagnostics.gcs.validationBucketError = error?.message || String(error);
    }

    return res.status(200).json(diagnostics);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      message: error?.message || String(error),
      checkedAt: new Date().toISOString()
    });
  }
}
