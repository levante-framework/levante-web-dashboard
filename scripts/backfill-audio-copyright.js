#!/usr/bin/env node

/**
 * Backfill ID3 COPYRIGHT on MP3s in levante-assets-{draft,dev,prod}.
 *
 * Dry-run (default):
 *   node scripts/backfill-audio-copyright.js
 *
 * Write missing tags:
 *   node scripts/backfill-audio-copyright.js --apply
 *
 * Options:
 *   --buckets=draft,dev,prod
 *   --langs=es-CO,de-DE
 *   --limit=50
 *   --concurrency=8
 *   --overwrite   replace existing COPYRIGHT with the default license
 */

const path = require('path');
const fs = require('fs');
const { Storage } = require('@google-cloud/storage');
const NodeID3 = require('node-id3');

require('events').defaultMaxListeners = 50;

try {
  const dotenv = require('dotenv');
  const envLocal = path.join(__dirname, '..', '.env.local');
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envLocal)) dotenv.config({ path: envLocal, override: false, quiet: true });
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath, override: false, quiet: true });
} catch {
  // dotenv optional
}

const DEFAULT_AUDIO_COPYRIGHT = 'This file was created for the LEVANTE project and is released under a Creative Commons BY-NC-SA 4.0 license';
const ALLOWED_BUCKETS = {
  draft: 'levante-assets-draft',
  dev: 'levante-assets-dev',
  prod: 'levante-assets-prod',
};

function parseArgs(argv) {
  const flags = new Set(argv);
  const getValue = (flag) => {
    const prefix = `${flag}=`;
    const entry = argv.find((part) => String(part).startsWith(prefix));
    return entry ? String(entry).slice(prefix.length) : '';
  };
  const bucketsRaw = getValue('--buckets') || 'draft,dev,prod';
  const buckets = bucketsRaw
    .split(',')
    .map((part) => String(part || '').trim().toLowerCase().replace(/^levante-assets-/, ''))
    .filter((key) => ALLOWED_BUCKETS[key]);
  const langs = (getValue('--langs') || '')
    .split(',')
    .map((part) => String(part || '').trim())
    .filter(Boolean);
  const limitRaw = Number(getValue('--limit'));
  const concurrencyRaw = Number(getValue('--concurrency'));
  return {
    apply: flags.has('--apply'),
    overwrite: flags.has('--overwrite'),
    buckets: buckets.length ? buckets : ['draft', 'dev', 'prod'],
    langs,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : Infinity,
    concurrency: Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? Math.min(16, concurrencyRaw) : 8,
  };
}

function parseCredentialsJson(raw) {
  let json = String(raw || '').trim();
  if ((json.startsWith('"') && json.endsWith('"')) || (json.startsWith("'") && json.endsWith("'"))) {
    json = json.slice(1, -1);
  }
  try {
    return JSON.parse(json);
  } catch {
    let out = '';
    let inStr = false;
    let esc = false;
    for (const ch of json) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = !inStr; out += ch; continue; }
      if (inStr) {
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') { out += '\\r'; continue; }
        if (ch === '\t') { out += '\\t'; continue; }
      }
      out += ch;
    }
    return JSON.parse(out);
  }
}

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (raw) {
    const credentials = parseCredentialsJson(raw);
    return new Storage({ credentials, projectId: credentials.project_id });
  }
  return new Storage();
}

function currentCopyright(tags) {
  return String(tags?.copyright || '').trim();
}

function needsCopyright(existing, overwrite) {
  if (overwrite) return existing !== DEFAULT_AUDIO_COPYRIGHT;
  return !existing;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Math.min(Math.max(1, limit), Math.max(1, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

async function listMp3Files(bucket, langs) {
  if (langs.length) {
    const nested = [];
    for (const lang of langs) {
      const prefix = lang.startsWith('audio/') ? lang.replace(/\/?$/, '/') : `audio/${lang.replace(/\/?$/, '')}/`;
      const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
      nested.push(...files);
    }
    return nested.filter((file) => String(file.name || '').toLowerCase().endsWith('.mp3'));
  }
  const [files] = await bucket.getFiles({ prefix: 'audio/', autoPaginate: true });
  return (files || []).filter((file) => String(file.name || '').toLowerCase().endsWith('.mp3'));
}

async function inspectFile(file) {
  const [headBuffer] = await file.download({ start: 0, end: 131071 });
  const tags = NodeID3.read(headBuffer) || {};
  return currentCopyright(tags);
}

async function writeCopyright(file) {
  const [buffer] = await file.download();
  const updated = NodeID3.update({ copyright: DEFAULT_AUDIO_COPYRIGHT }, buffer);
  if (!Buffer.isBuffer(updated)) {
    throw new Error('NodeID3.update did not return a buffer');
  }
  await file.save(updated, { contentType: 'audio/mpeg', resumable: false, public: false });
}

async function processBucket(storage, bucketKey, options) {
  const bucketName = ALLOWED_BUCKETS[bucketKey];
  const bucket = storage.bucket(bucketName);
  console.log(`\n=== ${bucketName} ===`);
  const files = await listMp3Files(bucket, options.langs);
  const selected = files.slice(0, options.limit);
  console.log(`Listed ${files.length} MP3s${selected.length !== files.length ? `, scanning first ${selected.length}` : ''}`);

  const summary = {
    bucket: bucketName,
    scanned: 0,
    missing: 0,
    present: 0,
    updated: 0,
    failed: 0,
    samples: [],
  };

  await mapPool(selected, options.concurrency, async (file) => {
    summary.scanned += 1;
    try {
      const existing = await inspectFile(file);
      if (!needsCopyright(existing, options.overwrite)) {
        summary.present += 1;
      } else {
        summary.missing += 1;
        if (summary.samples.length < 8) summary.samples.push(file.name);
        if (options.apply) {
          await writeCopyright(file);
          summary.updated += 1;
        }
      }
      if (summary.scanned % 100 === 0) {
        console.log(`  scanned ${summary.scanned}/${selected.length} (missing ${summary.missing}, present ${summary.present})`);
      }
    } catch (error) {
      summary.failed += 1;
      console.warn(`  failed ${file.name}: ${error.message}`);
    }
  });

  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mode = options.apply ? 'APPLY' : 'DRY-RUN';
  console.log(`ID3 COPYRIGHT backfill [${mode}]`);
  console.log(`Buckets: ${options.buckets.map((key) => ALLOWED_BUCKETS[key]).join(', ')}`);
  if (options.langs.length) console.log(`Langs: ${options.langs.join(', ')}`);
  if (options.overwrite) console.log('Overwrite: on');
  console.log(`License: ${DEFAULT_AUDIO_COPYRIGHT}`);

  const storage = getStorageClient();
  const summaries = [];
  for (const bucketKey of options.buckets) {
    summaries.push(await processBucket(storage, bucketKey, options));
  }

  console.log('\n=== Summary ===');
  for (const row of summaries) {
    console.log(
      `${row.bucket}: scanned=${row.scanned} present=${row.present} missing=${row.missing}` +
      `${options.apply ? ` updated=${row.updated}` : ''} failed=${row.failed}`
    );
    if (row.samples.length) {
      console.log(`  examples: ${row.samples.slice(0, 5).join(', ')}`);
    }
  }
  if (!options.apply) {
    console.log('\nNo files were modified. Re-run with --apply to write missing COPYRIGHT tags.');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
