import { Storage } from '@google-cloud/storage';

const BUCKET_NAME = process.env.VALIDATION_BUCKET || process.env.TOOLS_BUCKET || 'levante-tools';
const BY_LANGUAGE_PREFIX = process.env.VALIDATION_RESULTS_BY_LANGUAGE_PREFIX || 'validations/by-language';
const VERSION_HISTORY_BY_LANGUAGE_PREFIX = process.env.VALIDATION_RESULTS_HISTORY_BY_LANGUAGE_PREFIX || 'validations/history/by-language';
const VERSION_HISTORY_AGGREGATE_PREFIX = process.env.VALIDATION_RESULTS_HISTORY_AGGREGATE_PREFIX || 'validations/history/aggregate';
const MAX_HISTORY_PER_LANGUAGE = Number(process.env.VALIDATION_HISTORY_MAX_PER_LANGUAGE || 30);
const MAX_HISTORY_AGGREGATE = Number(process.env.VALIDATION_HISTORY_MAX_AGGREGATE || 30);

function getStorageClient() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!serviceAccountJson) {
    try {
      return new Storage();
    } catch (_e) {
      return null;
    }
  }
  try {
    const credentials = JSON.parse(serviceAccountJson);
    return new Storage({ credentials });
  } catch (_e) {
    return null;
  }
}

function normalizeLanguageCodeForPath(language) {
  return String(language || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '_');
}

function getLanguageFilePath(language) {
  return `${BY_LANGUAGE_PREFIX}/${normalizeLanguageCodeForPath(language)}.json`;
}

function getLanguageHistoryPrefix(language) {
  return `${VERSION_HISTORY_BY_LANGUAGE_PREFIX}/${normalizeLanguageCodeForPath(language)}/`;
}

function getLanguageVersionFilePath(language, versionId) {
  return `${getLanguageHistoryPrefix(language)}${String(versionId || '').trim()}.json`;
}

function getAggregateVersionFilePath(versionId) {
  return `${VERSION_HISTORY_AGGREGATE_PREFIX}/${String(versionId || '').trim()}.json`;
}

function buildVersionId() {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${iso}-${rand}`;
}

async function pruneHistoryFiles(bucket, prefix, maxKeep) {
  const limit = Number(maxKeep);
  if (!Number.isFinite(limit) || limit <= 0) return;
  try {
    const [files] = await bucket.getFiles({ prefix });
    const jsonFiles = (files || []).filter((file) => String(file?.name || '').toLowerCase().endsWith('.json'));
    if (jsonFiles.length <= limit) return;
    const sortedNewestFirst = jsonFiles.sort((a, b) => String(b.name || '').localeCompare(String(a.name || '')));
    const toDelete = sortedNewestFirst.slice(limit);
    await Promise.all(toDelete.map(async (file) => {
      try {
        await file.delete({ ignoreNotFound: true });
      } catch (_e) {
        // ignore cleanup failures
      }
    }));
  } catch (_e) {
    // ignore cleanup failures
  }
}

async function readJsonFile(file) {
  const [buf] = await file.download();
  return JSON.parse(buf.toString());
}

async function rebuildAggregateFromByLanguage(bucket) {
  const [files] = await bucket.getFiles({ prefix: `${BY_LANGUAGE_PREFIX}/` });
  const combined = {};
  for (const file of files || []) {
    const name = String(file?.name || '');
    if (!name.toLowerCase().endsWith('.json')) continue;
    try {
      const payload = await readJsonFile(file);
      const lang = String(payload?.language || '').trim();
      const byItem = payload?.validation_results && typeof payload.validation_results === 'object'
        ? payload.validation_results
        : {};
      if (!lang) continue;
      Object.entries(byItem).forEach(([itemId, entry]) => {
        if (!combined[itemId]) combined[itemId] = {};
        combined[itemId][lang] = entry && typeof entry === 'object' ? entry : {};
      });
    } catch (_e) {
      // skip malformed files
    }
  }
  let validationCount = 0;
  Object.values(combined).forEach((byLang) => {
    validationCount += Object.keys(byLang || {}).length;
  });
  return {
    validation_results: combined,
    metadata: {
      version: '2.0',
      storage_mode: 'by-language',
      saved: new Date().toISOString(),
      item_count: Object.keys(combined).length,
      validation_count: validationCount
    }
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const storage = getStorageClient();
  if (!storage) {
    return res.status(500).json({ success: false, error: 'GCS client unavailable' });
  }
  const bucket = storage.bucket(BUCKET_NAME);

  try {
    if (req.method === 'GET') {
      const language = String(req.query.language || '').trim();
      if (!language) {
        return res.status(400).json({ success: false, error: 'Missing required query param: language' });
      }
      const prefix = getLanguageHistoryPrefix(language);
      const [files] = await bucket.getFiles({ prefix });
      const versions = [];
      for (const file of files || []) {
        const name = String(file?.name || '');
        if (!name.toLowerCase().endsWith('.json')) continue;
        const versionId = name.split('/').pop().replace(/\.json$/i, '');
        versions.push({
          versionId,
          path: name,
          updated: file?.metadata?.updated || null,
          size: Number(file?.metadata?.size || 0)
        });
      }
      versions.sort((a, b) => String(b.versionId).localeCompare(String(a.versionId)));
      return res.status(200).json({
        success: true,
        language,
        count: versions.length,
        versions
      });
    }

    if (req.method === 'POST') {
      const language = String(req.body?.language || '').trim();
      const versionId = String(req.body?.versionId || '').trim();
      if (!language || !versionId) {
        return res.status(400).json({ success: false, error: 'Missing required body fields: language, versionId' });
      }

      const historyFile = bucket.file(getLanguageVersionFilePath(language, versionId));
      const [exists] = await historyFile.exists();
      if (!exists) {
        return res.status(404).json({ success: false, error: 'Version file not found' });
      }
      const payload = await readJsonFile(historyFile);
      const byItem = payload?.validation_results && typeof payload.validation_results === 'object'
        ? payload.validation_results
        : {};

      const latestLanguagePayload = {
        language,
        validation_results: byItem,
        metadata: {
          ...(payload?.metadata || {}),
          restored_from_version: versionId,
          restored_at: new Date().toISOString(),
          storage_mode: 'by-language'
        }
      };
      const latestLanguageFile = bucket.file(getLanguageFilePath(language));
      await latestLanguageFile.save(JSON.stringify(latestLanguagePayload, null, 2), {
        contentType: 'application/json',
        resumable: false
      });

      const aggregatePayload = await rebuildAggregateFromByLanguage(bucket);
      aggregatePayload.metadata.restored_language = language;
      aggregatePayload.metadata.restored_from_version = versionId;

      const rollbackVersionId = buildVersionId();
      const aggregateHistoryFile = bucket.file(getAggregateVersionFilePath(rollbackVersionId));
      await aggregateHistoryFile.save(JSON.stringify(aggregatePayload, null, 2), {
        contentType: 'application/json',
        resumable: false
      });
      await pruneHistoryFiles(bucket, `${VERSION_HISTORY_AGGREGATE_PREFIX}/`, MAX_HISTORY_AGGREGATE);
      await pruneHistoryFiles(bucket, getLanguageHistoryPrefix(language), MAX_HISTORY_PER_LANGUAGE);

      return res.status(200).json({
        success: true,
        message: 'Rollback applied successfully',
        language,
        restoredFromVersion: versionId,
        rollbackVersionId
      });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Rollback API failed',
      message: error?.message || String(error)
    });
  }
}
