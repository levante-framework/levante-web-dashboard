import { Storage } from '@google-cloud/storage';

const DEFAULT_DRAFT_BUCKET = process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';
const SOURCE_MODE = String(process.env.PARTNER_AUDIO_TRANSLATIONS_SOURCE_MODE || 'task-json').trim().toLowerCase();
const OBJECT_PATH = process.env.PARTNER_AUDIO_TRANSLATIONS_OBJECT_PATH || 'audio/item_bank_translations.csv';
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
  nl: 'nl',
  pt: 'pt-PT',
  'pt-pt': 'pt-PT',
  'pt-br': 'pt-BR',
};

let memoryCache = {
  expiresAt: 0,
  csvText: '',
  source: '',
};

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) return null;
  try {
    const credentials = JSON.parse(raw);
    return new Storage({ credentials, projectId: credentials.project_id });
  } catch (_) {
    return null;
  }
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
  const m = normalized.match(/(?:^|\/)itembank_by_task\/([^/]+)\.json$/i);
  return m && m[1] ? String(m[1]).trim() : '';
}

function extractLangFromJsonPath(pathValue) {
  const normalized = normalizePath(pathValue);
  const segments = normalized.split('/').filter(Boolean);
  const taskIdx = segments.findIndex((segment) => segment.toLowerCase() === 'itembank_by_task');
  if (taskIdx <= 0) return '';
  for (let i = taskIdx - 1; i >= 0; i -= 1) {
    const segment = String(segments[i] || '').trim();
    if (/^[a-z]{2}(?:[-_][a-z0-9]{2,8})?$/i.test(segment)) {
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

function collectJsonTranslationEntries(node, prefix = '') {
  const out = [];
  if (typeof node === 'string') {
    if (prefix) out.push({ itemId: normalizeItemId(prefix), text: node.trim() });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((entry, idx) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const itemId = normalizeItemId(entry.item_id || entry.itemId || entry.id || '');
        const text = getRecordText(entry);
        if (itemId && text) {
          out.push({ itemId, text });
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
    return p.includes('/itembank_by_task/');
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

    entries.forEach(({ itemId, text }) => {
      if (!itemId || !text) return;
      if (!byId.has(itemId)) {
        byId.set(itemId, {
          item_id: itemId,
          task,
          'en-US': '',
        });
      }
      const row = byId.get(itemId);
      if (!row.task) row.task = task;
      if (langCode === 'en-US') {
        row['en-US'] = text;
      } else {
        row[langCode] = text;
      }
    });
  }

  const rows = Array.from(byId.values());
  if (!rows.length) return null;
  rows.sort((a, b) => String(a.item_id || '').localeCompare(String(b.item_id || '')));
  const langHeaders = Array.from(languages).filter((l) => l && l !== 'en-US').sort();
  const headers = ['item_id', 'task', 'en-US', ...langHeaders];

  return {
    csvText: buildCsv(headers, rows),
    source: `gcs://${bucketName}/**/itembank_by_task/*.json`,
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
      if (unit?.source && !row['en-US']) row['en-US'] = String(unit.source || '').trim();
      if (langCode && unit?.target) row[langCode] = String(unit.target || '').trim();
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  try {
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
        tried.push(`gcs://${DEFAULT_DRAFT_BUCKET}/**/itembank_by_task/*.json`);
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
