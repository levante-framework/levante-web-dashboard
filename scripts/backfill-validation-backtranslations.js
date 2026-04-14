#!/usr/bin/env node

/**
 * Backfill missing backTranslation fields for scored validation entries.
 *
 * Default target languages: pt-BR,de
 * Data source for translated/original text fallback: data/validation/crowdin-xliff-merged.csv
 *
 * Example:
 *   node scripts/backfill-validation-backtranslations.js \
 *     --base-url https://levante-web-dashboard-fgnq5ueve-digitalpros-projects.vercel.app \
 *     --langs pt-BR,de
 */

const fs = require('fs');
const path = require('path');

function getArg(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeLangCode(code) {
  return String(code || '').trim().replace(/_/g, '-');
}

function makeLangAliases(lang) {
  const normalized = normalizeLangCode(lang);
  const lower = normalized.toLowerCase();
  const out = new Set([normalized, lower, normalized.replace(/-/g, '_'), lower.replace(/-/g, '_')]);
  const base = normalized.split('-')[0];
  if (base) out.add(base);
  if (lower === 'pt-br' || lower === 'pt-pt' || lower === 'pt') {
    ['pt', 'pt-BR', 'pt-br', 'pt-PT', 'pt-pt'].forEach((v) => out.add(v));
  }
  if (lower === 'de' || lower === 'de-de') {
    ['de', 'de-DE', 'de-de'].forEach((v) => out.add(v));
  }
  return Array.from(out);
}

function parseCSVWithEmbeddedNewlines(csvText) {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < csvText.length) {
    const char = csvText[i];
    const nextChar = i + 1 < csvText.length ? csvText[i + 1] : null;

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i += 2;
      } else {
        inQuotes = !inQuotes;
        i += 1;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      currentRow.push(currentField);
      currentField = '';
      i += 1;
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') i += 1;
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
      i += 1;
      continue;
    }

    currentField += char;
    i += 1;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

function parseCsvToRows(csvText) {
  const rows = parseCSVWithEmbeddedNewlines(csvText);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const values = rows[i];
    if (!values || values.length === 0) continue;
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = String(values[idx] || '').trim();
    });
    out.push(row);
  }
  return out;
}

function buildTranslationIndex(rows) {
  const byExactId = new Map();
  const bySuffix = new Map();

  rows.forEach((row) => {
    const id = String(
      row.item_id || row.identifier || row.id || row.ID || row.Item_ID || ''
    ).trim();
    if (!id) return;
    byExactId.set(id, row);
    byExactId.set(id.toLowerCase(), row);
    if (id.includes('::')) {
      const suffix = String(id.split('::').pop() || '').trim();
      if (suffix) {
        bySuffix.set(suffix, row);
        bySuffix.set(suffix.toLowerCase(), row);
      }
    }
  });

  return { byExactId, bySuffix };
}

function lookupRowForItemId(index, itemId) {
  const raw = String(itemId || '').trim();
  if (!raw) return null;
  const exact = index.byExactId.get(raw) || index.byExactId.get(raw.toLowerCase());
  if (exact) return exact;
  if (raw.includes('::')) {
    const suffix = String(raw.split('::').pop() || '').trim();
    if (!suffix) return null;
    return index.bySuffix.get(suffix) || index.bySuffix.get(suffix.toLowerCase()) || null;
  }
  return index.bySuffix.get(raw) || index.bySuffix.get(raw.toLowerCase()) || null;
}

