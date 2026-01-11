#!/usr/bin/env node

/**
 * Upload pre-downloaded GeoBoundaries data to Google Cloud Storage bucket
 * This avoids GitHub file size limits
 */

const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(process.cwd(), 'data', 'geoboundaries');
const BUCKET_NAME = process.env.GEOBOUNDARIES_BUCKET || 'levante-geoboundaries';
const BUCKET_PREFIX = 'geoboundaries';

async function uploadToBucket() {
  const storage = new Storage();
  const bucket = storage.bucket(BUCKET_NAME);
  
  // Check if bucket exists, create if not
  const [exists] = await bucket.exists();
  if (!exists) {
    console.log(`Creating bucket: ${BUCKET_NAME}`);
    await bucket.create({
      location: 'US',
      storageClass: 'STANDARD',
    });
  }
  
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json.gz'));
  
  console.log(`📤 Uploading ${files.length} files to gs://${BUCKET_NAME}/${BUCKET_PREFIX}/...\n`);
  
  for (const file of files) {
    const localPath = path.join(CACHE_DIR, file);
    const remotePath = `${BUCKET_PREFIX}/${file}`;
    
    console.log(`Uploading ${file}...`);
    await bucket.upload(localPath, {
      destination: remotePath,
      metadata: {
        cacheControl: 'public, max-age=31536000', // 1 year cache
        contentType: 'application/gzip',
      },
    });
    
    const stats = fs.statSync(localPath);
    console.log(`  ✅ Uploaded: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
  }
  
  console.log(`\n✅ All files uploaded to gs://${BUCKET_NAME}/${BUCKET_PREFIX}/`);
  console.log(`\nUpdate API to use: gs://${BUCKET_NAME}/${BUCKET_PREFIX}/`);
}

uploadToBucket().catch(console.error);
