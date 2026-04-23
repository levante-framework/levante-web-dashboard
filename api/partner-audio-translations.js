import { Storage } from '@google-cloud/storage';

const DEFAULT_DRAFT_BUCKET = process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';

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

function extractTaskFromPath(pathValue) {
  const normalized = normalizePath(pathValue);
  const m = normalized.match(/(?:^|\/)itembank_by_task\/([^/]+)\.xli?ff$/i);
  if (!m) return '';
  return String(m[1] || '').trim();
}

function extractLangFromPath(pathValue, xliffText) {
  const normalized = normalizePath(pathValue);
  const matchFromPath = normalized.match(/(?:^|\/)([a-z]{2}(?:-[A-Za-z0-9]{2,8})?)\/main\/itembank_by_task\//i);
  if (matchFromPath && matchFromPath[1]) {
    return normalizeLangCode(matchFromPath[1]);
  }
  const headerMatch = String(xliffText || '').match(/\b(?:target-language|trgLang)\s*=\s*"([^"]+)"/i);
  if (headerMatch && headerMatch[1]) {
    return normalizeLangCode(headerMatch[1]);
  }
  return '';
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

  for (let i = 0; i < xliffFiles.length; i++) {
    const file = xliffFiles[i];
    const pathValue = normalizePath(file?.name);
    if (!pathValue) continue;
    const task = extractTaskFromPath(pathValue);
    const [buf] = await file.download();
    const text = buf.toString('utf8');
    const langCode = extractLangFromPath(pathValue, text);
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
    rowCount: rows.length,
    fileCount: xliffFiles.length,
  };
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
      // Default source: item bank CSV published in the draft audio bucket.
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

      // Optional fallback source for legacy environments that still rely on XLIFF blobs.
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
    }

    // Public fallback for environments without configured GCS credentials.
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

    return res.status(404).json({
      ok: false,
      error: 'translations_not_found',
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
