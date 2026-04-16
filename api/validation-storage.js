/**
 * Validation Storage API Endpoint (GCS-backed)
 * Saves and loads validation results to/from Google Cloud Storage.
 * Falls back to in-memory storage if GCS is not available.
 */

import { Storage } from '@google-cloud/storage';

// In-memory fallback storage
let inMemoryValidationData = {
  validation_results: {},
  metadata: {
    created: new Date().toISOString(),
    version: '1.0',
    item_count: 0,
    validation_count: 0,
    description: 'Fallback in-memory validation results for Levante Translation Dashboard'
  }
};

// Validation storage should live in levante-tools (dev project).
const BUCKET_NAME = process.env.VALIDATION_BUCKET || process.env.TOOLS_BUCKET || 'levante-tools';
const BY_LANGUAGE_PREFIX = process.env.VALIDATION_RESULTS_BY_LANGUAGE_PREFIX || 'validations/by-language';
const VERSION_HISTORY_BY_LANGUAGE_PREFIX = process.env.VALIDATION_RESULTS_HISTORY_BY_LANGUAGE_PREFIX || 'validations/history/by-language';
const VERSION_HISTORY_AGGREGATE_PREFIX = process.env.VALIDATION_RESULTS_HISTORY_AGGREGATE_PREFIX || 'validations/history/aggregate';
const MAX_HISTORY_PER_LANGUAGE = Number(process.env.VALIDATION_HISTORY_MAX_PER_LANGUAGE || 30);
const MAX_HISTORY_AGGREGATE = Number(process.env.VALIDATION_HISTORY_MAX_AGGREGATE || 30);
const EXCLUDED_VALIDATION_PREFIXES = [
  'main/Z_LEGACY_DO_NOT_TRANSLATE/',
  'main/LEGACY_DO_NOT_TRANSLATE/'
];

function isExcludedValidationItemId(itemId) {
  const normalized = String(itemId || '').trim().toLowerCase();
  if (!normalized) return false;
  return EXCLUDED_VALIDATION_PREFIXES.some((prefix) => normalized.startsWith(String(prefix).toLowerCase()));
}

function sanitizeValidationResultsMap(validationResults) {
  const source = validationResults && typeof validationResults === 'object' ? validationResults : {};
  const out = {};
  Object.keys(source).forEach((itemId) => {
    if (isExcludedValidationItemId(itemId)) return;
    out[itemId] = source[itemId];
  });
  return out;
}

