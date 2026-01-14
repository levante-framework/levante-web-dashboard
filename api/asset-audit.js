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

async function listAllFiles(storage, bucketName, prefix = '', fetchChecksums = false) {
  const bucket = storage.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
  
  const fileMap = new Map();
  
  if (fetchChecksums) {
    // Fetch full metadata including checksums (slower but more accurate)
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
        
        // Skip 0-byte files
        if (size === 0) continue;
        
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
  } else {
    // Fast path: just use basic metadata (size and date)
    for (const file of files) {
      const name = file.name;
      const metadata = file.metadata || {};
      const updated = metadata.updated || metadata.timeCreated || new Date().toISOString();
      const size = Number(metadata.size || file.size || 0);
      
      // Skip 0-byte files
      if (size === 0) continue;
      
      fileMap.set(name, {
        name,
        updated: new Date(updated),
        size,
        md5Hash: null,
        crc32c: null,
        bucket: bucketName
      });
    }
  }
  
  return fileMap;
}

function filesAreIdentical(devFile, prodFile, useChecksum = false) {
  // Default: simple size comparison
  if (!useChecksum) {
    return devFile.size === prodFile.size && devFile.size > 0;
  }
  
  // Optional: Compare MD5 hash (more reliable but slower)
  if (devFile.md5Hash && prodFile.md5Hash) {
    return devFile.md5Hash === prodFile.md5Hash;
  }
  
  // Fallback to CRC32C if MD5 not available
  if (devFile.crc32c && prodFile.crc32c) {
    return devFile.crc32c === prodFile.crc32c;
  }
  
  // Final fallback: size comparison
  return devFile.size === prodFile.size && devFile.size > 0;
}

function compareFiles(devFiles, prodFiles, excludePatterns = [], prefixFilter = '', useChecksum = false) {
  const onlyInDev = [];
  const newerInDev = [];
  const newerInProd = [];
  let identicalCount = 0;
  
  // Check files in dev
  for (const [name, devFile] of devFiles) {
    // Skip 0-byte files
    if (devFile.size === 0) continue;
    
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
      if (filesAreIdentical(devFile, prodFile, useChecksum)) {
        identicalCount++;
        continue; // Skip identical files
      }
      
      // Files differ - compare dates only if not using checksum
      if (useChecksum) {
        // When using checksum, ignore dates - files are different if checksums don't match
        // We don't know which is "newer" based on checksum alone, so skip date comparison
        continue;
      }
      
      // Compare dates to determine which is newer
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
      } else if (prodFile.updated > devFile.updated) {
        newerInProd.push({
          name: prodFile.name,
          devUpdated: devFile.updated,
          prodUpdated: prodFile.updated,
          devSize: devFile.size,
          prodSize: prodFile.size,
          devMd5: devFile.md5Hash,
          prodMd5: prodFile.md5Hash,
          ageDiffMs: prodFile.updated.getTime() - devFile.updated.getTime(),
          ageDiffDays: Math.round((prodFile.updated.getTime() - devFile.updated.getTime()) / (1000 * 60 * 60 * 24))
        });
      }
    }
  }
  
  // Also check for files only in prod
  const onlyInProd = [];
  for (const [name, prodFile] of prodFiles) {
    // Skip 0-byte files
    if (prodFile.size === 0) continue;
    
    // Apply prefix filter
    if (prefixFilter && !name.startsWith(prefixFilter)) continue;
    
    // Skip excluded patterns
    if (shouldExclude(name, excludePatterns)) continue;
    
    if (!devFiles.has(name)) {
      // File only exists in prod
      onlyInProd.push(prodFile);
    }
  }
  
  return { onlyInDev, newerInDev, newerInProd, onlyInProd, identicalCount };
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
  const useChecksum = req.query.checksum === 'true' || req.query.checksum === '1';

  try {
    const storage = getStorageClient();
    if (!storage) {
      return res.status(500).json({ 
        success: false, 
        error: 'GCS credentials not available',
        message: 'Please configure GCP_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS'
      });
    }

    // Only fetch checksums if requested (saves time and API calls)
    const [devFiles, prodFiles] = await Promise.all([
      listAllFiles(storage, DEV_BUCKET, prefix, useChecksum),
      listAllFiles(storage, PROD_BUCKET, prefix, useChecksum)
    ]);

    const results = compareFiles(devFiles, prodFiles, excludePatterns, prefix, useChecksum);

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
      newerInProd: results.newerInProd.map(f => ({
        name: f.name,
        devUpdated: f.devUpdated.toISOString(),
        prodUpdated: f.prodUpdated.toISOString(),
        devSize: f.devSize,
        prodSize: f.prodSize,
        ageDiffDays: f.ageDiffDays
      })),
      onlyInProd: results.onlyInProd.map(f => ({
        name: f.name,
        updated: f.updated.toISOString(),
        size: f.size
      })),
      summary: {
        onlyInDevCount: results.onlyInDev.length,
        newerInDevCount: results.newerInDev.length,
        newerInProdCount: results.newerInProd.length,
        onlyInProdCount: results.onlyInProd.length,
        identicalCount: results.identicalCount,
        total: results.onlyInDev.length + results.newerInDev.length + results.newerInProd.length + results.onlyInProd.length
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
