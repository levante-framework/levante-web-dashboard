#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');

const CROWDIN_API_BASE = 'https://api.crowdin.com/api/v2';
const DEFAULT_PROJECT_ID = '756721';

const LANG_ID_TO_CODE = {
  en: 'en',
  'en-us': 'en',
  'es-co': 'es-CO',
  es: 'es-CO',
  'es-ar': 'es-AR',
  de: 'de',
  'de-de': 'de',
  'de-ch': 'de-CH',
  'fr-ca': 'fr-CA',
  fr: 'fr-CA',
  nl: 'nl',
  'en-gh': 'en-GH',
  'pt-pt': 'pt-PT',
};

function parseArgs(argv) {
  const out = {
    zipFile: '',
    approvedOnly: true,
    outputAll: 'data/validation/crowdin-xliff-merged.csv',
    outputSurveys: 'data/validation/crowdin-xliff-surveys.csv',
    outputItembank: 'data/validation/crowdin-xliff-itembank.csv',
    outputDashboard: 'data/validation/crowdin-xliff-dashboard.csv',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--zip-file' && argv[i + 1]) out.zipFile = argv[++i];
    else if (a.startsWith('--zip-file=')) out.zipFile = a.split('=')[1];
    else if (a === '--approved-only') out.approvedOnly = true;
    else if (a === '--all' || a === '--include-unapproved') out.approvedOnly = false;
    else if (a === '--output-all' && argv[i + 1]) out.outputAll = argv[++i];
    else if (a.startsWith('--output-all=')) out.outputAll = a.split('=')[1];
    else if (a === '--output-surveys' && argv[i + 1]) out.outputSurveys = argv[++i];
    else if (a.startsWith('--output-surveys=')) out.outputSurveys = a.split('=')[1];
    else if (a === '--output-itembank' && argv[i + 1]) out.outputItembank = argv[++i];
    else if (a.startsWith('--output-itembank=')) out.outputItembank = a.split('=')[1];
    else if (a === '--output-dashboard' && argv[i + 1]) out.outputDashboard = argv[++i];
    else if (a.startsWith('--output-dashboard=')) out.outputDashboard = a.split('=')[1];
  }
  return out;
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
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
  return decodeEntities(String(text || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function getAttr(attrText, key) {
  const re = new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i');
  const m = String(attrText || '').match(re);
  return (m && m[1]) ? String(m[1]).trim() : '';
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

function langFromPath(p) {
  const first = normalizePath(p).split('/')[0] || '';
  const key = String(first).trim().toLowerCase();
  return LANG_ID_TO_CODE[key] || (key.includes('-') ? key : key || 'en');
}

function prettifyLabel(label) {
  return String(label || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(short|newkeys?)\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'General';
}

function deriveTaskAndTypeFromPath(p) {
  const compact = normalizePath(p).replace(/^[a-z]{2}(?:-[A-Za-z]{2,4})?\//i, '');
  if (compact.startsWith('main/dashboard/')) return { task: 'Dashboard', contentType: 'dashboard' };
  const itembankMatch = compact.match(/(?:^|\/)main\/itembank_by_task\/([^/]+)\.xli?ff$/i);
  if (itembankMatch) return { task: prettifyLabel(itembankMatch[1]), contentType: 'itembank' };
  const surveyMatch = compact.match(/(?:^|\/)main\/surveys\/([^/]+)\.xli?ff$/i);
  if (surveyMatch) return { task: `Survey: ${prettifyLabel(surveyMatch[1])}`, contentType: 'survey' };
  return { task: 'General', contentType: 'general' };
}

function parseCSVSimple(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((c === ',' && !inQuotes) || ((c === '\n' || c === '\r') && !inQuotes)) {
      row.push(field.trim());
      field = '';
      if (c === '\n' || c === '\r') {
        if (row.some((cell) => cell.length > 0)) rows.push(row);
        row = [];
        if (c === '\r' && next === '\n') i++;
      }
    } else {
      field += c;
    }
  }
  if (field.trim() || row.length > 0) {
    row.push(field.trim());
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  return rows;
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const values = rows[i] || [];
    const row = {};
    headers.forEach((h, j) => {
      row[h] = values[j] ?? '';
    });
    out.push(row);
  }
  return { headers, objects: out };
}

function normalizeLangCodeFromHeader(header) {
  const token = String(header || '').trim();
  if (!token) return '';
  const key = token.toLowerCase();
  return LANG_ID_TO_CODE[key] || token.replace(/_/g, '-');
}

function isLikelyLanguageHeader(header) {
  const token = normalizeLangCodeFromHeader(header);
  if (!token) return false;
  if (token.toLowerCase() === 'en') return true;
  return /^[a-z]{2}(?:-[A-Za-z0-9]{2,4})?$/i.test(token);
}

function getIdFromRow(row, headers) {
  const keys = headers && headers.length ? headers : Object.keys(row || {});
  const idKey = keys.find((h) => /identifier|item_id|item\s*id|^id$|^ID$/i.test(String(h || '').trim()));
  const key = idKey || keys[0];
  return String((row && row[key]) || '').trim();
}

function toCsvValue(v) {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath, rows, headers) {
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const lines = [headers.map(toCsvValue).join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((h) => toCsvValue(row[h] ?? '')).join(','));
  });
  fs.writeFileSync(abs, lines.join('\n'), 'utf8');
}

async function crowdinFetch(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${options.method || 'GET'} ${url} failed: ${res.status} ${body}`);
  }
  return res;
}

async function downloadCrowdinZipBuffer(approvedOnly) {
  const token = process.env.CROWDIN_API_TOKEN;
  if (!token) throw new Error('Missing CROWDIN_API_TOKEN environment variable');
  const projectId = process.env.LEVANTE_TRANSLATIONS_PROJECT_ID || DEFAULT_PROJECT_ID;

  const buildRes = await crowdinFetch(
    `${CROWDIN_API_BASE}/projects/${projectId}/translations/builds`,
    token,
    { method: 'POST', body: JSON.stringify({ exportApprovedOnly: approvedOnly }) }
  );
  const buildBody = await buildRes.json();
  const buildId = buildBody?.data?.id;
  if (!buildId) throw new Error('No build id returned by Crowdin');

  for (let i = 0; i < 60; i++) {
    const statusRes = await crowdinFetch(
      `${CROWDIN_API_BASE}/projects/${projectId}/translations/builds/${buildId}`,
      token
    );
    const statusBody = await statusRes.json();
    const status = statusBody?.data?.status;
    if (status === 'finished') break;
    if (status === 'failed' || status === 'cancelled') throw new Error(`Crowdin build ${status}`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  const dlRes = await crowdinFetch(
    `${CROWDIN_API_BASE}/projects/${projectId}/translations/builds/${buildId}/download`,
    token
  );
  const dlBody = await dlRes.json();
  const zipUrl = dlBody?.data?.url;
  if (!zipUrl) throw new Error('No Crowdin zip download URL returned');

  const zipRes = await fetch(zipUrl);
  if (!zipRes.ok) throw new Error(`ZIP download failed: HTTP ${zipRes.status}`);
  return Buffer.from(await zipRes.arrayBuffer());
}

async function main() {
  const args = parseArgs(process.argv);
  const zipBuffer = args.zipFile
    ? fs.readFileSync(path.resolve(args.zipFile))
    : await downloadCrowdinZipBuffer(args.approvedOnly);

  const unzipped = unzipSync(new Uint8Array(zipBuffer), {
    filter: (f) => {
      const n = normalizePath(f.name).toLowerCase();
      const isXliff = n.endsWith('.xlf') || n.endsWith('.xliff');
      const isCsv = n.endsWith('.csv');
      if (!isXliff && !isCsv) return false;
      if (!n.startsWith('main/') && !n.includes('/main/')) return false;
      if (n.includes('/main/itembank_by_task/') || n.includes('/main/surveys/')) return true;
      if (n.startsWith('main/dashboard/') && isCsv) return true;
      return n.includes('/main/dashboard/');
    },
  });

  const byId = new Map();
  const languageSet = new Set(['en']);
  let filesParsed = 0;

  Object.entries(unzipped).forEach(([filePath, bytes]) => {
    const normalized = normalizePath(filePath);
    if (normalized.toLowerCase().startsWith('main/dashboard/') && normalized.toLowerCase().endsWith('.csv')) {
      const text = Buffer.from(bytes).toString('utf8');
      const parsed = rowsToObjects(parseCSVSimple(text));
      const headers = parsed.headers || [];
      const objects = parsed.objects || [];
      const langHeaders = headers.filter((h) => {
        const key = String(h || '').trim();
        if (!key) return false;
        if (/identifier|item_id|item\s*id|^id$|^ID$/i.test(key)) return false;
        return isLikelyLanguageHeader(key);
      });
      objects.forEach((rowObj, idx) => {
        const rowId = getIdFromRow(rowObj, headers) || `_dashboard_${idx + 1}`;
        const stableId = `${normalized}::${rowId}`;
        if (!byId.has(stableId)) {
          byId.set(stableId, {
            identifier: stableId,
            item_id: stableId,
            labels: 'Dashboard',
            contentType: 'dashboard',
            _path: normalized,
            en: '',
          });
        }
        const row = byId.get(stableId);
        langHeaders.forEach((header) => {
          const langCode = normalizeLangCodeFromHeader(header);
          const val = stripTags(String(rowObj[header] || ''));
          if (!val) return;
          if (langCode && langCode.toLowerCase() !== 'en') languageSet.add(langCode);
          if (langCode.toLowerCase() === 'en') {
            if (!row.en) row.en = val;
          } else {
            row[langCode] = val;
          }
        });
      });
      filesParsed += 1;
      return;
    }
    const langCode = langFromPath(normalized);
    const canonicalPath = normalized.split('/').slice(1).join('/');
    const meta = deriveTaskAndTypeFromPath(normalized);
    const units = parseXliffUnits(Buffer.from(bytes).toString('utf8'));
    if (!units.length) return;
    filesParsed += 1;
    if (langCode) languageSet.add(langCode);

    units.forEach((u, idx) => {
      const localKey = String(u.resname || u.id || '').trim() || `idx-${idx + 1}`;
      const stableId = `${canonicalPath}::${localKey}`;
      if (!byId.has(stableId)) {
        byId.set(stableId, {
          identifier: stableId,
          item_id: stableId,
          labels: meta.task,
          contentType: meta.contentType,
          _path: normalized,
          en: '',
        });
      }
      const row = byId.get(stableId);
      if (u.source && !row.en) row.en = u.source;
      if (langCode && u.target) row[langCode] = u.target;
      if (!row._path) row._path = normalized;
      if (!row.labels || row.labels === 'General') row.labels = meta.task;
      if (!row.contentType || row.contentType === 'general') row.contentType = meta.contentType;
    });
  });

  const rows = Array.from(byId.values());
  const langColumns = Array.from(languageSet).filter((l) => l && l !== 'en').sort();
  const headers = ['identifier', 'item_id', 'labels', 'contentType', '_path', 'en', ...langColumns];

  const surveysRows = rows.filter((r) => String(r.contentType || '').toLowerCase() === 'survey');
  const itembankRows = rows.filter((r) => String(r.contentType || '').toLowerCase() === 'itembank');
  const dashboardRows = rows.filter((r) => String(r.contentType || '').toLowerCase() === 'dashboard');

  writeCsv(args.outputAll, rows, headers);
  writeCsv(args.outputSurveys, surveysRows, headers);
  writeCsv(args.outputItembank, itembankRows, headers);
  writeCsv(args.outputDashboard, dashboardRows, headers);

  console.log(`Parsed XLIFF files: ${filesParsed}`);
  console.log(`Languages found: ${langColumns.join(', ') || '(none)'}`);
  console.log(`Merged rows (all): ${rows.length}`);
  console.log(`Survey rows: ${surveysRows.length}`);
  console.log(`Itembank rows: ${itembankRows.length}`);
  console.log(`Dashboard rows: ${dashboardRows.length}`);
  console.log(`Wrote: ${path.resolve(args.outputAll)}`);
  console.log(`Wrote: ${path.resolve(args.outputSurveys)}`);
  console.log(`Wrote: ${path.resolve(args.outputItembank)}`);
  console.log(`Wrote: ${path.resolve(args.outputDashboard)}`);
}

main().catch((err) => {
  console.error('Failed to export Crowdin XLIFF merged CSV:', err?.message || err);
  process.exit(1);
});

