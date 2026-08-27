#!/usr/bin/env node

/**
 * Backfill WebP XMP copyright + CreateDate on levante-assets-{dev,prod}.
 *
 * Dry-run (default):
 *   node scripts/backfill-webp-copyright.js
 *
 * Write missing tags:
 *   node scripts/backfill-webp-copyright.js --apply
 *
 * Options:
 *   --buckets=dev,prod
 *   --prefix=visual/
 *   --limit=50
 *   --concurrency=8
 *   --overwrite   replace existing XMP license/created packet
 */

const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { DEFAULT_IMAGE_COPYRIGHT, hasLicense, stampWebpLicense, toIso8601 } = require('./stamp-webp-license.cjs');

require('events').defaultMaxListeners = 50;

try {
  const dotenv = require('dotenv');
  const envLocal = path.join(__dirname, '..', '.env.local');
  const envPath = path.join(__dirname, '..', '.env');
  if (require('fs').existsSync(envLocal)) dotenv.config({ path: envLocal, override: false, quiet: true });
  if (require('fs').existsSync(envPath)) dotenv.config({ path: envPath, override: false, quiet: true });
} catch {
  // dotenv optional
}

const ALLOWED_BUCKETS = {
  draft: 'levante-assets-draft',
  dev: 'levante-assets-dev',
  prod: 'levante-assets-prod',
};

function parseArgs(argv) {
  const flags = new Set(argv);
  const getValue = (flag) => {
    const prefix = `${flag}=`;
    const entry = argv.find((part) => String(part || '').startsWith(prefix));
    return entry ? String(entry).slice(prefix.length) : '';
  };
  const bucketsRaw = getValue('--buckets') || 'dev,prod';
  const buckets = bucketsRaw
    .split(',')
    .map((part) => String(part || '').trim().toLowerCase().replace(/^levante-assets-/, ''))
    .filter((key) => ALLOWED_BUCKETS[key]);
  const limitRaw = Number(getValue('--limit'));
  const concurrencyRaw = Number(getValue('--concurrency'));
  const prefixRaw = getValue('--prefix');
  return {
    apply: flags.has('--apply'),
    overwrite: flags.has('--overwrite'),
    adc: flags.has('--adc'),
    buckets: buckets.length ? buckets : ['dev', 'prod'],
    prefix: prefixRaw || '',
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

function getStorageClient(useAdc) {
  if (!useAdc) {
    const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (raw) {
      try {
        const credentials = parseCredentialsJson(raw);
        return new Storage({ credentials, projectId: credentials.project_id });
      } catch (error) {
        console.warn(`Ignoring invalid GCS JSON env (${error.message}); using application default credentials`);
      }
    }
  }
  return new Storage();
}

function createdFromFile(file) {
  const meta = file.metadata || {};
  return meta.customTime || meta.timeCreated || new Date().toISOString();
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

async function listWebpFiles(bucket, prefix) {
  const prefixes = prefix ? [prefix] : ['visual/', 'task-logos/'];
  const out = [];
  for (const item of prefixes) {
    const [files] = await bucket.getFiles({ prefix: item, autoPaginate: true });
    out.push(...(files || []));
  }
  return out.filter((file) => String(file.name || '').toLowerCase().endsWith('.webp'));
}

async function writeLicense(file, overwrite) {
  const [buffer] = await file.download();
  if (hasLicense(buffer) && !overwrite) return false;
  const stamped = stampWebpLicense(buffer, { created: createdFromFile(file) });
  await file.save(stamped, { contentType: 'image/webp', resumable: false });
  return true;
}

async function processBucket(storage, bucketKey, options) {
  const bucketName = ALLOWED_BUCKETS[bucketKey];
  const bucket = storage.bucket(bucketName);
  console.log(`\n=== ${bucketName} ===`);
  const files = await listWebpFiles(bucket, options.prefix);
  const selected = files.slice(0, options.limit);
  console.log(`Listed ${files.length} WebPs${selected.length !== files.length ? `, scanning first ${selected.length}` : ''}`);

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
      const [buffer] = await file.download();
      const present = hasLicense(buffer);
      if (present && !options.overwrite) {
        summary.present += 1;
      } else {
        summary.missing += 1;
        if (summary.samples.length < 8) summary.samples.push(file.name);
        if (options.apply) {
          const stamped = stampWebpLicense(buffer, { created: createdFromFile(file) });
          await file.save(stamped, { contentType: 'image/webp', resumable: false });
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
  console.log(`WebP XMP copyright backfill [${mode}]`);
  console.log(`Buckets: ${options.buckets.map((key) => ALLOWED_BUCKETS[key]).join(', ')}`);
  if (options.prefix) console.log(`Prefix: ${options.prefix}`);
  if (options.overwrite) console.log('Overwrite: on');
  if (options.adc) console.log('Credentials: application default');
  console.log(`License: ${DEFAULT_IMAGE_COPYRIGHT}`);
  console.log(`CreateDate: GCS customTime or timeCreated (${toIso8601(new Date())} used only if missing)`);

  const storage = getStorageClient(options.adc);
  const summaries = [];
  for (const bucketKey of options.buckets) {
    summaries.push(await processBucket(storage, bucketKey, options));
  }

  console.log('\n=== Summary ===');
  for (const row of summaries) {
    console.log(
      `${row.bucket}: scanned=${row.scanned} present=${row.present} missing=${row.missing}` +
        `${options.apply ? ` updated=${row.updated}` : ''} failed=${row.failed}`,
    );
    if (row.samples.length) {
      console.log(`  examples: ${row.samples.slice(0, 5).join(', ')}`);
    }
  }
  if (!options.apply) {
    console.log('\nNo files were modified. Re-run with --apply to write missing XMP copyright tags.');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
