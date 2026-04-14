#!/usr/bin/env node

const { Storage } = require('@google-cloud/storage');

const BUCKET_NAME = process.env.VALIDATION_BUCKET || process.env.TOOLS_BUCKET || 'levante-tools';
const LEGACY_FILE_PATH = process.env.VALIDATION_RESULTS_OBJECT || 'validations/validation_results.json';
const BY_LANGUAGE_PREFIX = process.env.VALIDATION_RESULTS_BY_LANGUAGE_PREFIX || 'validations/by-language';
const VERSION_HISTORY_BY_LANGUAGE_PREFIX = process.env.VALIDATION_RESULTS_HISTORY_BY_LANGUAGE_PREFIX || 'validations/history/by-language';
const MAX_HISTORY_PER_LANGUAGE = Number(process.env.VALIDATION_HISTORY_MAX_PER_LANGUAGE || 30);

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (raw) {
    const credentials = JSON.parse(raw);
    return new Storage({ credentials, projectId: credentials.project_id });
  }
  return new Storage();
}

function normalizeLanguageCodeForPath(language) {
  return String(language || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '_');
}

function getLanguageLatestPath(language) {
  return `${BY_LANGUAGE_PREFIX}/${normalizeLanguageCodeForPath(language)}.json`;
}

function getLanguageHistoryPrefix(language) {
  return `${VERSION_HISTORY_BY_LANGUAGE_PREFIX}/${normalizeLanguageCodeForPath(language)}/`;
}

function getLanguageHistoryPath(language, versionId) {
  return `${getLanguageHistoryPrefix(language)}${versionId}.json`;
}

function buildVersionId() {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${iso}-${rand}`;
}

function splitByLanguage(validationResults) {
  const source = validationResults && typeof validationResults === 'object' ? validationResults : {};
  const byLanguage = {};
  Object.entries(source).forEach(([itemId, byLang]) => {
    if (!byLang || typeof byLang !== 'object') return;
    Object.entries(byLang).forEach(([langCode, entry]) => {
      const lang = String(langCode || '').trim();
      if (!lang) return;
      if (!byLanguage[lang]) byLanguage[lang] = {};
      byLanguage[lang][itemId] = entry && typeof entry === 'object' ? entry : {};
    });
  });
  return byLanguage;
}

async function pruneHistoryFiles(bucket, prefix, maxKeep) {
  const limit = Number(maxKeep);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const [files] = await bucket.getFiles({ prefix });
  const jsonFiles = (files || []).filter((file) => String(file?.name || '').toLowerCase().endsWith('.json'));
  if (jsonFiles.length <= limit) return 0;
  const sortedNewestFirst = jsonFiles.sort((a, b) => String(b.name || '').localeCompare(String(a.name || '')));
  const toDelete = sortedNewestFirst.slice(limit);
  let deleted = 0;
  for (const file of toDelete) {
    try {
      await file.delete({ ignoreNotFound: true });
      deleted += 1;
    } catch (_e) {
      // skip delete failures
    }
  }
  return deleted;
}

async function main() {
  const storage = getStorageClient();
  const bucket = storage.bucket(BUCKET_NAME);
  const legacyFile = bucket.file(LEGACY_FILE_PATH);
  const [exists] = await legacyFile.exists();
  if (!exists) {
    throw new Error(`Legacy validation file not found: gs://${BUCKET_NAME}/${LEGACY_FILE_PATH}`);
  }

  const [buf] = await legacyFile.download();
  const payload = JSON.parse(buf.toString());
  const validationResults = payload && typeof payload.validation_results === 'object'
    ? payload.validation_results
    : {};

  const byLanguage = splitByLanguage(validationResults);
  const languages = Object.keys(byLanguage).sort((a, b) => a.localeCompare(b));
  if (!languages.length) {
    console.log('No languages found in legacy validation file. Nothing to seed.');
    return;
  }

  const versionId = buildVersionId();
  let totalItems = 0;
  let totalEntries = 0;
  let totalHistoryPruned = 0;

  for (const language of languages) {
    const byItem = byLanguage[language] || {};
    const itemCount = Object.keys(byItem).length;
    totalItems += itemCount;
    totalEntries += itemCount;

    const languagePayload = {
      language,
      validation_results: byItem,
      metadata: {
        version: '2.0',
        storage_mode: 'by-language',
        seeded_from_legacy: true,
        seed_source: `gs://${BUCKET_NAME}/${LEGACY_FILE_PATH}`,
        seeded_at: new Date().toISOString(),
        item_count: itemCount
      }
    };

    const latestFile = bucket.file(getLanguageLatestPath(language));
    await latestFile.save(JSON.stringify(languagePayload, null, 2), {
      contentType: 'application/json',
      resumable: false
    });

    const historyFile = bucket.file(getLanguageHistoryPath(language, versionId));
    await historyFile.save(JSON.stringify(languagePayload, null, 2), {
      contentType: 'application/json',
      resumable: false
    });

    const pruned = await pruneHistoryFiles(bucket, getLanguageHistoryPrefix(language), MAX_HISTORY_PER_LANGUAGE);
    totalHistoryPruned += pruned;
    console.log(`Seeded ${language}: ${itemCount} items -> ${getLanguageLatestPath(language)} (pruned ${pruned})`);
  }

  console.log('--- Seed complete ---');
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Legacy source: ${LEGACY_FILE_PATH}`);
  console.log(`Languages seeded: ${languages.length}`);
  console.log(`Total items written across language files: ${totalItems}`);
  console.log(`Version id: ${versionId}`);
  console.log(`Total history files pruned: ${totalHistoryPruned}`);
}

main().catch((error) => {
  console.error('Seed failed:', error?.message || error);
  process.exit(1);
});
