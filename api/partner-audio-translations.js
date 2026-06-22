import { Storage } from '@google-cloud/storage';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildLanguageBundle,
  normalizeLangCode as normalizeRequestedLangCode,
} from './lib/partner-audio-translations-bundle.js';
import {
  canonicalizeItembankLangCode,
  isAudioCapableLangCode,
  loadLanguageConfigLanguages,
} from './lib/partner-audio-language-config.js';
import { getStorageClientFromEnv } from './lib/gcp-credentials.js';

function sanitizeEnvString(value) {
  return String(value ?? '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\\n$/g, '')
    .replace(/\n+$/g, '');
}

function sanitizeBucketName(value, fallback) {
  const cleaned = sanitizeEnvString(value)
    .replace(/\\[nrt]/g, '')
    .replace(/\s+/g, '');
  return cleaned || fallback;
}

function sanitizeObjectPath(value, fallback) {
  const cleaned = sanitizeEnvString(value).replace(/\\[nr]/g, '').replace(/^\/+/, '');
  return cleaned || fallback;
}

const DEFAULT_DRAFT_BUCKET = sanitizeBucketName(process.env.ASSETS_DRAFT_BUCKET, 'levante-assets-draft');
const SOURCE_MODE = String(process.env.PARTNER_AUDIO_TRANSLATIONS_SOURCE_MODE || 'task-json').trim().toLowerCase();
const OBJECT_PATH = sanitizeObjectPath(process.env.PARTNER_AUDIO_TRANSLATIONS_OBJECT_PATH, 'audio/item_bank_translations.csv');
const ENABLE_XLIFF_SOURCE = String(
  process.env.PARTNER_AUDIO_TRANSLATIONS_ENABLE_XLIFF_SOURCE || ''
).trim().toLowerCase() === 'true';
const CACHE_TTL_MS = Math.max(10_000, Number(process.env.PARTNER_AUDIO_TRANSLATIONS_CACHE_TTL_MS || 120_000));
const MAX_SCAN_FILES = Math.max(1000, Number(process.env.PARTNER_AUDIO_TRANSLATIONS_MAX_SCAN_FILES || 25000));

const LANG_ID_TO_CODE = {
  en: 'en-US',
  'en-us': 'en-US',
  'en-gb': 'en-GB',
  'en-gh': 'en-GH',
  'es-co': 'es-CO',
  es: 'es-CO',
  'es-ar': 'es-AR',
  de: 'de-DE',
  'de-de': 'de-DE',
  'de-ch': 'de-CH',
  'fr-ca': 'fr-CA',
  fr: 'fr-CA',
  nl: 'nl-NL',
  pt: 'pt-PT',
  'pt-pt': 'pt-PT',
  'pt-br': 'pt-BR',
};

let memoryCache = {
  expiresAt: 0,
  csvText: '',
  source: '',
};
const langBundleCache = new Map();
let taskIndexCache = null;
let taskOverrideCache = null;

function getStorageClient() {
  return getStorageClientFromEnv(Storage);
}

async function readFromGcs(storage, bucketName, objectPath) {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(objectPath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  const csvText = contents.toString('utf8');
  if (!String(csvText || '').trim()) return null;
  return csvText;
}

async function readFromPublicUrl(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    const csvText = await response.text();
    if (!String(csvText || '').trim()) return null;
    return csvText;
  } catch (_) {
    return null;
  }
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').trim();
}

function hasItembankSegment(pathValue) {
  const normalized = normalizePath(pathValue).toLowerCase();
  return normalized.includes('/itembank/');
}

function looksLikeLangSegment(segment) {
  return /^[a-z]{2}(?:[-_][a-z0-9]{2,8})?$/i.test(String(segment || '').trim());
}

function normalizeLangCode(value) {
  const code = String(value || '').trim().replace(/_/g, '-');
  if (!code) return '';
  const lower = code.toLowerCase();
  return LANG_ID_TO_CODE[lower] || code;
}

function toCsvValue(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsv(headers, rows) {
  const lines = [headers.map(toCsvValue).join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((h) => toCsvValue(row[h] || '')).join(','));
  });
  return `${lines.join('\n')}\n`;
}

