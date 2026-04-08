#!/usr/bin/env node

const { Storage } = require('@google-cloud/storage');
const NodeID3 = require('node-id3');

const BUCKET = process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev';
const PREFIX = 'audio/es-AR/';

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (raw) {
    const credentials = JSON.parse(raw);
    return new Storage({ credentials, projectId: credentials.project_id });
  }
  return new Storage();
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getUdtValue(list, description) {
  const target = String(description || '').toLowerCase();
  const found = toArray(list).find((entry) => String(entry?.description || '').toLowerCase() === target);
  return String(found?.value || '').trim();
}

function setUdtValue(list, description, value) {
  const next = toArray(list).filter(Boolean).map((entry) => ({
    description: String(entry.description || '').trim(),
    value: String(entry.value || '').trim()
  }));
  const desc = String(description || '').trim();
  const val = String(value || '').trim();
  if (!desc || !val) return next;
  const idx = next.findIndex((entry) => entry.description.toLowerCase() === desc.toLowerCase());
  if (idx >= 0) next[idx].value = val;
  else next.push({ description: desc, value: val });
  return next;
}

async function main() {
  const storage = getStorageClient();
  const bucket = storage.bucket(BUCKET);
  const [files] = await bucket.getFiles({ prefix: PREFIX, autoPaginate: true });
  const mp3Files = files.filter((file) => String(file.name || '').toLowerCase().endsWith('.mp3'));

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of mp3Files) {
    scanned += 1;
    try {
      const [headBuffer] = await file.download({ start: 0, end: 65535 });
      const tags = NodeID3.read(headBuffer) || {};
      const existingUdt = toArray(tags.userDefinedText);

      const currentOriginal = getUdtValue(existingUdt, 'original_translation_text');
      const currentEnhanced = getUdtValue(existingUdt, 'audio_enhanced_text');
      const currentText = getUdtValue(existingUdt, 'text');

      const nextOriginal = currentOriginal || currentText;
      const nextEnhanced = currentEnhanced || currentText;
      const usedEnhanced = (nextOriginal && nextEnhanced && nextOriginal !== nextEnhanced) ? 'true' : 'false';

      // Nothing to backfill for this file.
      if ((!nextOriginal || currentOriginal) && (!nextEnhanced || currentEnhanced)) {
        skipped += 1;
        continue;
      }

      let nextUdt = existingUdt;
      if (nextOriginal && !currentOriginal) {
        nextUdt = setUdtValue(nextUdt, 'original_translation_text', nextOriginal);
      }
      if (nextEnhanced && !currentEnhanced) {
        nextUdt = setUdtValue(nextUdt, 'audio_enhanced_text', nextEnhanced);
      }
      nextUdt = setUdtValue(nextUdt, 'used_audio_enhanced_text', usedEnhanced);

      const [fullBuffer] = await file.download();
      const updatedBuffer = NodeID3.update({ userDefinedText: nextUdt }, fullBuffer);

      await file.save(updatedBuffer, {
        contentType: 'audio/mpeg',
        resumable: false
      });

      updated += 1;
      if (updated % 50 === 0) {
        console.log(`Progress: updated ${updated}/${scanned} scanned`);
      }
    } catch (error) {
      failed += 1;
      console.warn(`Failed: ${file.name} -> ${error.message}`);
    }
  }

  console.log('--- Retrofit complete ---');
  console.log(`Bucket: ${BUCKET}`);
  console.log(`Prefix: ${PREFIX}`);
  console.log(`Scanned: ${scanned}`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
}

main().catch((error) => {
  console.error('Retrofit script failed:', error);
  process.exit(1);
});

