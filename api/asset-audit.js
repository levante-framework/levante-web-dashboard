/**
 * Asset Audit API
 * Compares files between levante-assets-dev and levante-assets-prod
 */

import { Storage } from '@google-cloud/storage';

const DEV_BUCKET = 'levante-assets-dev';
const PROD_BUCKET = 'levante-assets-prod';

function getStorageClient() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!serviceAccountJson) {
    // Try default application credentials (works in Vercel with service account)
    try {
      return new Storage();
    } catch (e) {
      console.warn('No GCS credentials available');
      return null;
    }
  }
  
  try {
    // Handle .env file formatting: strip surrounding quotes and handle escaped newlines
    let json = serviceAccountJson.trim();
    if ((json.startsWith('"') && json.endsWith('"')) ||
        (json.startsWith("'") && json.endsWith("'"))) {
      json = json.slice(1, -1);
    }
    json = json.replace(/\\n/g, '\n');
    
    const credentials = JSON.parse(json);
    return new Storage({ credentials });
  } catch (e) {
    console.warn('GCS credentials env is not valid JSON:', e.message);
    // Fallback to default credentials
    try {
      return new Storage();
    } catch (e2) {
      return null;
    }
  }
}

function shouldExclude(name, excludePatterns) {
  if (!excludePatterns || excludePatterns.length === 0) return false;
  return excludePatterns.some(pattern => name.includes(pattern));
}

async function listAllFiles(storage, bucketName, prefix = '') {
  const bucket = storage.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
  
  const fileMap = new Map();
  
  // Fetch metadata for all files in parallel batches
  const batchSize = 100;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const metadataPromises = batch.map(async (file) => {
      try {
        const [metadata] = await file.getMetadata();
        return {
          file,
          metadata
        };
      } catch (e) {
        // Fallback to file.metadata if getMetadata fails
        return {
          file,
          metadata: file.metadata || {}
        };
      }
    });
    
    const results = await Promise.all(metadataPromises);
    
    for (const { file, metadata } of results) {
      const name = file.name;
      const updated = metadata.updated || metadata.timeCreated || new Date().toISOString();
      const size = Number(metadata.size || file.size || 0);
      const md5Hash = metadata.md5Hash || metadata.md5 || null;
      const crc32c = metadata.crc32c || null;
      
      fileMap.set(name, {
        name,
        updated: new Date(updated),
        size,
        md5Hash,
        crc32c,
        bucket: bucketName
      });
    }
  }
  
  return fileMap;
}

function filesAreIdentical(devFile, prodFile) {
  // Compare MD5 hash first (most reliable)
  if (devFile.md5Hash && prodFile.md5Hash) {
    return devFile.md5Hash === prodFile.md5Hash;
  }
  
  // Fallback to CRC32C if MD5 not available
  if (devFile.crc32c && prodFile.crc32c) {
    return devFile.crc32c === prodFile.crc32c;
  }
  
  // Fallback to size comparison (less reliable but better than nothing)
  // Only consider identical if size matches AND timestamps are very close (within 1 second)
  // This handles cases where files are identical but uploaded at slightly different times
  if (devFile.size === prodFile.size && devFile.size > 0) {
    const timeDiff = Math.abs(devFile.updated.getTime() - prodFile.updated.getTime());
    // If sizes match and timestamps are within 1 second, likely identical
    if (timeDiff < 1000) {
      return true;
    }
  }
  
  return false;
}

function compareFiles(devFiles, prodFiles, excludePatterns = [], prefixFilter = '') {
  const onlyInDev = [];
  const newerInDev = [];
  let identicalCount = 0;
  
  // Check files in dev
  for (const [name, devFile] of devFiles) {
    // Apply prefix filter
    if (prefixFilter && !name.startsWith(prefixFilter)) continue;
    
    // Skip excluded patterns
    if (shouldExclude(name, excludePatterns)) continue;
    
    const prodFile = prodFiles.get(name);
    
    if (!prodFile) {
      // File only exists in dev
      onlyInDev.push(devFile);
    } else {
      // File exists in both - check if identical
      if (filesAreIdentical(devFile, prodFile)) {
        identicalCount++;
        continue; // Skip identical files
      }
      
      // Files differ - check if dev is newer
      if (devFile.updated > prodFile.updated) {
        newerInDev.push({
          name: devFile.name,
          devUpdated: devFile.updated,
          prodUpdated: prodFile.updated,
          devSize: devFile.size,
          prodSize: prodFile.size,
          devMd5: devFile.md5Hash,
          prodMd5: prodFile.md5Hash,
          ageDiffMs: devFile.updated.getTime() - prodFile.updated.getTime(),
          ageDiffDays: Math.round((devFile.updated.getTime() - prodFile.updated.getTime()) / (1000 * 60 * 60 * 24))
        });
      }
    }
  }
  
  return { onlyInDev, newerInDev, identicalCount };
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const prefix = (req.query.prefix || '').toString();
  const exclude = (req.query.exclude || '').toString();
  const excludePatterns = exclude ? exclude.split(',').map(p => p.trim()).filter(p => p) : [];

  try {
    const storage = getStorageClient();
    if (!storage) {
      return res.status(500).json({ 
        success: false, 
        error: 'GCS credentials not available',
        message: 'Please configure GCP_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS'
      });
    }

    const [devFiles, prodFiles] = await Promise.all([
      listAllFiles(storage, DEV_BUCKET, prefix),
      listAllFiles(storage, PROD_BUCKET, prefix)
    ]);

    const results = compareFiles(devFiles, prodFiles, excludePatterns, prefix);

    return res.status(200).json({
      success: true,
      devBucket: DEV_BUCKET,
      prodBucket: PROD_BUCKET,
      prefix,
      exclude: excludePatterns,
      devFileCount: devFiles.size,
      prodFileCount: prodFiles.size,
      onlyInDev: results.onlyInDev.map(f => ({
        name: f.name,
        updated: f.updated.toISOString(),
        size: f.size
      })),
      newerInDev: results.newerInDev.map(f => ({
        name: f.name,
        devUpdated: f.devUpdated.toISOString(),
        prodUpdated: f.prodUpdated.toISOString(),
        devSize: f.devSize,
        prodSize: f.prodSize,
        ageDiffDays: f.ageDiffDays
      })),
      summary: {
        onlyInDevCount: results.onlyInDev.length,
        newerInDevCount: results.newerInDev.length,
        identicalCount: results.identicalCount,
        total: results.onlyInDev.length + results.newerInDev.length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('asset-audit error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal error', 
      message: error.message 
    });
  }
}