async function listAllFiles(bucket) {
  const out = [];
  let pageToken = undefined;
  do {
    const [files, nextQuery] = await bucket.getFiles({
      autoPaginate: false,
      pageToken,
      maxResults: 1000,
    });
    out.push(...files);
    if (out.length >= MAX_SCAN_FILES) break;
    pageToken = nextQuery && nextQuery.pageToken ? nextQuery.pageToken : undefined;
  } while (pageToken);
  return out;
}

function extractTaskFromJsonPath(pathValue) {
  const normalized = normalizePath(pathValue);
  const segments = normalized.split('/').filter(Boolean);
  const itembankIdx = segments.findIndex((segment) => String(segment || '').toLowerCase() === 'itembank');
  if (itembankIdx >= 0) {
    const afterItembank = String(segments[itembankIdx + 1] || '').trim();
    const secondAfterItembank = String(segments[itembankIdx + 2] || '').trim();

    // Common layout: .../itembank/<task>/<lang>/item-bank-translations.json
    if (afterItembank && !looksLikeLangSegment(afterItembank) && !/\.json$/i.test(afterItembank)) {
      return afterItembank;
    }

    // Alternative layout: .../itembank/<lang>/<task>.json
    if (looksLikeLangSegment(afterItembank) && secondAfterItembank && !/\.json$/i.test(secondAfterItembank)) {
      return secondAfterItembank;
    }
  }

  const basenameMatch = normalized.match(/([^/]+)\.json$/i);
  return basenameMatch && basenameMatch[1] ? String(basenameMatch[1]).trim() : '';
}

function extractLangFromJsonPath(pathValue) {
  const normalized = normalizePath(pathValue);
  const segments = normalized.split('/').filter(Boolean);
  const itembankIdx = segments.findIndex((segment) => String(segment || '').toLowerCase() === 'itembank');
  if (itembankIdx <= 0) return '';

  // Support both .../<lang>/itembank/... and .../itembank/<lang>/... layouts.
  const probeOrder = [];
  for (let distance = 1; distance < segments.length; distance += 1) {
    const before = itembankIdx - distance;
    const after = itembankIdx + distance;
    if (before >= 0) probeOrder.push(before);
    if (after < segments.length) probeOrder.push(after);
  }
  for (const idx of probeOrder) {
    const segment = String(segments[idx] || '').trim();
    if (looksLikeLangSegment(segment)) {
      return normalizeLangCode(segment);
    }
  }
  return '';
}

function normalizeItemId(rawKey) {
  const raw = String(rawKey || '').trim();
  if (!raw) return '';
  if (raw.includes('::')) {
    const suffix = raw.split('::').pop();
    return String(suffix || raw).trim();
  }
  return raw;
}

function normalizeTaskName(rawTask) {
  return String(rawTask || '').trim();
}

function normalizeLookupId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function getExistingTaskIndex() {
  if (taskIndexCache) return taskIndexCache;
  const taskIndex = new Map();
  try {
    const jsonPath = path.join(process.cwd(), 'public', 'data', 'existing-tasks.json');
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    tasks.forEach((taskEntry) => {
      const taskName = normalizeTaskName(taskEntry?.taskName || taskEntry?.registryKey || '');
      if (!taskName) return;
      const candidates = [
        ...(Array.isArray(taskEntry?.requiredAudioIds) ? taskEntry.requiredAudioIds : []),
        ...(Array.isArray(taskEntry?.translationKeys) ? taskEntry.translationKeys : []),
      ];
      candidates.forEach((rawId) => {
        const id = normalizeLookupId(rawId);
        if (id) taskIndex.set(id, taskName);
      });
    });
  } catch (_) {
    // Optional enrichment source; ignore parse/read failures.
  }
  taskIndexCache = taskIndex;
  return taskIndexCache;
}