function mergeValidationEntry(existingEntry, incomingEntry) {
  const existing = existingEntry && typeof existingEntry === 'object' ? existingEntry : {};
  const incoming = incomingEntry && typeof incomingEntry === 'object' ? incomingEntry : {};
  const nextEntry = { ...existing, ...incoming };

  // Protect against accidental loss of review notes when clients send compact payloads.
  const incomingHasNeedsReview = Object.prototype.hasOwnProperty.call(incoming, 'needsReview');
  const incomingHasReason = Object.prototype.hasOwnProperty.call(incoming, 'reason');
  const incomingHasManualApproved = Object.prototype.hasOwnProperty.call(incoming, 'manualApproved');
  const incomingHasManualApprovalUpdatedAt = Object.prototype.hasOwnProperty.call(incoming, 'manualApprovalUpdatedAt');
  const incomingHasReviewUpdatedAt = Object.prototype.hasOwnProperty.call(incoming, 'reviewUpdatedAt');
  const incomingReviewUpdatedAt = String(incoming?.reviewUpdatedAt || '').trim();
  const existingReviewUpdatedAt = String(existing?.reviewUpdatedAt || '').trim();
  if (!incomingHasNeedsReview && existing.needsReview === true) {
    nextEntry.needsReview = true;
  }
  // Prevent stale clients from clearing shared review flags accidentally.
  // Clearing needsReview requires an explicit reviewUpdatedAt marker from the editor.
  if (
    existing.needsReview === true
    && incomingHasNeedsReview
    && incoming.needsReview !== true
  ) {
    const hasExplicitReviewChange = incomingHasReviewUpdatedAt && !!incomingReviewUpdatedAt;
    const incomingReviewIsNewer = hasExplicitReviewChange
      && (!existingReviewUpdatedAt || incomingReviewUpdatedAt >= existingReviewUpdatedAt);
    if (!incomingReviewIsNewer) {
      nextEntry.needsReview = true;
    }
  }
  if (!incomingHasReason && typeof existing.reason === 'string' && existing.reason) {
    nextEntry.reason = existing.reason;
  }
  if (
    existing.needsReview === true
    && typeof existing.reason === 'string'
    && existing.reason
    && incomingHasReason
    && !String(incoming.reason || '').trim()
  ) {
    const hasExplicitReviewChange = incomingHasReviewUpdatedAt && !!incomingReviewUpdatedAt;
    const incomingReviewIsNewer = hasExplicitReviewChange
      && (!existingReviewUpdatedAt || incomingReviewUpdatedAt >= existingReviewUpdatedAt);
    if (!incomingReviewIsNewer) {
      nextEntry.reason = existing.reason;
    }
  }
  if (!incomingHasReviewUpdatedAt && existingReviewUpdatedAt) {
    nextEntry.reviewUpdatedAt = existingReviewUpdatedAt;
  }
  // Preserve manual approvals unless the client explicitly toggled approval state.
  // This prevents re-validation payloads from unintentionally clearing approvals.
  if (!incomingHasManualApproved && existing.manualApproved === true) {
    nextEntry.manualApproved = true;
  }
  if (
    existing.manualApproved === true
    && incomingHasManualApproved
    && incoming.manualApproved !== true
    && !incomingHasManualApprovalUpdatedAt
  ) {
    nextEntry.manualApproved = true;
  }
  if (nextEntry.manualApproved === true) {
    nextEntry.score = 1;
    nextEntry.scoreSource = 'manual';
    if (!nextEntry.notes) nextEntry.notes = 'Manually approved';
  }

  return nextEntry;
}

function mergeValidationResultsWithExisting(existingResults, incomingResults) {
  const existing = sanitizeValidationResultsMap(existingResults || {});
  const incoming = sanitizeValidationResultsMap(incomingResults || {});
  const merged = { ...existing };

  Object.keys(incoming).forEach((itemId) => {
    const incomingByLang = incoming[itemId] && typeof incoming[itemId] === 'object' ? incoming[itemId] : {};
    const existingByLang = merged[itemId] && typeof merged[itemId] === 'object' ? merged[itemId] : {};
    const outByLang = { ...existingByLang };

    Object.keys(incomingByLang).forEach((langCode) => {
      const incomingEntry = incomingByLang[langCode] && typeof incomingByLang[langCode] === 'object'
        ? incomingByLang[langCode]
        : {};
      const existingEntry = existingByLang[langCode] && typeof existingByLang[langCode] === 'object'
        ? existingByLang[langCode]
        : {};
      outByLang[langCode] = mergeValidationEntry(existingEntry, incomingEntry);
    });

    merged[itemId] = outByLang;
  });

  return merged;
}

function normalizeLanguageCodeForPath(language) {
  return String(language || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '_');
}

function normalizeLanguageCode(language) {
  return String(language || '')
    .trim()
    .replace(/_/g, '-');
}

function getLanguageAliasCodes(language) {
  const raw = normalizeLanguageCode(language);
  if (!raw) return [];
  const out = new Set([raw]);
  const lower = raw.toLowerCase();
  out.add(lower);
  if (raw.includes('-')) {
    const base = raw.split('-')[0];
    if (base) {
      out.add(base);
      out.add(base.toLowerCase());
    }
  }
  // Preserve underscore variant for backward compatibility with legacy keys.
  out.add(raw.replace(/-/g, '_'));
  out.add(lower.replace(/-/g, '_'));
  // Keep Portuguese regional variants interoperable (pt-BR <-> pt-PT <-> pt).
  const aliasMap = {
    pt: ['pt', 'pt-BR', 'pt-br', 'pt-PT', 'pt-pt'],
    'pt-br': ['pt', 'pt-BR', 'pt-br', 'pt-PT', 'pt-pt'],
    'pt-pt': ['pt', 'pt-BR', 'pt-br', 'pt-PT', 'pt-pt']
  };
  (aliasMap[lower] || []).forEach((code) => out.add(code));
  Array.from(out).forEach((code) => {
    const s = String(code || '').trim();
    if (!s) return;
    out.add(s.toLowerCase());
    out.add(s.replace(/_/g, '-'));
    out.add(s.replace(/-/g, '_'));
    out.add(s.toLowerCase().replace(/_/g, '-'));
    out.add(s.toLowerCase().replace(/-/g, '_'));
  });
  return Array.from(out);
}

