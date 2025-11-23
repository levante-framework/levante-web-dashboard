import fs from 'fs';
import path from 'path';
import { Storage } from '@google-cloud/storage';

const DEFAULT_SOURCE_BUCKET = process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';
const TARGET_BUCKET = process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev';

let storageClient = null;
function getStorage() {
  if (storageClient) return storageClient;
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  try {
    if (raw) {
      const creds = JSON.parse(raw);
      storageClient = new Storage({ credentials: creds, projectId: creds.project_id });
    } else {
      storageClient = new Storage();
    }
  } catch (error) {
    console.warn('Failed to initialize Storage client:', error.message);
    storageClient = null;
  }
  return storageClient;
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function extractLanguageInfo(objectPath) {
  const parts = (objectPath || '').split('/').filter(Boolean);
  const audioIndex = parts.indexOf('audio');
  if (audioIndex >= 0 && parts.length > audioIndex + 1) {
    return {
      language: parts[audioIndex + 1],
      fileName: parts.slice(audioIndex + 2).join('/') || parts[audioIndex + 1]
    };
  }
  const fileName = parts.pop() || '';
  const language = parts.pop() || 'misc';
  return { language, fileName };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { files } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: 'No files provided' });
      return;
    }

    const storage = getStorage();
    if (!storage) {
      res.status(500).json({ error: 'GCS client unavailable' });
      return;
    }

    const results = [];
    for (const entry of files) {
      const sourceBucketName = (entry && entry.bucket) || DEFAULT_SOURCE_BUCKET;
      const objectPath = entry && entry.path;
      if (!objectPath) {
        results.push({ path: objectPath || '(unknown)', status: 'skipped', reason: 'Missing path' });
        continue;
      }

      try {
        const { language, fileName } = extractLanguageInfo(objectPath);
        if (!language || !fileName) {
          results.push({ path: objectPath, status: 'skipped', reason: 'Unable to determine language/file name' });
          continue;
        }

        const sourceBucket = storage.bucket(sourceBucketName);
        const sourceFile = sourceBucket.file(objectPath);
        const [exists] = await sourceFile.exists();
        if (!exists) {
          results.push({ path: objectPath, status: 'skipped', reason: 'Source file missing' });
          continue;
        }

        const [buffer] = await sourceFile.download();

        const repoBase = path.join(process.cwd(), 'audio_files', language);
        const repoPath = path.join(repoBase, fileName);
        ensureDirectory(path.dirname(repoPath));
        fs.writeFileSync(repoPath, buffer);

        const targetBucket = storage.bucket(TARGET_BUCKET);
        const targetPath = `audio/${language}/${fileName}`.replace(/\\/g, '/');
        const targetFile = targetBucket.file(targetPath);
        await targetFile.save(buffer, {
          contentType: 'audio/mpeg',
          resumable: false,
          metadata: { cacheControl: 'public, max-age=3600' }
        });

        results.push({ path: objectPath, status: 'copied', language, repoPath, bucketPath: targetPath });
      } catch (error) {
        console.error('Failed to copy', objectPath, error);
        results.push({ path: objectPath, status: 'error', reason: error.message });
      }
    }

    const copied = results.filter(r => r.status === 'copied').length;
    res.status(200).json({ copied, results });
  } catch (error) {
    console.error('copy-approved-audio error', error);
    res.status(500).json({ error: error.message || 'Internal error' });
  }
}