function getTaskOverrideRules() {
  if (taskOverrideCache) return taskOverrideCache;
  const parsed = { exact: new Map(), prefix: [] };
  try {
    const overridesPath = path.join(process.cwd(), 'public', 'data', 'item-task-overrides.json');
    const raw = JSON.parse(readFileSync(overridesPath, 'utf8'));
    const exactEntries = raw?.exact && typeof raw.exact === 'object' ? Object.entries(raw.exact) : [];
    exactEntries.forEach(([id, task]) => {
      const key = normalizeLookupId(id);
      const taskName = normalizeTaskName(task);
      if (key && taskName) parsed.exact.set(key, taskName);
    });

    const prefixEntries = raw?.prefix && typeof raw.prefix === 'object' ? Object.entries(raw.prefix) : [];
    parsed.prefix = prefixEntries
      .map(([prefix, task]) => ({ prefix: normalizeLookupId(prefix), task: normalizeTaskName(task) }))
      .filter((entry) => entry.prefix && entry.task)
      .sort((a, b) => b.prefix.length - a.prefix.length);
  } catch (_) {
    // Optional enrichment source; ignore parse/read failures.
  }
  taskOverrideCache = parsed;
  return taskOverrideCache;
}

function inferTaskFromItemId(itemId) {
  const normalizedId = normalizeLookupId(itemId);
  if (!normalizedId) return '';
  const rules = getTaskOverrideRules();
  if (rules.exact.has(normalizedId)) {
    return rules.exact.get(normalizedId);
  }
  for (const rule of rules.prefix) {
    if (normalizedId.startsWith(rule.prefix)) {
      return rule.task;
    }
  }
  // Final lightweight fallback: simple noun-like keys are usually vocabulary items.
  if (/^[a-z]+(?:fem|plural)?$/.test(normalizedId)) {
    return 'vocab';
  }
  return '';
}

function inferTaskFromPrefix(prefix) {
  const raw = String(prefix || '').trim();
  if (!raw) return '';
  const segments = raw.split('.').map((seg) => String(seg || '').trim()).filter(Boolean);
  if (!segments.length) return '';
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (/^\d+$/.test(segment)) continue;
    if (['translations', 'itembank', 'items', 'data', 'records'].includes(segment.toLowerCase())) continue;
    return normalizeTaskName(segment);
  }
  return '';
}

const PLACEHOLDER_TRANSLATIONS = new Set([
  'no approved translation',
]);

function isPlaceholderText(value) {
  const t = String(value ?? '').trim().toLowerCase();
  return !t || PLACEHOLDER_TRANSLATIONS.has(t);
}

function isRealText(value) {
  return !isPlaceholderText(value);
}

// Merge a translation into a row without ever letting a placeholder
// ("NO APPROVED TRANSLATION") or empty string overwrite a real translation.
// This makes the JSON scan order-independent when duplicate itembank folders
// exist (e.g. translations/itembank/memory-game/... vs .../memory/...).
function assignTranslation(row, key, value) {
  const next = String(value ?? '');
  if (!next) return;
  const current = row[key];
  if (isRealText(next) || !isRealText(current)) {
    row[key] = next;
  }
}

function getRecordText(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return '';
  const candidates = [
    record.translation,
    record.target,
    record.text,
    record.value,
    record.message,
    record.content,
  ];
  const found = candidates.find((v) => typeof v === 'string' && String(v).trim());
  return String(found || '').trim();
}

function getRecordTask(record, fallbackTask = '', itemId = '') {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return normalizeTaskName(fallbackTask);
  const normalizedItemId = String(itemId || '').trim().toLowerCase();
  const candidates = [
    record.task,
    record.labels,
    record.taskName,
    record.task_name,
  ];
  const found = candidates.find((v) => {
    if (typeof v !== 'string') return false;
    const value = String(v || '').trim();
    if (!value) return false;
    if (normalizedItemId && value.toLowerCase() === normalizedItemId) return false;
    return true;
  });
  return normalizeTaskName(found || fallbackTask || '');
}

function collectJsonTranslationEntries(node, prefix = '') {
  const out = [];
  const contextualTask = inferTaskFromPrefix(prefix);
  if (typeof node === 'string') {
    if (prefix) out.push({ itemId: normalizeItemId(prefix), text: node.trim(), task: contextualTask });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((entry, idx) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const itemId = normalizeItemId(entry.item_id || entry.itemId || entry.id || '');
        const text = getRecordText(entry);
        if (itemId && text) {
          out.push({ itemId, text, task: getRecordTask(entry, contextualTask, itemId) });
          return;
        }
      }
      const childPrefix = prefix ? `${prefix}.${idx}` : String(idx);
      out.push(...collectJsonTranslationEntries(entry, childPrefix));
    });
    return out;
  }
  if (node && typeof node === 'object') {
    Object.entries(node).forEach(([key, value]) => {
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      out.push(...collectJsonTranslationEntries(value, childPrefix));
    });
  }
  return out;
}

