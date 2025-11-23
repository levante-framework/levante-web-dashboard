import { Storage } from '@google-cloud/storage';

const DEFAULT_SOURCE_BUCKET = process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev';
const TARGET_BUCKET = process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';

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
    console.warn('move-audio-to-draft: failed to init storage client', error);
    storageClient = null;
  }
  return storageClient;
}

function sanitizePath(value) {
  return (value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

export default async function handler(req, res) {
  // Enable CORS
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
    const { bucket, path: objectPath } = req.body || {};
    
    if (!objectPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const sourceBucketName = bucket || DEFAULT_SOURCE_BUCKET;
    const storage = getStorage();
    
    if (!storage) {
      res.status(500).json({ error: 'GCS client unavailable' });
      return;
    }

    const sanitizedPath = sanitizePath(objectPath);
    const sourceBucket = storage.bucket(sourceBucketName);
    const sourceFile = sourceBucket.file(sanitizedPath);

    // Check if source file exists
    const [exists] = await sourceFile.exists();
    if (!exists) {
      res.status(404).json({ error: `Source file not found: ${sanitizedPath}` });
      return;
    }

    // Get source file metadata
    const [metadata] = await sourceFile.getMetadata();
    
    // Determine target path (keep same structure)
    const targetPath = sanitizedPath;
    const targetBucket = storage.bucket(TARGET_BUCKET);
    const targetFile = targetBucket.file(targetPath);

    // Copy file to target bucket
    await sourceFile.copy(targetFile);

    // Copy metadata if present
    if (metadata.metadata) {
      await targetFile.setMetadata({ metadata: metadata.metadata });
    }

    // Delete source file (move operation)
    await sourceFile.delete();

    res.status(200).json({
      success: true,
      message: `Moved ${sanitizedPath} from ${sourceBucketName} to ${TARGET_BUCKET}`,
      sourceBucket: sourceBucketName,
      targetBucket: TARGET_BUCKET,
      path: targetPath
    });
  } catch (error) {
    console.error('Error moving audio file:', error);
    res.status(500).json({
      error: 'Failed to move audio file',
      message: error.message
    });
  }
}

