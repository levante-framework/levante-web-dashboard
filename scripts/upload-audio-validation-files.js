#!/usr/bin/env node

/**
 * Upload local audio validation JSON files (data/validation/*.json) to the dashboard data bucket
 * so the deployed Cockpit can list/load them.
 *
 * Defaults:
 * - bucket: DASHBOARD_DATA_BUCKET (or levante-dashboard-dev)
 * - prefix: AUDIO_VALIDATION_FILES_PREFIX (or pitwall/audio-validation-results)
 *
 * Usage:
 *   node scripts/upload-audio-validation-files.js
 *   node scripts/upload-audio-validation-files.js --bucket levante-dashboard-dev --prefix pitwall/audio-validation-results
 */

const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  .option('bucket', { type: 'string', default: process.env.DASHBOARD_DATA_BUCKET || 'levante-dashboard-dev' })
  .option('prefix', { type: 'string', default: process.env.AUDIO_VALIDATION_FILES_PREFIX || 'pitwall/audio-validation-results' })
  .help(false)
  .parse();

function getStorageClient() {
  try {
    const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (raw) {
      const creds = JSON.parse(raw);
      return new Storage({ credentials: creds, projectId: creds.project_id });
    }
    return new Storage();
  } catch (e) {
    throw new Error(`Failed to init GCS client: ${e.message}`);
  }
}

function normalizePrefix(prefix) {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

async function main() {
  const bucketName = argv.bucket;
  const prefix = normalizePrefix(argv.prefix);
  const rootDir = path.join(__dirname, '..');
  const localDir = path.join(rootDir, 'data', 'validation');

  if (!fs.existsSync(localDir)) {
    console.error(`❌ Local directory not found: ${localDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(localDir)
    .filter(name => name.toLowerCase().endsWith('.json'))
    .map(name => path.join(localDir, name));

  if (!files.length) {
    console.log(`⚠️  No *.json files found in ${localDir}`);
    process.exit(0);
  }

  const storage = getStorageClient();
  const bucket = storage.bucket(bucketName);

  console.log(`📤 Uploading ${files.length} validation file(s) to gs://${bucketName}/${prefix}`);

  for (const filePath of files) {
    const base = path.basename(filePath);
    const dest = `${prefix}${base}`;
    await bucket.upload(filePath, {
      destination: dest,
      resumable: false,
      metadata: { cacheControl: 'no-cache, max-age=0', contentType: 'application/json' }
    });
    console.log(`✅ ${base} → ${dest}`);
  }

  console.log('🎉 Done. The deployed Audio Validation dropdown should now list these files.');
}

main().catch((err) => {
  console.error('❌ Upload failed:', err.message);
  process.exit(1);
});


