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
    console.warn('site-approve-audio: failed to init storage client', error);
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

function extractLanguageAndFile(objectPath) {
  const parts = (objectPath || '').split('/').filter(Boolean);
  const audioIndex = parts.indexOf('audio');
  if (audioIndex === -1 || parts.length <= audioIndex + 1) return null;
  const language = parts[audioIndex + 1];
  const fileSegments = parts.slice(audioIndex + 2);
  const fileName = fileSegments.length ? fileSegments.join('/') : language;
  return language && fileName ? { language, fileName } : null;
}

function stripExtension(fileName) {
  const idx = fileName.lastIndexOf('.');
  if (idx === -1) return { base: fileName, extension: '' };
  return {
    base: fileName.slice(0, idx),
    extension: fileName.slice(idx)
  };
}

function removeVersionSuffix(base) {
  if (!base) return base;
  const versionRegex = /(_v\d{3}|-v\d{3})$/i;
  return base.replace(versionRegex, '') || base;
}

function extractVersionFromPath(path) {
  const match = (path || '').match(/_v(\d{3})/i);
  if (!match) return null;
  const asNumber = parseInt(match[1], 10);
  return Number.isFinite(asNumber) ? asNumber : null;
}

function buildDeployDestination(language, fileName) {
  const { base, extension } = stripExtension(fileName);
  const cleanBase = removeVersionSuffix(base);
  const safeExt = extension || '.mp3';
  return sanitizePath(`deploy/${language}/${cleanBase}${safeExt}`);
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
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  try {
    const { files } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: 'no_files', message: 'No files provided for approval.' });
      return;
    }

    const storage = getStorage();
    if (!storage) {
      res.status(500).json({ error: 'gcs_unavailable', message: 'Unable to initialize Google Cloud Storage client.' });
      return;
    }

    const results = [];

    for (const entry of files) {
      const sourceBucketName = sanitizePath((entry && entry.bucket) || DEFAULT_SOURCE_BUCKET);
      const rawPath = sanitizePath(entry && entry.path);

      if (!sourceBucketName || !rawPath) {
        results.push({ path: rawPath || '(missing)', status: 'skipped', reason: 'Missing bucket or object path' });
        continue;
      }

      const languageInfo = extractLanguageAndFile(rawPath);
      if (!languageInfo) {
        results.push({ path: rawPath, status: 'skipped', reason: 'Unable to derive language/file' });
        continue;
      }

      const { language, fileName } = languageInfo;
      const destinationPath = buildDeployDestination(language, fileName);

      try {
        const bucket = storage.bucket(sourceBucketName);
        const sourceFile = bucket.file(rawPath);
        const destinationFile = bucket.file(destinationPath);
        const [exists] = await sourceFile.exists();
        if (!exists) {
          results.push({ path: rawPath, status: 'skipped', reason: 'Source file missing' });
          continue;
        }

        const approvedVersion = extractVersionFromPath(rawPath);
        const approvedAt = new Date().toISOString();

        await sourceFile.copy(destinationFile);
        try {
          const metadataPayload = {
            siteApprovedSource: rawPath,
            siteApprovedAt: approvedAt
          };
          if (approvedVersion !== null) {
            metadataPayload.siteApprovedVersion = String(approvedVersion).padStart(3, '0');
          }

          await destinationFile.setMetadata({
            metadata: metadataPayload
          });
        } catch (metaError) {
          console.warn('site-approve-audio: failed to set metadata on deploy file', {
            path: destinationPath,
            error: metaError?.message
          });
        }

        results.push({
          path: rawPath,
          status: 'deployed',
          destination: destinationPath,
          approvedVersion,
          approvedAt
        });
      } catch (error) {
        console.error('site-approve-audio copy failed', rawPath, error);
        results.push({ path: rawPath, status: 'error', reason: error?.message || 'copy_failed' });
      }
    }

    const deployed = results.filter((item) => item.status === 'deployed').length;
    res.status(200).json({ deployed, results });
  } catch (error) {
    console.error('site-approve-audio handler error', error);
    res.status(500).json({ error: 'internal_error', message: error?.message || 'Unexpected error' });
  }
}