function getLanguageFilePath(language) {
  return `${BY_LANGUAGE_PREFIX}/${normalizeLanguageCodeForPath(language)}.json`;
}

function buildVersionId() {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${iso}-${rand}`;
}

function getLanguageVersionFilePath(language, versionId) {
  return `${VERSION_HISTORY_BY_LANGUAGE_PREFIX}/${normalizeLanguageCodeForPath(language)}/${versionId}.json`;
}

function getAggregateVersionFilePath(versionId) {
  return `${VERSION_HISTORY_AGGREGATE_PREFIX}/${versionId}.json`;
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
      } catch (deleteError) {
        console.warn(`Failed to prune history file ${file?.name}:`, deleteError?.message || deleteError);
      }
    }));
  } catch (e) {
    console.warn(`Failed to prune history prefix ${prefix}:`, e?.message || e);
  }
}

function splitValidationResultsByLanguage(validationResults) {
  const source = sanitizeValidationResultsMap(validationResults || {});
  const byLanguage = {};
  Object.entries(source).forEach(([itemId, byLang]) => {
    if (!byLang || typeof byLang !== 'object') return;
    Object.entries(byLang).forEach(([langCode, entry]) => {
      const lang = normalizeLanguageCode(langCode);
      if (!lang) return;
      if (!byLanguage[lang]) byLanguage[lang] = {};
      byLanguage[lang][itemId] = entry && typeof entry === 'object' ? entry : {};
    });
  });
  return byLanguage;
}

function combineLanguageMaps(languageMaps) {
  const out = {};
  Object.entries(languageMaps || {}).forEach(([langCode, byItem]) => {
    if (!byItem || typeof byItem !== 'object') return;
    Object.entries(byItem).forEach(([itemId, entry]) => {
      if (isExcludedValidationItemId(itemId)) return;
      if (!out[itemId]) out[itemId] = {};
      out[itemId][langCode] = entry && typeof entry === 'object' ? entry : {};
    });
  });
  return out;
}

function buildCombinedMapForLanguage(language, byItem) {
  const lang = String(language || '').trim();
  if (!lang) return {};
  const source = sanitizeValidationResultsMap(byItem || {});
  const out = {};
  Object.entries(source).forEach(([itemId, entry]) => {
    out[itemId] = { [lang]: entry && typeof entry === 'object' ? entry : {} };
  });
  return out;
}

function filterValidationResultsByLanguage(validationResults, language) {
  const lang = normalizeLanguageCode(language);
  if (!lang) return sanitizeValidationResultsMap(validationResults || {});
  const aliases = new Set(getLanguageAliasCodes(lang).map((code) => String(code || '').toLowerCase()));
  const source = sanitizeValidationResultsMap(validationResults || {});
  const out = {};
  Object.entries(source).forEach(([itemId, byLang]) => {
    if (!byLang || typeof byLang !== 'object') return;
    const matchingLang = Object.keys(byLang).find((existingLang) => {
      const existing = normalizeLanguageCode(existingLang).toLowerCase();
      const existingUnderscore = existing.replace(/-/g, '_');
      return aliases.has(existing) || aliases.has(existingUnderscore);
    });
    if (!matchingLang) return;
    out[itemId] = { [matchingLang]: byLang[matchingLang] };
  });
  return out;
}

function collectLanguagesFromValidationResults(validationResults) {
  const langs = new Set();
  Object.values(validationResults || {}).forEach((byLang) => {
    if (!byLang || typeof byLang !== 'object') return;
    Object.keys(byLang).forEach((langCode) => {
      const normalized = String(langCode || '').trim();
      if (normalized) langs.add(normalized);
    });
  });
  return Array.from(langs);
}

function getRequestedLanguage(req) {
  const raw = normalizeLanguageCode(req?.query?.language || '');
  return raw || '';
}

function getStorageClient() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!serviceAccountJson) {
    // Fall back to Application Default Credentials when explicit JSON is not set.
    // This supports local/dev auth flows like `gcloud auth application-default login`.
    try {
      return new Storage();
    } catch (e) {
      console.warn('Could not initialize GCS client via ADC:', e?.message || e);
      return null;
    }
  }
  let credentials;
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch (e) {
    console.warn('GCS credentials env is not valid JSON');
    return null;
  }
  return new Storage({ credentials });
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    switch (req.method) {
      case 'GET':
        return await getValidationResults(req, res);
      case 'POST':
        return await saveValidationResults(req, res);
      case 'PUT':
        return await updateValidationResults(req, res);
      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Validation storage error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}

async function loadByLanguageFromGCS(storage, requestedLanguage = '') {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const scopedLanguage = String(requestedLanguage || '').trim();
    if (scopedLanguage) {
      const languageCandidates = Array.from(new Set([
        scopedLanguage,
        ...getLanguageAliasCodes(scopedLanguage)
      ]));
      const scopedLanguageMaps = {};
      const loadedLanguageFiles = [];
      for (const candidate of languageCandidates) {
        const file = bucket.file(getLanguageFilePath(candidate));
        const [exists] = await file.exists();
        if (!exists) continue;
        const [buf] = await file.download();
        const parsed = JSON.parse(buf.toString());
        const lang = normalizeLanguageCode(parsed?.language || candidate || scopedLanguage);
        const byItem = parsed?.validation_results && typeof parsed.validation_results === 'object'
          ? parsed.validation_results
          : {};
        if (!Object.keys(byItem).length) continue;
        loadedLanguageFiles.push(getLanguageFilePath(candidate));
        if (!scopedLanguageMaps[lang]) scopedLanguageMaps[lang] = {};
        Object.entries(byItem).forEach(([itemId, entry]) => {
          if (isExcludedValidationItemId(itemId)) return;
          const existingEntry = scopedLanguageMaps[lang][itemId];
          scopedLanguageMaps[lang][itemId] = mergeValidationEntry(existingEntry, entry);
        });
      }
      if (Object.keys(scopedLanguageMaps).length) {
        const combined = combineLanguageMaps(scopedLanguageMaps);
        let validationCount = 0;
        Object.values(combined).forEach((byLang) => {
          validationCount += Object.keys(byLang || {}).length;
        });
        return {
          validation_results: combined,
          metadata: {
            version: '2.0',
            storage_mode: 'by-language',
            scoped_language: normalizeLanguageCode(scopedLanguage) || scopedLanguage,
            loaded_language_file: loadedLanguageFiles[0] || '',
            loaded_language_files: loadedLanguageFiles,
            item_count: Object.keys(combined).length,
            validation_count: validationCount,
            loaded: new Date().toISOString()
          }
        };
      }
      // If scoped language file is missing, fall back to full by-language scan.
      // This recovers data when historical files use a different variant key
      // (for example pt-BR vs pt-PT) and lets downstream filtering apply aliases.
    }

    const [files] = await bucket.getFiles({ prefix: `${BY_LANGUAGE_PREFIX}/` });
    const languageMaps = {};
    for (const file of files) {
      const name = String(file?.name || '');
      if (!name.toLowerCase().endsWith('.json')) continue;
      try {
        const [buf] = await file.download();
        const parsed = JSON.parse(buf.toString());
        const lang = String(parsed?.language || '').trim();
        const byItem = parsed?.validation_results && typeof parsed.validation_results === 'object'
          ? parsed.validation_results
          : {};
        if (!lang || !Object.keys(byItem).length) continue;
        languageMaps[lang] = sanitizeValidationResultsMap(byItem);
      } catch (readError) {
        console.warn(`Failed to parse by-language validation file ${name}:`, readError?.message || readError);
      }
    }
    if (!Object.keys(languageMaps).length) return null;
    const combined = combineLanguageMaps(languageMaps);
    let validationCount = 0;
    Object.values(combined).forEach((byLang) => {
      validationCount += Object.keys(byLang || {}).length;
    });
    return {
      validation_results: combined,
      metadata: {
        version: '2.0',
        storage_mode: 'by-language',
        item_count: Object.keys(combined).length,
        validation_count: validationCount,
        loaded: new Date().toISOString()
      }
    };
  } catch (e) {
    console.warn('Failed to load by-language validation results from GCS:', e.message);
    return null;
  }
}

async function loadFromGCS(options = {}) {
  const storage = getStorageClient();
  if (!storage) return null;
  const requestedLanguage = String(options?.requestedLanguage || '').trim();

  const byLanguageData = await loadByLanguageFromGCS(storage, requestedLanguage);
  if (byLanguageData) {
    console.log(`☁️ Loaded validation results from by-language GCS files: ${Object.keys(byLanguageData.validation_results || {}).length} items`);
    return byLanguageData;
  }
  return null;
}

async function saveToGCS(validationData, options = {}) {
  const storage = getStorageClient();
  if (!storage) return false;
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const fullResults = sanitizeValidationResultsMap(validationData?.validation_results || {});
    const byLanguageMaps = splitValidationResultsByLanguage(fullResults);
    const touchedLanguages = Array.isArray(options?.touchedLanguages)
      ? options.touchedLanguages.map((lang) => String(lang || '').trim()).filter(Boolean)
      : [];
    const languagesToWrite = touchedLanguages.length
      ? touchedLanguages
      : Object.keys(byLanguageMaps);
    const versionId = String(options?.versionId || buildVersionId());

    for (const lang of languagesToWrite) {
      const existingLangMap = (() => {
        const current = byLanguageMaps[lang];
        return current && typeof current === 'object' ? current : {};
      })();
      const payload = {
        language: lang,
        validation_results: existingLangMap,
        metadata: {
          saved: new Date().toISOString(),
          version: '2.0',
          storage_mode: 'by-language',
          item_count: Object.keys(existingLangMap).length
        }
      };
      const file = bucket.file(getLanguageFilePath(lang));
      await file.save(JSON.stringify(payload, null, 2), { contentType: 'application/json', resumable: false });
      try {
        const historyFile = bucket.file(getLanguageVersionFilePath(lang, versionId));
        await historyFile.save(JSON.stringify(payload, null, 2), { contentType: 'application/json', resumable: false });
        await pruneHistoryFiles(bucket, `${VERSION_HISTORY_BY_LANGUAGE_PREFIX}/${normalizeLanguageCodeForPath(lang)}/`, MAX_HISTORY_PER_LANGUAGE);
      } catch (historyError) {
        console.warn(`Failed to write by-language version snapshot for ${lang}:`, historyError?.message || historyError);
      }
    }

    // Keep a versioned aggregate snapshot for audit/rollback support.
    const aggregateSnapshot = {
      ...validationData,
      validation_results: fullResults,
      metadata: {
        ...(validationData?.metadata || {}),
        storage_mode: 'by-language',
        aggregate_snapshot_saved: new Date().toISOString()
      }
    };
    try {
      const aggregateHistoryFile = bucket.file(getAggregateVersionFilePath(versionId));
      await aggregateHistoryFile.save(JSON.stringify(aggregateSnapshot, null, 2), { contentType: 'application/json', resumable: false });
      await pruneHistoryFiles(bucket, `${VERSION_HISTORY_AGGREGATE_PREFIX}/`, MAX_HISTORY_AGGREGATE);
    } catch (historyError) {
      console.warn('Failed to write aggregate version snapshot:', historyError?.message || historyError);
    }

    console.log(`☁️ Saved validation results to GCS by-language (${languagesToWrite.length} files) + aggregate history snapshot (version ${versionId})`);
    return true;
  } catch (e) {
    console.warn('Failed to save validation results to GCS:', e.message);
    return false;
  }
}

async function getValidationResults(req, res) {
  try {
    const requestedLanguage = getRequestedLanguage(req);
    let validationData = await loadFromGCS({ requestedLanguage });
    if (!validationData) validationData = inMemoryValidationData;
    const scopedSource = requestedLanguage
      ? filterValidationResultsByLanguage(validationData.validation_results || {}, requestedLanguage)
      : validationData.validation_results || {};
    const sanitizedResults = sanitizeValidationResultsMap(scopedSource);
    const responseData = {
      ...validationData,
      validation_results: sanitizedResults,
      metadata: {
        ...(validationData.metadata || {}),
        item_count: Object.keys(sanitizedResults).length,
        ...(requestedLanguage ? { scoped_language: requestedLanguage } : {})
      }
    };
    return res.status(200).json({
      success: true,
      data: responseData,
      source: validationData === inMemoryValidationData ? 'memory' : 'gcs',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    throw new Error(`Failed to load validation results: ${error.message}`);
  }
}

async function saveValidationResults(req, res) {
  try {
    const { validation_results, metadata } = req.body || {};
    if (!validation_results) {
      return res.status(400).json({ error: 'Missing validation_results in request body' });
    }
    const existingData = await loadFromGCS();
    const existingResults = existingData?.validation_results || inMemoryValidationData.validation_results || {};
    const sanitizedResults = mergeValidationResultsWithExisting(existingResults, validation_results);

    // Count total validations
    let totalValidations = 0;
    Object.keys(sanitizedResults).forEach(itemId => {
      totalValidations += Object.keys(sanitizedResults[itemId] || {}).length;
    });

    const validationData = {
      validation_results: sanitizedResults,
      metadata: {
        ...metadata,
        saved: new Date().toISOString(),
        version: '2.0',
        storage_mode: 'by-language',
        version_id: buildVersionId(),
        item_count: Object.keys(sanitizedResults).length,
        validation_count: totalValidations
      }
    };

    const touchedLanguages = collectLanguagesFromValidationResults(validation_results);
    const gcsSuccess = await saveToGCS(validationData, {
      touchedLanguages,
      versionId: validationData.metadata.version_id
    });
    inMemoryValidationData = validationData; // always keep memory copy
    return res.status(200).json({
      success: true,
      message: `Validation results saved successfully (${gcsSuccess ? 'gcs' : 'memory'})`,
      source: gcsSuccess ? 'gcs' : 'memory',
      metadata: validationData.metadata,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    throw new Error(`Failed to save validation results: ${error.message}`);
  }
}

async function updateValidationResults(req, res) {
  try {
    const { item_id, language, validation_data } = req.body || {};
    if (!item_id || !language || !validation_data) {
      return res.status(400).json({ error: 'Missing required fields: item_id, language, validation_data' });
    }
    if (isExcludedValidationItemId(item_id)) {
      return res.status(400).json({ error: 'Excluded legacy item_id cannot be stored in validation results' });
    }

    let currentData = await loadFromGCS();
    if (!currentData) currentData = inMemoryValidationData;
    currentData.validation_results = sanitizeValidationResultsMap(currentData.validation_results || {});

    if (!currentData.validation_results[item_id]) currentData.validation_results[item_id] = {};
    currentData.validation_results[item_id][language] = {
      ...validation_data,
      updated: new Date().toISOString()
    };

    currentData.metadata.last_updated = new Date().toISOString();
    currentData.metadata.version = '2.0';
    currentData.metadata.storage_mode = 'by-language';
    currentData.metadata.version_id = buildVersionId();
    currentData.metadata.item_count = Object.keys(currentData.validation_results).length;
    let totalValidations = 0;
    Object.keys(currentData.validation_results).forEach(i => { totalValidations += Object.keys(currentData.validation_results[i] || {}).length; });
    currentData.metadata.validation_count = totalValidations;

    const gcsSuccess = await saveToGCS(currentData, {
      touchedLanguages: [language],
      versionId: currentData.metadata.version_id
    });
    inMemoryValidationData = currentData;
    return res.status(200).json({
      success: true,
      message: `Validation entry updated successfully (${gcsSuccess ? 'gcs' : 'memory'})`,
      source: gcsSuccess ? 'gcs' : 'memory',
      item_id,
      language,
      metadata: currentData.metadata,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    throw new Error(`Failed to update validation results: ${error.message}`);
  }
}