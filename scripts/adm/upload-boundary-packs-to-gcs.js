#!/usr/bin/env node

/**
 * Upload boundary packs to Google Cloud Storage
 * 
 * Uploads all boundary packs from public/adm-packs/ to levante-assets-draft bucket
 * Organized by country code in folders: maps/boundaries/{country}/{file}
 * 
 * Usage:
 *   node scripts/adm/upload-boundary-packs-to-gcs.js
 * 
 * Environment variables:
 *   BOUNDARY_PACKS_BUCKET - GCS bucket name (default: levante-assets-draft)
 *   BOUNDARY_PACKS_PREFIX - GCS prefix/folder (default: maps/boundaries)
 */

const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');

const ADM_PACK_DIR = path.join(process.cwd(), 'public', 'adm-packs');
const BUCKET_NAME = process.env.BOUNDARY_PACKS_BUCKET || 'levante-assets-draft';
const BUCKET_PREFIX = process.env.BOUNDARY_PACKS_PREFIX || 'maps/boundaries';

function getStorageClient() {
  try {
    const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (serviceAccountJson) {
      const credentials = JSON.parse(serviceAccountJson);
      return new Storage({
        projectId: credentials.project_id,
        credentials: credentials
      });
    }
    // Fallback to Application Default Credentials
    return new Storage();
  } catch (error) {
    console.error('Error initializing GCS:', error.message);
    return null;
  }
}

async function uploadBoundaryPacks() {
  const storage = getStorageClient();
  if (!storage) {
    console.error('❌ Failed to initialize GCS client');
    console.error('   Set GCP_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS_JSON');
    process.exit(1);
  }

  const bucket = storage.bucket(BUCKET_NAME);
  
  // Check if bucket exists
  const [exists] = await bucket.exists();
  if (!exists) {
    console.error(`❌ Bucket ${BUCKET_NAME} does not exist`);
    console.error(`   Please create it or check your bucket name`);
    process.exit(1);
  }

  if (!fs.existsSync(ADM_PACK_DIR)) {
    console.error(`❌ Boundary packs directory not found: ${ADM_PACK_DIR}`);
    process.exit(1);
  }

  const countries = fs.readdirSync(ADM_PACK_DIR).filter(item => {
    const itemPath = path.join(ADM_PACK_DIR, item);
    return fs.statSync(itemPath).isDirectory();
  });

  console.log(`📤 Uploading boundary packs to gs://${BUCKET_NAME}/${BUCKET_PREFIX}/...\n`);
  console.log(`   Found ${countries.length} countries\n`);

  let totalFiles = 0;
  let totalSize = 0;
  let uploadedFiles = 0;

  for (const country of countries) {
    const countryDir = path.join(ADM_PACK_DIR, country);
    console.log(`🌍 ${country.toUpperCase()}:`);

    // Find all .json.gz files (including subdirectories like us/adm3/)
    const files = [];
    function findFiles(dir, relativePath = '') {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const itemPath = path.join(dir, item);
        const relPath = path.join(relativePath, item);
        if (fs.statSync(itemPath).isDirectory()) {
          findFiles(itemPath, relPath);
        } else if (item.endsWith('.json.gz')) {
          files.push({ localPath: itemPath, relativePath: relPath });
        }
      }
    }
    findFiles(countryDir);

    if (files.length === 0) {
      console.log(`   ⚠️  No boundary packs found\n`);
      continue;
    }

    for (const { localPath, relativePath } of files) {
      const remotePath = `${BUCKET_PREFIX}/${country}/${relativePath}`;
      const stats = fs.statSync(localPath);
      totalFiles++;
      totalSize += stats.size;

      try {
        await bucket.upload(localPath, {
          destination: remotePath,
          metadata: {
            cacheControl: 'public, max-age=31536000', // 1 year cache
            contentType: 'application/gzip',
          },
        });
        uploadedFiles++;
        console.log(`   ✅ ${relativePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
      } catch (error) {
        console.error(`   ❌ Failed to upload ${relativePath}: ${error.message}`);
      }
    }
    console.log('');
  }

  console.log(`\n✅ Upload complete!`);
  console.log(`   Uploaded: ${uploadedFiles}/${totalFiles} files`);
  console.log(`   Total size: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);
  console.log(`   Location: gs://${BUCKET_NAME}/${BUCKET_PREFIX}/`);
}

uploadBoundaryPacks().catch((error) => {
  console.error('❌ Upload failed:', error);
  process.exit(1);
});
