#!/usr/bin/env node
/**
 * Compare files between levante-assets-dev and levante-assets-prod
 * Shows files that are:
 * - Only in dev (not in prod)
 * - In both but newer in dev
 */

import { Storage } from '@google-cloud/storage';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';

// Load .env files (similar to generate-gallery-images.js)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envLocalPath = join(__dirname, '..', '.env.local');
const envPath = join(__dirname, '..', '.env');

try {
  if (existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath, override: false });
  }
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
  }
} catch (e) {
  // dotenv not installed or .env file doesn't exist - that's okay
}

const argv = yargs(hideBin(process.argv))
  .option('prefix', {
    type: 'string',
    description: 'Prefix to filter files (e.g., "visual/", "audio/")',
    default: ''
  })
  .option('exclude', {
    type: 'string',
    description: 'Comma-separated list of patterns to exclude (e.g., "pt-PT,downex")',
    default: ''
  })
  .option('output', {
    type: 'string',
    description: 'Output format: "json", "text", or "csv"',
    default: 'text'
  })
  .option('only-newer', {
    type: 'boolean',
    description: 'Only show files that are newer in dev (exclude files only in dev)',
    default: false
  })
  .option('only-missing', {
    type: 'boolean',
    description: 'Only show files that exist only in dev (exclude newer files)',
    default: false
  })
  .help()
  .argv;

const DEV_BUCKET = 'levante-assets-dev';
const PROD_BUCKET = 'levante-assets-prod';

function getStorageClient() {
  // Try multiple credential sources
  let serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  
  // First, try file path if available
  if (credentialsPath) {
    try {
      const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
      return new Storage({ credentials });
    } catch (e) {
      console.error('Warning: Could not load credentials from file:', e.message);
    }
  }
  
  // Then try environment variable JSON
  if (serviceAccountJson) {
    // Handle .env file formatting: strip surrounding quotes and handle escaped newlines
    serviceAccountJson = serviceAccountJson.trim();
    if ((serviceAccountJson.startsWith('"') && serviceAccountJson.endsWith('"')) ||
        (serviceAccountJson.startsWith("'") && serviceAccountJson.endsWith("'"))) {
      serviceAccountJson = serviceAccountJson.slice(1, -1);
    }
    // Replace escaped newlines with actual newlines
    serviceAccountJson = serviceAccountJson.replace(/\\n/g, '\n');
    
    try {
      const credentials = JSON.parse(serviceAccountJson);
      return new Storage({ credentials });
    } catch (e) {
      console.error('Error: GCS credentials env is not valid JSON:', e.message);
      console.error('Position:', e.message.match(/position (\d+)/)?.[1] || 'unknown');
      console.error('\nTip: In .env files, JSON should be on a single line or use \\n for newlines');
      console.error('Alternatively, set GOOGLE_APPLICATION_CREDENTIALS to a file path');
    }
  }
  
  // Last resort: try default application credentials
  try {
    console.error('Attempting to use default application credentials...');
    return new Storage();
  } catch (e) {
    console.error('Error: No GCS credentials found. Please set one of:');
    console.error('  - GCP_SERVICE_ACCOUNT_JSON (JSON string)');
    console.error('  - GOOGLE_APPLICATION_CREDENTIALS_JSON (JSON string)');
    console.error('  - GOOGLE_APPLICATION_CREDENTIALS (file path)');
    console.error('  - Or run: gcloud auth application-default login');
    process.exit(1);
  }
}

async function listAllFiles(storage, bucketName, prefix = '') {
  console.error(`📦 Listing files from ${bucketName}${prefix ? ` (prefix: ${prefix})` : ''}...`);
  const bucket = storage.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
  
  const fileMap = new Map();
  for (const file of files) {
    const name = file.name;
    const updated = file.metadata?.updated || file.metadata?.timeCreated || new Date().toISOString();
    const size = Number(file.metadata?.size || file.size || 0);
    
    fileMap.set(name, {
      name,
      updated: new Date(updated),
      size,
      bucket: bucketName
    });
  }
  
  console.error(`   Found ${fileMap.size} files`);
  return fileMap;
}

function shouldExclude(name, excludePatterns) {
  if (!excludePatterns || excludePatterns.length === 0) return false;
  return excludePatterns.some(pattern => name.includes(pattern));
}

