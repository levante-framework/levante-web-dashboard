import { Storage } from '@google-cloud/storage';
import { getStorageClientFromEnv } from './lib/gcp-credentials.js';
import NodeID3 from 'node-id3';

const DEFAULT_SOURCE_BUCKET = (process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft').trim().replace(/\\n$/g, '').replace(/\n+$/g, '');
const TARGET_BUCKET = (process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev').trim().replace(/\\n$/g, '').replace(/\n+$/g, '');

let storageClient = null;
function getStorage() {
  if (storageClient) return storageClient;
  storageClient = getStorageClientFromEnv(Storage);
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

function safeTagValue(value, maxLen = 512) {
  return String(value || '').trim().slice(0, maxLen);
}

function normalizeUserDefinedTextEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries
    .map((entry) => ({
      description: safeTagValue(entry?.description, 120),
      value: safeTagValue(entry?.value, 4000)
    }))
    .filter((entry) => entry.description && entry.value);
}

function upsertUserDefinedTag(entries, description, value) {
  const cleanDescription = safeTagValue(description, 120);
  const cleanValue = safeTagValue(value, 4000);
  if (!cleanDescription) return entries;
  const filtered = entries.filter((entry) => entry.description !== cleanDescription);
  if (cleanValue) {
    filtered.push({ description: cleanDescription, value: cleanValue });
  }
  return filtered;
}

async function applyApprovalId3Tags(file, { approver, approvedAt }) {
  const approverTag = safeTagValue(approver, 160);
  const approvedAtTag = safeTagValue(approvedAt, 80);
  if (!approverTag && !approvedAtTag) return false;

  const [rawAudio] = await file.download();
  let existingTags = {};
  try {
    existingTags = NodeID3.read(rawAudio) || {};
  } catch (_) {
    existingTags = {};
  }

  let userDefinedText = normalizeUserDefinedTextEntries(existingTags.userDefinedText);
  userDefinedText = upsertUserDefinedTag(userDefinedText, 'approved_by', approverTag);
  userDefinedText = upsertUserDefinedTag(userDefinedText, 'approved_at', approvedAtTag);

  let taggedAudio = rawAudio;
  try {
    taggedAudio = NodeID3.update({ userDefinedText }, rawAudio);
  } catch (error) {
    console.warn('move-audio-to-dev: failed updating ID3 approval tags, keeping original audio bytes', error?.message || error);
    return false;
  }

  if (!Buffer.isBuffer(taggedAudio)) return false;
  await file.save(taggedAudio, { contentType: 'audio/mpeg', resumable: false, public: false });
  return true;
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

// Maps the dashboard's human-facing task labels (and common aliases) to the
// canonical item-bank folder slug used in the assets buckets. Keys are
// normalized: lowercased, "&" -> "and", non-alphanumerics collapsed to spaces.
const TASK_SLUG_ALIASES = {
  'memory': 'memory-game',
  'memory game': 'memory-game',
  'pattern matching': 'matrix-reasoning',
  'matrix': 'matrix-reasoning',
  'matrix reasoning': 'matrix-reasoning',
  'math': 'egma-math',
  'egma math': 'egma-math',
  'shape rotation': 'mental-rotation',
  'mental rotation': 'mental-rotation',
  'same and different': 'same-different-selection',
  'same different': 'same-different-selection',
  'same different selection': 'same-different-selection',
  'sentence understanding': 'trog',
  'trog': 'trog',
  'stories': 'theory-of-mind',
  'theory of mind': 'theory-of-mind',
  'vocabulary': 'vocab',
  'vocab': 'vocab',
  'hearts and flowers': 'hearts-and-flowers',
  'hostile attribution': 'hostile-attribution',
  'thoughts and feelings': 'child-survey',
  'child survey': 'child-survey',
};

// Resolve a task label (display name OR canonical slug) to the set of folder
// slugs to search for translation JSON files under translations/itembank/.
export function getTaskSlugCandidates(taskName) {
  const raw = String(taskName || '').trim().toLowerCase();
  if (!raw) return [];
  const normalizedKey = raw.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
  const candidates = new Set();
  if (normalizedKey && TASK_SLUG_ALIASES[normalizedKey]) {
    candidates.add(TASK_SLUG_ALIASES[normalizedKey]);
  }
  // Also treat the label itself as a slug, covering canonical slugs passed directly.
  const slug = normalizedKey.replace(/\s+/g, '-');
  if (slug) candidates.add(slug);
  return Array.from(candidates);
}

// Matches the real bucket layout:
//   translations/itembank/<task-slug>/<lang>/item-bank-translations.json
export function isLikelyTaskTranslationPath(pathName, slugCandidates, langAliases) {
  const normalizedPath = String(pathName || '').replace(/\\/g, '/').toLowerCase();
  if (!normalizedPath.endsWith('.json')) return false;
  if (!normalizedPath.includes('/itembank/')) return false;
  if (!slugCandidates.some((slug) => normalizedPath.includes(`/itembank/${slug}/`))) return false;
  if (!langAliases.some((alias) => normalizedPath.includes(`/${alias}/`))) return false;
  return true;
}

async function copyTaskTranslationJsonFiles(storage, sourceBucketName, taskName, langCode) {
  const slugCandidates = getTaskSlugCandidates(taskName);
  const langAliases = getLanguageAliases(langCode);
  if (!slugCandidates.length || !langAliases.length) {
    return { copied: 0, matched: 0 };
  }

  const sourceBucket = storage.bucket(sourceBucketName);
  const targetBucket = storage.bucket(TARGET_BUCKET);

  const matchedPaths = new Set();
  for (const slug of slugCandidates) {
    const prefix = `translations/itembank/${slug}/`;
    let files = [];
    try {
      [files] = await sourceBucket.getFiles({ prefix });
    } catch (error) {
      console.warn(`move-audio-to-dev: failed to list ${prefix}: ${error?.message || error}`);
      continue;
    }
    (files || []).forEach((file) => {
      const name = String(file?.name || '').trim();
      if (!name) return;
      if (isLikelyTaskTranslationPath(name, slugCandidates, langAliases)) {
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
    const { bucket, path: objectPath, task, langCode, copyTaskTranslations, approver, approvedAt } = req.body || {};
    
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

    let approvalTagsWritten = false;
    try {
      approvalTagsWritten = await applyApprovalId3Tags(targetFile, {
        approver,
        approvedAt: approvedAt || new Date().toISOString()
      });
    } catch (error) {
      console.warn('move-audio-to-dev: failed applying approval ID3 tags:', error?.message || error);
    }

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
      approvalTagsWritten,
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