async function buildFromDraftTaskJson(storage, bucketName) {
  const bucket = storage.bucket(bucketName);
  const allFiles = await listAllFiles(bucket);
  const jsonFiles = allFiles.filter((f) => {
    const p = normalizePath(f?.name).toLowerCase();
    if (!p.endsWith('.json')) return false;
    return hasItembankSegment(p);
  });
  if (!jsonFiles.length) return null;

  const byId = new Map();
  const languages = new Set(['en-US']);
  let parsedFiles = 0;

  for (const file of jsonFiles) {
    const pathValue = normalizePath(file?.name);
    if (!pathValue) continue;
    const task = extractTaskFromJsonPath(pathValue);
    const langCode = extractLangFromJsonPath(pathValue);
    if (!task || !langCode) continue;

    let parsed;
    try {
      const [buf] = await file.download();
      parsed = JSON.parse(buf.toString('utf8'));
    } catch (_) {
      continue;
    }

    const entries = collectJsonTranslationEntries(parsed);
    if (!entries.length) continue;
    parsedFiles += 1;
    languages.add(langCode);

    const existingTaskIndex = getExistingTaskIndex();
    entries.forEach(({ itemId, text, task: entryTaskRaw }) => {
      if (!itemId || !text) return;
      const normalizedItemId = normalizeLookupId(itemId);
      let entryTask = normalizeTaskName(entryTaskRaw || '');
      if (entryTask && normalizeLookupId(entryTask) === normalizedItemId) {
        entryTask = '';
      }
      const fileTask = normalizeTaskName(task || '');
      const mappedTask = existingTaskIndex.get(normalizedItemId) || '';
      const overrideTask = inferTaskFromItemId(itemId);
      // Task folder is the source of truth for task attribution.
      // Key-based mapping is only a fallback for legacy/unscoped sources.
      const finalTask = normalizeTaskName(fileTask || entryTask || mappedTask || overrideTask);
      if (!byId.has(itemId)) {
        byId.set(itemId, {
          item_id: itemId,
          task: finalTask,
          'en-US': '',
        });
      }
      const row = byId.get(itemId);
      if (!row.task) row.task = finalTask;
      assignTranslation(row, langCode === 'en-US' ? 'en-US' : langCode, text);
    });
  }

  const rows = Array.from(byId.values());
  if (!rows.length) return null;
  rows.sort((a, b) => String(a.item_id || '').localeCompare(String(b.item_id || '')));
  const langHeaders = Array.from(languages).filter((l) => l && l !== 'en-US').sort();
  const headers = ['item_id', 'task', 'en-US', ...langHeaders];

  return {
    csvText: buildCsv(headers, rows),
    source: `gcs://${bucketName}/**/itembank/**/*.json`,
    rowCount: rows.length,
    fileCount: parsedFiles,
  };
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripTags(text) {
  return decodeEntities(String(text || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function getAttr(attrText, key) {
  const re = new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i');
  const m = String(attrText || '').match(re);
  return m && m[1] ? String(m[1]).trim() : '';
}

function extractTagText(block, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = String(block || '').match(re);
  return m ? stripTags(m[1]) : '';
}

function parseXliffUnits(xliffText) {
  const units = [];
  const text = String(xliffText || '');

  const transUnitRe = /<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi;
  let m;
  while ((m = transUnitRe.exec(text)) !== null) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    units.push({
      id: getAttr(attrs, 'id'),
      resname: getAttr(attrs, 'resname') || getAttr(attrs, 'name'),
      source: extractTagText(body, 'source'),
      target: extractTagText(body, 'target'),
    });
  }
  if (units.length) return units;

  const unitRe = /<unit\b([^>]*)>([\s\S]*?)<\/unit>/gi;
  while ((m = unitRe.exec(text)) !== null) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    const segmentMatch = body.match(/<segment\b[^>]*>([\s\S]*?)<\/segment>/i);
    const scope = segmentMatch ? segmentMatch[1] : body;
    units.push({
      id: getAttr(attrs, 'id'),
      resname: getAttr(attrs, 'resname') || getAttr(attrs, 'name'),
      source: extractTagText(scope, 'source'),
      target: extractTagText(scope, 'target'),
    });
  }
  return units;
}

function extractTaskFromXliffPath(pathValue) {
  const normalized = normalizePath(pathValue);
  const m = normalized.match(/(?:^|\/)itembank_by_task\/([^/]+)\.xli?ff$/i);
  if (!m) return '';
  return String(m[1] || '').trim();
}

function extractLangFromXliffPath(pathValue, xliffText) {
  const normalized = normalizePath(pathValue);
  const matchFromPath = normalized.match(/(?:^|\/)([a-z]{2}(?:-[A-Za-z0-9]{2,8})?)\/main\/itembank_by_task\//i);
  if (matchFromPath && matchFromPath[1]) return normalizeLangCode(matchFromPath[1]);
  const headerMatch = String(xliffText || '').match(/\b(?:target-language|trgLang)\s*=\s*"([^"]+)"/i);
  return headerMatch && headerMatch[1] ? normalizeLangCode(headerMatch[1]) : '';
}

async function buildFromDraftItembankFolders(storage, bucketName) {
  const bucket = storage.bucket(bucketName);
  const allFiles = await listAllFiles(bucket);
  const xliffFiles = allFiles.filter((f) => {
    const p = normalizePath(f?.name);
    if (!p) return false;
    if (!(p.toLowerCase().endsWith('.xlf') || p.toLowerCase().endsWith('.xliff'))) return false;
    return /(?:^|\/)main\/itembank_by_task\/[^/]+\.xli?ff$/i.test(p);
  });
  if (!xliffFiles.length) return null;

  const byId = new Map();
  const languages = new Set(['en-US']);

  for (const file of xliffFiles) {
    const pathValue = normalizePath(file?.name);
    if (!pathValue) continue;
    const task = extractTaskFromXliffPath(pathValue);
    const [buf] = await file.download();
    const text = buf.toString('utf8');
    const langCode = extractLangFromXliffPath(pathValue, text);
    if (langCode) languages.add(langCode);
    const units = parseXliffUnits(text);
    if (!units.length) continue;

    units.forEach((unit, idx) => {
      const itemId = String(unit?.resname || unit?.id || '').trim() || `idx-${idx + 1}`;
      if (!byId.has(itemId)) {
        byId.set(itemId, {
          item_id: itemId,
          task,
          'en-US': '',
        });
      }
      const row = byId.get(itemId);
      if (task && !row.task) row.task = task;
      if (unit?.source) assignTranslation(row, 'en-US', String(unit.source || '').trim());
      if (langCode && unit?.target) assignTranslation(row, langCode, String(unit.target || '').trim());
    });
  }

  const rows = Array.from(byId.values());
  if (!rows.length) return null;
  rows.sort((a, b) => String(a.item_id || '').localeCompare(String(b.item_id || '')));
  const langHeaders = Array.from(languages).filter((l) => l && l !== 'en-US').sort();
  const headers = ['item_id', 'task', 'en-US', ...langHeaders];
  return {
    csvText: buildCsv(headers, rows),
    source: `gcs://${bucketName}/**/main/itembank_by_task/*.xlf*`,
  };
}

function sourceModeLabel() {
  if (SOURCE_MODE === 'csv') return 'csv';
  if (SOURCE_MODE === 'xliff') return 'xliff';
  return 'task-json';
}

function getCachedLangBundle(lang) {
  const entry = langBundleCache.get(lang);
  if (!entry || Date.now() >= entry.expiresAt) return null;
  return entry.payload;
}

function setCachedLangBundle(lang, payload) {
  langBundleCache.set(lang, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    payload,
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  try {
    const query = req.query || {};
    const requestedLang = canonicalizeItembankLangCode(normalizeRequestedLangCode(query.lang || ''));

    if (requestedLang) {
      const cached = getCachedLangBundle(requestedLang);
      if (cached) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(cached);
      }
      const storage = getStorageClient();
      if (!storage) {
        return res.status(500).json({ ok: false, error: 'gcs_unavailable' });
      }
      const languages = await loadLanguageConfigLanguages(storage);
      if (!isAudioCapableLangCode(languages, requestedLang)) {
        return res.status(400).json({
          ok: false,
          error: 'lang_not_audio_capable',
          lang: normalizeRequestedLangCode(requestedLang),
        });
      }
      try {
        const payload = await buildLanguageBundle(storage, DEFAULT_DRAFT_BUCKET, requestedLang);
        setCachedLangBundle(requestedLang, payload);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(payload);
      } catch (error) {
        if (String(error?.message || '') === 'missing_lang') {
          return res.status(400).json({ ok: false, error: 'missing_lang' });
        }
        throw error;
      }
    }

    if (Date.now() < memoryCache.expiresAt && memoryCache.csvText) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(memoryCache.csvText);
    }

    const storage = getStorageClient();
    const tried = [];

    if (storage) {
      if (SOURCE_MODE === 'csv') {
        tried.push(`gcs://${DEFAULT_DRAFT_BUCKET}/${OBJECT_PATH}`);
        const csvText = await readFromGcs(storage, DEFAULT_DRAFT_BUCKET, OBJECT_PATH);
        if (csvText) {
          memoryCache = {
            expiresAt: Date.now() + CACHE_TTL_MS,
            csvText,
            source: `gcs://${DEFAULT_DRAFT_BUCKET}/${OBJECT_PATH}`,
          };
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          return res.status(200).send(csvText);
        }

        if (ENABLE_XLIFF_SOURCE) {
          tried.push(`gcs://${DEFAULT_DRAFT_BUCKET}/**/main/itembank_by_task/*.xlf*`);
          const draftFolderResult = await buildFromDraftItembankFolders(storage, DEFAULT_DRAFT_BUCKET);
          if (draftFolderResult?.csvText) {
            memoryCache = {
              expiresAt: Date.now() + CACHE_TTL_MS,
              csvText: draftFolderResult.csvText,
              source: draftFolderResult.source,
            };
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).send(draftFolderResult.csvText);
          }
        }
      } else if (SOURCE_MODE === 'xliff') {
        tried.push(`gcs://${DEFAULT_DRAFT_BUCKET}/**/main/itembank_by_task/*.xlf*`);
        const draftFolderResult = await buildFromDraftItembankFolders(storage, DEFAULT_DRAFT_BUCKET);
        if (draftFolderResult?.csvText) {
          memoryCache = {
            expiresAt: Date.now() + CACHE_TTL_MS,
            csvText: draftFolderResult.csvText,
            source: draftFolderResult.source,
          };
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          return res.status(200).send(draftFolderResult.csvText);
        }
      } else {
        tried.push(`gcs://${DEFAULT_DRAFT_BUCKET}/**/itembank/**/*.json`);
        const taskJsonResult = await buildFromDraftTaskJson(storage, DEFAULT_DRAFT_BUCKET);
        if (taskJsonResult?.csvText) {
          memoryCache = {
            expiresAt: Date.now() + CACHE_TTL_MS,
            csvText: taskJsonResult.csvText,
            source: taskJsonResult.source,
          };
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          return res.status(200).send(taskJsonResult.csvText);
        }
      }
    }

    if (SOURCE_MODE === 'csv') {
      const publicUrls = [
        `https://storage.googleapis.com/${DEFAULT_DRAFT_BUCKET}/${OBJECT_PATH}`
      ];
      for (const url of publicUrls) {
        tried.push(url);
        const csvText = await readFromPublicUrl(url);
        if (!csvText) continue;
        memoryCache = {
          expiresAt: Date.now() + CACHE_TTL_MS,
          csvText,
          source: url,
        };
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(csvText);
      }
    }

    return res.status(404).json({
      ok: false,
      error: 'translations_not_found',
      sourceMode: sourceModeLabel(),
      tried
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'internal_error',
      message: error?.message || String(error)
    });
  }
}