function compareFiles(devFiles, prodFiles, excludePatterns = []) {
  const onlyInDev = [];
  const newerInDev = [];
  
  // Check files in dev
  for (const [name, devFile] of devFiles) {
    // Skip excluded patterns
    if (shouldExclude(name, excludePatterns)) continue;
    
    const prodFile = prodFiles.get(name);
    
    if (!prodFile) {
      // File only exists in dev
      onlyInDev.push(devFile);
    } else {
      // File exists in both - check if dev is newer
      if (devFile.updated > prodFile.updated) {
        newerInDev.push({
          name: devFile.name,
          devUpdated: devFile.updated,
          prodUpdated: prodFile.updated,
          devSize: devFile.size,
          prodSize: prodFile.size,
          ageDiffMs: devFile.updated.getTime() - prodFile.updated.getTime(),
          ageDiffDays: Math.round((devFile.updated.getTime() - prodFile.updated.getTime()) / (1000 * 60 * 60 * 24))
        });
      }
    }
  }
  
  return { onlyInDev, newerInDev };
}

function formatOutput(results, format) {
  const { onlyInDev, newerInDev } = results;
  
  if (format === 'json') {
    return JSON.stringify({
      onlyInDev: onlyInDev.map(f => ({
        name: f.name,
        updated: f.updated.toISOString(),
        size: f.size
      })),
      newerInDev: newerInDev.map(f => ({
        name: f.name,
        devUpdated: f.devUpdated.toISOString(),
        prodUpdated: f.prodUpdated.toISOString(),
        devSize: f.devSize,
        prodSize: f.prodSize,
        ageDiffDays: f.ageDiffDays
      })),
      summary: {
        onlyInDevCount: onlyInDev.length,
        newerInDevCount: newerInDev.length,
        total: onlyInDev.length + newerInDev.length
      }
    }, null, 2);
  }
  
  if (format === 'csv') {
    const lines = ['Type,File Name,Dev Updated,Prod Updated,Dev Size,Prod Size,Age Diff (days)'];
    
    for (const file of onlyInDev) {
      lines.push(`Only in Dev,"${file.name}",${file.updated.toISOString()},,${file.size},,`);
    }
    
    for (const file of newerInDev) {
      lines.push(`Newer in Dev,"${file.name}",${file.devUpdated.toISOString()},${file.prodUpdated.toISOString()},${file.devSize},${file.prodSize},${file.ageDiffDays}`);
    }
    
    return lines.join('\n');
  }
  
  // Text format
  const output = [];
  
  if (!argv.onlyNewer && onlyInDev.length > 0) {
    output.push(`\n📁 Files only in DEV (${onlyInDev.length}):`);
    output.push('─'.repeat(80));
    for (const file of onlyInDev) {
      const sizeKB = (file.size / 1024).toFixed(1);
      output.push(`  ${file.name}`);
      output.push(`    Updated: ${file.updated.toISOString()} | Size: ${sizeKB} KB`);
    }
  }
  
  if (!argv.onlyMissing && newerInDev.length > 0) {
    output.push(`\n🔄 Files newer in DEV (${newerInDev.length}):`);
    output.push('─'.repeat(80));
    for (const file of newerInDev) {
      const devSizeKB = (file.devSize / 1024).toFixed(1);
      const prodSizeKB = (file.prodSize / 1024).toFixed(1);
      output.push(`  ${file.name}`);
      output.push(`    Dev:  ${file.devUpdated.toISOString()} (${devSizeKB} KB)`);
      output.push(`    Prod: ${file.prodUpdated.toISOString()} (${prodSizeKB} KB)`);
      output.push(`    Diff: ${file.ageDiffDays} days newer in dev`);
    }
  }
  
  output.push(`\n📊 Summary:`);
  output.push(`   Only in Dev: ${onlyInDev.length}`);
  output.push(`   Newer in Dev: ${newerInDev.length}`);
  output.push(`   Total: ${onlyInDev.length + newerInDev.length}`);
  
  return output.join('\n');
}

async function main() {
  const storage = getStorageClient();
  
  console.error('🔍 Comparing buckets...');
  console.error(`   Dev:  ${DEV_BUCKET}`);
  console.error(`   Prod: ${PROD_BUCKET}`);
  if (argv.prefix) {
    console.error(`   Prefix: ${argv.prefix}`);
  }
  
  const excludePatterns = argv.exclude ? argv.exclude.split(',').map(p => p.trim()).filter(p => p) : [];
  if (excludePatterns.length > 0) {
    console.error(`   Excluding: ${excludePatterns.join(', ')}`);
  }
  
  const [devFiles, prodFiles] = await Promise.all([
    listAllFiles(storage, DEV_BUCKET, argv.prefix),
    listAllFiles(storage, PROD_BUCKET, argv.prefix)
  ]);
  
  const results = compareFiles(devFiles, prodFiles, excludePatterns);
  
  // Filter results based on flags
  let filteredResults = results;
  if (argv.onlyNewer) {
    filteredResults = { onlyInDev: [], newerInDev: results.newerInDev };
  } else if (argv.onlyMissing) {
    filteredResults = { onlyInDev: results.onlyInDev, newerInDev: [] };
  }
  
  const output = formatOutput(filteredResults, argv.output);
  console.log(output);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
