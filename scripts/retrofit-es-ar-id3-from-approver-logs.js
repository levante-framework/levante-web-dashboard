#!/usr/bin/env node

const { Storage } = require('@google-cloud/storage');
const NodeID3 = require('node-id3');

const DEV_BUCKET = process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev';
const LOG_BUCKET = process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';
const DEV_PREFIX = 'audio/es-AR/';
const LOG_PREFIX = 'logs/approver-audio-events/';

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

function parseTs(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : 0;
}

async function buildLogMap(storage) {
  const bucket = storage.bucket(LOG_BUCKET);
  const [files] = await bucket.getFiles({ prefix: LOG_PREFIX, autoPaginate: true });
  const map = new Map();

  for (const file of files) {
    try {
      const [buf] = await file.download();
      const event = JSON.parse(buf.toString('utf8'));
      if (String(event?.langCode || '').toLowerCase() !== 'es-ar') continue;
      if (String(event?.eventType || '').toLowerCase() !== 'regenerate_success') continue;

      const original = String(event?.originalTranslation || '').trim();
      const enhanced = String(event?.audioEnhancedText || '').trim();
      const key = String(event?.baseItemId || event?.itemId || '').trim();
      if (!key || !original || !enhanced) continue;

      const ts = parseTs(event?.serverTimestamp);
      const prev = map.get(key);
      if (!prev || ts > prev.ts) {
        map.set(key, { ts, original, enhanced });
      }
    } catch (_) {
      // Skip malformed log records.
    }
  }

  return map;
}

async function main() {
  const storage = getStorageClient();
  const logMap = await buildLogMap(storage);
  const devBucket = storage.bucket(DEV_BUCKET);
  const [files] = await devBucket.getFiles({ prefix: DEV_PREFIX, autoPaginate: true });
  const mp3Files = files.filter((file) => String(file.name || '').toLowerCase().endsWith('.mp3'));

  let scanned = 0;
  let matchedLogs = 0;
  let rewritten = 0;
  let unchanged = 0;
  let missingLogs = 0;
  let failed = 0;

  for (const file of mp3Files) {
    scanned += 1;
    const itemId = String(file.name || '').split('/').pop().replace(/\.mp3$/i, '');
    const row = logMap.get(itemId);
    if (!row) {
      missingLogs += 1;
      continue;
    }
    matchedLogs += 1;

    try {
      const [buffer] = await file.download();
      const tags = NodeID3.read(buffer) || {};
      let udt = asArray(tags.userDefinedText);

      const beforeOriginal = getCustomTag(udt, 'original_translation_text');
      const beforeEnhanced = getCustomTag(udt, 'audio_enhanced_text');
      const beforeUsed = getCustomTag(udt, 'used_audio_enhanced_text');

      const nextOriginal = row.original;
      const nextEnhanced = row.enhanced;
      const nextUsed = nextOriginal === nextEnhanced ? 'false' : 'true';

      if (
        beforeOriginal === nextOriginal &&
        beforeEnhanced === nextEnhanced &&
        beforeUsed === nextUsed
      ) {
        unchanged += 1;
        continue;
      }

      udt = setCustomTag(udt, 'original_translation_text', nextOriginal);
      udt = setCustomTag(udt, 'audio_enhanced_text', nextEnhanced);
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

  console.log('--- Corrective retrofit complete ---');
  console.log(`Dev bucket: ${DEV_BUCKET}`);
  console.log(`Logs bucket: ${LOG_BUCKET}`);
  console.log(`Scanned MP3s: ${scanned}`);
  console.log(`Matched log records: ${matchedLogs}`);
  console.log(`Rewritten from log text pairs: ${rewritten}`);
  console.log(`Already matched target tags: ${unchanged}`);
  console.log(`Missing logs for file: ${missingLogs}`);
  console.log(`Failed: ${failed}`);
}

main().catch((error) => {
  console.error('Retrofit failed:', error);
  process.exit(1);
});

