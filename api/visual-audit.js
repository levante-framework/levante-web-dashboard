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
        timestamp: new Date().toISOString()
      });
    }

    const bucket = storage.bucket(bucketName);
    // List all files under prefix
    const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
    const names = files.map(f => f.name);
    const nameSet = new Set(names.map(n => n.toLowerCase()));

    const pngs = names.filter(n => n.toLowerCase().endsWith('.png'));
    const webps = names.filter(n => n.toLowerCase().endsWith('.webp'));

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
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('visual-audit error:', error);
    return res.status(500).json({ success: false, error: 'Internal error', message: error.message });
  }
}


