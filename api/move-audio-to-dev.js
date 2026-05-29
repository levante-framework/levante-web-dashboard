import { Storage } from '@google-cloud/storage';

const DEFAULT_SOURCE_BUCKET = process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';
const TARGET_BUCKET = process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev';

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
    console.warn('move-audio-to-dev: failed to init storage client', error);
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

function parseAudioObjectPath(objectPath) {
  const match = String(objectPath || '').match(/^audio\/([^/]+)\/(.+?)(?:_v\d{3})?\.mp3$/i);
  if (!match) return null;
  return {
    language: match[1],
    baseId: match[2]
  };
}

export function normalizeLangCode(langCode) {
  return String(langCode || '').trim().replace(/_/g, '-').toLowerCase();
}

export function normalizeTaskCandidates(taskName) {
  const raw = String(taskName || '').trim().toLowerCase();
  if (!raw) return [];
  const slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const underscored = slug.replace(/-/g, '_');
  return Array.from(new Set([raw, slug, underscored].filter(Boolean)));
}

export function getLanguageAliases(langCode) {
  const normalized = normalizeLangCode(langCode);
  if (!normalized) return [];
  const aliases = new Set([normalized, normalized.replace(/-/g, '_')]);
  const primary = normalized.split('-')[0];
  if (primary) {
    aliases.add(primary);
    aliases.add(primary.replace(/-/g, '_'));
  }
  return Array.from(aliases.values());
}

export function isLikelyTaskTranslationPath(pathName, taskCandidates, langAliases) {
  const normalizedPath = String(pathName || '').replace(/\\/g, '/').toLowerCase();
  if (!normalizedPath.endsWith('.json')) return false;
  if (!normalizedPath.includes('/itembank_by_task/')) return false;
  if (!taskCandidates.some((task) => normalizedPath.endsWith(`/itembank_by_task/${task}.json`))) return false;
  if (!langAliases.some((alias) => normalizedPath.includes(`/${alias}/`) || normalizedPath.startsWith(`${alias}/`))) return false;
  return true;
}

async function copyTaskTranslationJsonFiles(storage, sourceBucketName, taskName, langCode) {
  const taskCandidates = normalizeTaskCandidates(taskName);
  const langAliases = getLanguageAliases(langCode);
  if (!taskCandidates.length || !langAliases.length) {
    return { copied: 0, matched: 0 };
  }

  const sourceBucket = storage.bucket(sourceBucketName);
  const targetBucket = storage.bucket(TARGET_BUCKET);
  const candidatePrefixes = [
    ...langAliases.map((alias) => `${alias}/`),
    ...langAliases.map((alias) => `translations/${alias}/`),
    ...langAliases.map((alias) => `main/${alias}/`),
  ];

  const matchedPaths = new Set();
  for (const prefix of candidatePrefixes) {
    const [files] = await sourceBucket.getFiles({ prefix });
    (files || []).forEach((file) => {
      const name = String(file?.name || '').trim();
      if (!name) return;
      if (isLikelyTaskTranslationPath(name, taskCandidates, langAliases)) {
        matchedPaths.add(name);
      }
    });
  }

  let copied = 0;
  for (const sourcePath of matchedPaths) {
    try {
      await sourceBucket.file(sourcePath).copy(targetBucket.file(sourcePath));
      copied += 1;
    } catch (error) {
      console.warn(`move-audio-to-dev: failed to copy task translation ${sourcePath}: ${error?.message || error}`);
    }
  }

  return {
    copied,
    matched: matchedPaths.size,
  };
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
    const { bucket, path: objectPath, task, langCode, copyTaskTranslations } = req.body || {};
    
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
    
    // Promote latest approved version to canonical unsuffixed filename in dev.
    // Example: audio/es-AR/item_v001.mp3 -> audio/es-AR/item.mp3
    const targetPath = sanitizedPath.replace(/_v\d{3}(?=\.mp3$)/i, '');
    const targetBucket = storage.bucket(TARGET_BUCKET);
    const targetFile = targetBucket.file(targetPath);

    // Copy file to target bucket
    await sourceFile.copy(targetFile);

    // Copy metadata if present
    if (metadata.metadata) {
      await targetFile.setMetadata({ metadata: metadata.metadata });
    }

    // Delete source file (move operation). If deletion fails after a successful copy,
    // we still return success so task completion is not blocked by cleanup permissions.
    let sourceDeleted = true;
    let sourceDeleteError = '';
    try {
      await sourceFile.delete();
    } catch (deleteError) {
      sourceDeleted = false;
      sourceDeleteError = String(deleteError?.message || deleteError || '');
      console.warn(`move-audio-to-dev: copied to ${TARGET_BUCKET} but could not delete source ${sanitizedPath}: ${sourceDeleteError}`);
    }

    // Cleanup stale draft siblings for the same base item.
    // This removes old canonical and versioned copies left behind in draft.
    let cleanedDraftSiblings = 0;
    const parsedPath = parseAudioObjectPath(sanitizedPath);
    if (parsedPath && sourceDeleted) {
      const siblingPrefix = `audio/${parsedPath.language}/${parsedPath.baseId}`;
      const versionPattern = new RegExp(`^${siblingPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_v\\d{3}\\.mp3$`, 'i');
      const [siblings] = await sourceBucket.getFiles({ prefix: siblingPrefix });
      const deletions = siblings
        .map((file) => file?.name)
        .filter((name) => {
          if (!name || !name.toLowerCase().endsWith('.mp3')) return false;
          if (name === sanitizedPath) return false;
          return name === `${siblingPrefix}.mp3` || versionPattern.test(name);
        })
        .map((name) => sourceBucket.file(name).delete().then(
          () => ({ ok: true }),
          () => ({ ok: false })
        ));
      if (deletions.length > 0) {
        const results = await Promise.all(deletions);
        cleanedDraftSiblings = results.filter((r) => r.ok).length;
      }
    }

    let translationJsonCopy = { copied: 0, matched: 0 };
    if (copyTaskTranslations === true) {
      translationJsonCopy = await copyTaskTranslationJsonFiles(storage, sourceBucketName, task, langCode);
    }

    res.status(200).json({
      success: true,
      message: sourceDeleted
        ? `Moved ${sanitizedPath} from ${sourceBucketName} to ${TARGET_BUCKET}`
        : `Copied ${sanitizedPath} to ${TARGET_BUCKET}, but source delete failed`,
      sourceBucket: sourceBucketName,
      targetBucket: TARGET_BUCKET,
      path: targetPath,
      promotedFromVersionedPath: sanitizedPath !== targetPath,
      cleanedDraftSiblings,
      sourceDeleted,
      sourceDeleteError,
      translationJsonCopy
    });
  } catch (error) {
    console.error('Error moving audio file:', error);
    res.status(500).json({
      error: 'Failed to move audio file',
      message: error.message
    });
  }
}

