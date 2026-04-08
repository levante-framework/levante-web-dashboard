#!/usr/bin/env node

const { Storage } = require('@google-cloud/storage');
const NodeID3 = require('node-id3');

const DEV_BUCKET = process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev';
const TOOLS_BUCKET = process.env.VALIDATION_BUCKET || process.env.TOOLS_BUCKET || 'levante-tools';
const DEV_PREFIX = 'audio/es-AR/';
const ENHANCED_TEXT_PREFIX = process.env.PARTNER_AUDIO_ENHANCED_TEXT_PREFIX || 'partner-audio/enhanced-text';
const TRANSLATION_CSV_URL = process.env.TRANSLATION_CSV_URL || 'https://raw.githubusercontent.com/levante-framework/levante_translations/l10n_pending/item-bank-translations.csv';

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (raw) {
    const credentials = JSON.parse(raw);
    return new Storage({ credentials, projectId: credentials.project_id });
  }
  return new Storage();
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getCustomTag(list, description) {
  const target = String(description || '').toLowerCase();
  const found = asArray(list).find((entry) => String(entry?.description || '').toLowerCase() === target);
  return String(found?.value || '').trim();
}

function setCustomTag(list, description, value) {
  const desc = String(description || '').trim();
  const val = String(value || '').trim();
  const next = asArray(list).filter(Boolean).map((entry) => ({
    description: String(entry.description || '').trim(),
    value: String(entry.value || '').trim()
  }));
  if (!desc || !val) return next;
  const idx = next.findIndex((entry) => entry.description.toLowerCase() === desc.toLowerCase());
  if (idx >= 0) next[idx].value = val;
  else next.push({ description: desc, value: val });
  return next;
}

function parseCsvWithEmbeddedNewlines(csvText) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i += 1) {
    const ch = csvText[i];
    const next = i + 1 < csvText.length ? csvText[i + 1] : '';
    if (ch === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      row.push(field.trim());
      field = '';
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(field.trim());
      field = '';
      if (row.some((cell) => String(cell || '').trim().length > 0)) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) {
    row.push(field.trim());
    if (row.some((cell) => String(cell || '').trim().length > 0)) rows.push(row);
  }
  return rows;
}

async function loadTranslationMap() {
  const response = await fetch(TRANSLATION_CSV_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load translation CSV (${response.status})`);
  }
  const csv = await response.text();
  const rows = parseCsvWithEmbeddedNewlines(csv);
  if (!rows.length) return new Map();
  const headers = rows[0].map((h) => String(h || '').replace(/^\uFEFF/, '').trim());
  const idIdx = headers.findIndex((h) => ['item_id', 'identifier', 'id'].includes(h));
  const langCandidates = ['es-AR', 'es_AR', 'es-ar', 'es'];
  const langIdx = headers.findIndex((h) => langCandidates.includes(h));
  if (idIdx < 0 || langIdx < 0) {
    throw new Error('Could not locate item_id/es-AR columns in translation CSV');
  }
  const map = new Map();
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i];
    const id = String(cells[idIdx] || '').trim();
    const text = String(cells[langIdx] || '').trim();
    if (!id || !text) continue;
    map.set(id, text);
  }
  return map;
}

async function loadEnhancedMap(storage) {
  const bucket = storage.bucket(TOOLS_BUCKET);
  const candidates = [`${ENHANCED_TEXT_PREFIX}/es-ar.json`, `${ENHANCED_TEXT_PREFIX}/es_ar.json`];
  for (const path of candidates) {
    const file = bucket.file(path);
    const [exists] = await file.exists();
    if (!exists) continue;
    const [buf] = await file.download();
    const json = JSON.parse(buf.toString('utf8'));
    const entries = json && typeof json.entries === 'object' ? json.entries : {};
    const map = new Map();
    Object.entries(entries).forEach(([itemId, payload]) => {
      const text = String(payload?.text || '').trim();
      if (itemId && text) map.set(itemId, text);
    });
    return { map, path };
  }
  return { map: new Map(), path: '' };
}

async function main() {
  const storage = getStorageClient();
  const translationMap = await loadTranslationMap();
  const { map: enhancedMap, path: enhancedPath } = await loadEnhancedMap(storage);

  const devBucket = storage.bucket(DEV_BUCKET);
  const [files] = await devBucket.getFiles({ prefix: DEV_PREFIX, autoPaginate: true });
  const mp3Files = files.filter((file) => String(file.name || '').toLowerCase().endsWith('.mp3'));

  let scanned = 0;
  let rewritten = 0;
  let noTranslation = 0;
  let unchanged = 0;
  let failed = 0;
  let usedEnhanced = 0;

  for (const file of mp3Files) {
    scanned += 1;
    const itemId = String(file.name || '').split('/').pop().replace(/\.mp3$/i, '');
    const original = String(translationMap.get(itemId) || '').trim();
    if (!original) {
      noTranslation += 1;
      continue;
    }
    const enhanced = String(enhancedMap.get(itemId) || original).trim();
    const used = enhanced !== original;
    if (used) usedEnhanced += 1;

    try {
      const [buffer] = await file.download();
      const tags = NodeID3.read(buffer) || {};
      let udt = asArray(tags.userDefinedText);

      const beforeOriginal = getCustomTag(udt, 'original_translation_text');
      const beforeEnhanced = getCustomTag(udt, 'audio_enhanced_text');
      const beforeUsed = getCustomTag(udt, 'used_audio_enhanced_text');
      const nextUsed = used ? 'true' : 'false';

      if (beforeOriginal === original && beforeEnhanced === enhanced && beforeUsed === nextUsed) {
        unchanged += 1;
        continue;
      }

      udt = setCustomTag(udt, 'original_translation_text', original);
      udt = setCustomTag(udt, 'audio_enhanced_text', enhanced);
      udt = setCustomTag(udt, 'used_audio_enhanced_text', nextUsed);

      const updatedBuffer = NodeID3.update({ userDefinedText: udt }, buffer);
      await file.save(updatedBuffer, {
        contentType: 'audio/mpeg',
        resumable: false
      });
      rewritten += 1;
    } catch (error) {
      failed += 1;
      console.warn(`Failed ${file.name}: ${error.message}`);
    }
  }

  console.log('--- Fallback retrofit complete ---');
  console.log(`Dev bucket: ${DEV_BUCKET}`);
  console.log(`Enhanced text source: ${enhancedPath || 'not found (fallback to original only)'}`);
  console.log(`Translation source: ${TRANSLATION_CSV_URL}`);
  console.log(`Scanned MP3s: ${scanned}`);
  console.log(`Rewritten: ${rewritten}`);
  console.log(`Already unchanged: ${unchanged}`);
  console.log(`Missing translation row: ${noTranslation}`);
  console.log(`Enhanced text differed from original for: ${usedEnhanced}`);
  console.log(`Failed: ${failed}`);
}

main().catch((error) => {
  console.error('Fallback retrofit failed:', error);
  process.exit(1);
});

