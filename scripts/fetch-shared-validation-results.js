#!/usr/bin/env node

/**
 * Download shared translation validation results from GCS.
 *
 * Defaults:
 * - bucket: VALIDATION_BUCKET || TOOLS_BUCKET || levante-tools
 * - object: VALIDATION_RESULTS_OBJECT || validations/validation_results.json
 * - out: data/validation/validation_results.shared.json
 *
 * Usage:
 *   node scripts/fetch-shared-validation-results.js
 *   node scripts/fetch-shared-validation-results.js --out data/validation/latest.json
 *   node scripts/fetch-shared-validation-results.js --bucket my-bucket --object validations/custom.json
 */

const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

function getArg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}

function parseCredentials() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '';
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON/GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON');
  }
}

async function main() {
  const bucketName = getArg('bucket', process.env.VALIDATION_BUCKET || process.env.TOOLS_BUCKET || 'levante-tools');
  const objectPath = getArg('object', process.env.VALIDATION_RESULTS_OBJECT || 'validations/validation_results.json');
  const outputPath = getArg('out', 'data/validation/validation_results.shared.json');

  const credentials = parseCredentials();
  if (!credentials) {
    throw new Error('Missing GCP credentials env (GCP_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS_JSON)');
  }

  const storage = new Storage({ credentials });
  const file = storage.bucket(bucketName).file(objectPath);
  const [exists] = await file.exists();
  if (!exists) {
    throw new Error(`GCS object not found: gs://${bucketName}/${objectPath}`);
  }

  const [buf] = await file.download();
  const outputAbs = path.resolve(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
  fs.writeFileSync(outputAbs, buf);

  // Validate shape lightly so downstream scripts fail less.
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf-8'));
  } catch (_) {
    throw new Error(`Downloaded object is not valid JSON: gs://${bucketName}/${objectPath}`);
  }
  const root = parsed && typeof parsed === 'object' ? (parsed.validation_results || parsed) : null;
  const itemCount = root && typeof root === 'object' ? Object.keys(root).length : 0;

  console.log(`Downloaded gs://${bucketName}/${objectPath}`);
  console.log(`Saved to ${outputPath}`);
  console.log(`Validation items detected: ${itemCount}`);
}

main().catch((err) => {
  console.error(`❌ ${err.message || String(err)}`);
  process.exit(1);
});