function getTextForLanguage(row, langCode) {
  if (!row) return '';
  const aliases = makeLangAliases(langCode);
  for (let i = 0; i < aliases.length; i += 1) {
    const key = aliases[i];
    const direct = row[key];
    if (direct && String(direct).trim()) return String(direct).trim();
  }
  const keys = Object.keys(row);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const normalized = key.replace(/_/g, '-').toLowerCase();
    for (let j = 0; j < aliases.length; j += 1) {
      const a = String(aliases[j]).replace(/_/g, '-').toLowerCase();
      if (normalized === a && row[key] && String(row[key]).trim()) {
        return String(row[key]).trim();
      }
    }
  }
  return '';
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`Non-JSON response (${res.status}) from ${url}: ${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    const errMsg = body?.error || body?.details || text || `${res.status}`;
    throw new Error(`HTTP ${res.status} from ${url}: ${errMsg}`);
  }
  return body;
}

async function withConcurrency(items, concurrency, worker) {
  const queue = Array.from(items);
  const out = [];
  const runners = Array.from({ length: Math.max(1, concurrency) }).map(async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const next = queue.shift();
      if (!next) return;
      const result = await worker(next);
      out.push(result);
    }
  });
  await Promise.all(runners);
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const baseUrlRaw = getArg('base-url', process.env.BACKFILL_BASE_URL || '').trim();
  if (!baseUrlRaw) {
    throw new Error('Missing --base-url (e.g. https://...vercel.app)');
  }
  const baseUrl = baseUrlRaw.replace(/\/+$/, '');
  const langs = String(getArg('langs', 'pt-BR,de'))
    .split(',')
    .map((v) => normalizeLangCode(v))
    .filter(Boolean);
  const concurrency = Number(getArg('concurrency', '4'));
  const saveBatchSize = Number(getArg('save-batch', '80'));
  const maxItems = Number(getArg('max', '0'));
  const provider = String(getArg('provider', 'google')).trim().toLowerCase();
  const dryRun = hasFlag('dry-run');
  const csvPath = getArg(
    'csv',
    path.join(process.cwd(), 'data', 'validation', 'crowdin-xliff-merged.csv')
  );

  console.log('--- Backfill validation back-translations ---');
  console.log('Base URL:', baseUrl);
  console.log('Languages:', langs.join(', '));
  console.log('Provider:', provider);
  console.log('Concurrency:', concurrency);
  console.log('Save batch size:', saveBatchSize);
  console.log('Max items:', maxItems || '(all)');
  console.log('Dry run:', dryRun ? 'yes' : 'no');
  console.log('CSV:', csvPath);

  const csvText = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsvToRows(csvText);
  const index = buildTranslationIndex(rows);
  console.log(`Loaded translation rows: ${rows.length}`);

  const allPayload = await fetchJson(`${baseUrl}/api/validation-storage`, { cache: 'no-store' });
  const allResults = allPayload?.data?.validation_results || {};

  const candidates = [];
  Object.entries(allResults).forEach(([itemId, byLang]) => {
    if (!byLang || typeof byLang !== 'object') return;
    langs.forEach((lang) => {
      const entry = byLang[lang];
      if (!entry || typeof entry !== 'object') return;
      if (entry.score === undefined) return;
      if (String(entry.backTranslation || '').trim()) return;
      candidates.push({ itemId, lang, entry });
    });
  });

  const selected = maxItems > 0 ? candidates.slice(0, maxItems) : candidates;
  console.log(`Candidates missing backTranslation: ${candidates.length}`);
  console.log(`Selected for processing: ${selected.length}`);
  if (!selected.length) {
    console.log('Nothing to do.');
    return;
  }

  let processed = 0;
  let translated = 0;
  let skippedNoText = 0;
  let skippedError = 0;
  let savedEntries = 0;
  let saveCalls = 0;
  let pendingPatch = {};

  async function flushPatch() {
    const itemIds = Object.keys(pendingPatch);
    if (!itemIds.length) return;
    if (dryRun) {
      savedEntries += itemIds.length;
      pendingPatch = {};
      return;
    }
    await fetchJson(`${baseUrl}/api/validation-storage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        validation_results: pendingPatch,
        metadata: {
          saved_by: 'backfill-validation-backtranslations',
          saved_at: new Date().toISOString(),
          backfill_languages: langs,
        },
      }),
    });
    saveCalls += 1;
    savedEntries += itemIds.length;
    pendingPatch = {};
  }

  async function processOne(candidate) {
    const { itemId, lang, entry } = candidate;
    const row = lookupRowForItemId(index, itemId);
    const translatedText = String(
      entry.translatedText || getTextForLanguage(row, lang) || ''
    ).trim();
    const originalText = String(entry.originalText || (row && row.en) || '').trim();
    if (!translatedText) {
      skippedNoText += 1;
      return;
    }

    let bt = '';
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const btPayload = await fetchJson(`${baseUrl}/api/back-translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            text: translatedText,
            fromLang: lang,
            toLang: 'en',
          }),
        });
        bt = String(btPayload?.translatedText || '').trim();
        if (bt) break;
        lastError = new Error('Empty translatedText in back-translate response');
      } catch (e) {
        lastError = e;
        await sleep(200 * attempt);
      }
    }
    if (!bt) {
      skippedError += 1;
      console.warn(`Back-translate failed for ${lang} ${itemId}: ${lastError?.message || lastError}`);
      return;
    }

    translated += 1;
    pendingPatch[itemId] = pendingPatch[itemId] || {};
    const patchEntry = {
      backTranslation: bt,
      updated: new Date().toISOString(),
    };
    if (!entry.translatedText && translatedText) patchEntry.translatedText = translatedText;
    if (!entry.originalText && originalText) patchEntry.originalText = originalText;
    pendingPatch[itemId][lang] = patchEntry;

    const pendingCount = Object.keys(pendingPatch).length;
    if (pendingCount >= saveBatchSize) {
      await flushPatch();
    }
  }

  await withConcurrency(selected, concurrency, async (candidate) => {
    await processOne(candidate);
    processed += 1;
    if (processed % 25 === 0 || processed === selected.length) {
      console.log(
        `Progress ${processed}/${selected.length} | translated=${translated} | noText=${skippedNoText} | errors=${skippedError} | pendingPatch=${Object.keys(pendingPatch).length}`
      );
    }
    return null;
  });

  await flushPatch();

  console.log('--- Backfill complete ---');
  console.log('Processed:', processed);
  console.log('Translated:', translated);
  console.log('Skipped (no text):', skippedNoText);
  console.log('Skipped (errors):', skippedError);
  console.log('Saved entries:', savedEntries);
  console.log('Save calls:', saveCalls);
}

main().catch((error) => {
  console.error('Backfill failed:', error?.message || error);
  process.exit(1);
});

