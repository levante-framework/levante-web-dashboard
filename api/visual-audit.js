/**
 * Visual Assets Audit API
 * Lists all PNG files under visual/ in levante-assets-(dev|prod) and reports those lacking WEBP counterparts.
 */

import { Storage } from '@google-cloud/storage';

function getStorageClient() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!serviceAccountJson) return null;
  try {
    const credentials = JSON.parse(serviceAccountJson);
    return new Storage({ credentials });
  } catch (e) {
    console.warn('GCS credentials env is not valid JSON');
    return null;
  }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const env = (req.query.env || 'dev').toString().toLowerCase();
  const prefix = (req.query.prefix || 'visual/').toString();
  const bucketName = env === 'prod' ? 'levante-assets-prod' : 'levante-assets-dev';

  try {
    const storage = getStorageClient();
    if (!storage) {
      return res.status(200).json({
        success: true,
        source: 'memory',
        message: 'No GCS credentials; returning empty audit.',
        bucket: bucketName,
        prefix,
        pngCount: 0,
        webpCount: 0,
        missingCount: 0,
        missing: [],
        gifCount: 0,
        gifSizeBytes: 0,
        gifWebpCount: 0,
        gifWebpSizeBytes: 0,
        gifSavingsBytes: 0,
        gifMissingCount: 0,
        timestamp: new Date().toISOString()
      });
    }

    const bucket = storage.bucket(bucketName);
    // List all files under prefix
    const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
    const names = files.map(f => f.name);
    const nameSet = new Set(names.map(n => n.toLowerCase()));
    const fileMap = new Map();
    for (const file of files) {
      fileMap.set(file.name.toLowerCase(), file);
    }

    const pngs = names.filter(n => n.toLowerCase().endsWith('.png'));
    const webps = names.filter(n => n.toLowerCase().endsWith('.webp'));
    const gifs = names.filter(n => n.toLowerCase().endsWith('.gif'));

    const getFileSize = (fileOrName) => {
      if (!fileOrName) return 0;
      const file = typeof fileOrName === 'string' ? fileMap.get(fileOrName.toLowerCase()) : fileOrName;
      if (!file) return 0;
      const metadataSize = Number(file.metadata?.size);
      if (Number.isFinite(metadataSize)) return metadataSize;
      if (typeof file.size === 'number' && Number.isFinite(file.size)) return file.size;
      return 0;
    };

    let gifSizeBytes = 0;
    let gifWebpCount = 0;
    let gifWebpSizeBytes = 0;
    let gifMissingCount = 0;
    for (const gifName of gifs) {
      gifSizeBytes += getFileSize(gifName);
      const candidate = gifName.replace(/\.gif$/i, '.webp').toLowerCase();
      const matchingWebp = fileMap.get(candidate);
      if (matchingWebp) {
        gifWebpCount += 1;
        gifWebpSizeBytes += getFileSize(matchingWebp);
      } else {
        gifMissingCount += 1;
      }
    }
    const gifSavingsBytes = Math.max(0, gifSizeBytes - gifWebpSizeBytes);

    const missing = [];
    for (const p of pngs) {
      const webpCandidate = p.replace(/\.png$/i, '.webp').toLowerCase();
      if (!nameSet.has(webpCandidate)) {
        missing.push(p);
      }
    }

    return res.status(200).json({
      success: true,
      bucket: bucketName,
      prefix,
      pngCount: pngs.length,
      webpCount: webps.length,
      missingCount: missing.length,
      missing,
      gifCount: gifs.length,
      gifSizeBytes,
      gifWebpCount,
      gifWebpSizeBytes,
      gifSavingsBytes,
      gifMissingCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('visual-audit error:', error);
    return res.status(500).json({ success: false, error: 'Internal error', message: error.message });
  }
}


