/**
 * Visual Assets Fix API
 * Converts PNGs under visual/ in levante-assets-(dev|prod) to WEBP when missing.
 */

import { Storage } from '@google-cloud/storage';
import sharp from 'sharp';

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

async function listMissingWebp(storage, bucketName, prefix) {
  const bucket = storage.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
  const names = files.map(f => f.name);
  const nameSet = new Set(names.map(n => n.toLowerCase()));
  const pngs = names.filter(n => n.toLowerCase().endsWith('.png'));
  const missing = [];
  for (const p of pngs) {
    const webpCandidate = p.replace(/\.png$/i, '.webp').toLowerCase();
    if (!nameSet.has(webpCandidate)) missing.push(p);
  }
  return missing;
}

async function convertPngToWebp(storage, bucketName, pngPath, quality = 80) {
  const bucket = storage.bucket(bucketName);
  const pngFile = bucket.file(pngPath);
  const webpPath = pngPath.replace(/\.png$/i, '.webp');
  const webpFile = bucket.file(webpPath);
  const [buf] = await pngFile.download();
  const webpBuf = await sharp(buf).webp({ quality }).toBuffer();
  await webpFile.save(webpBuf, { contentType: 'image/webp', resumable: false });
  return webpPath;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const env = (req.query.env || 'dev').toString().toLowerCase();
  const prefix = (req.query.prefix || 'visual/').toString();
  const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
  const bucketName = env === 'prod' ? 'levante-assets-prod' : 'levante-assets-dev';

  try {
    const storage = getStorageClient();
    if (!storage) {
      return res.status(400).json({ success: false, error: 'Missing GCS credentials' });
    }

    const missing = await listMissingWebp(storage, bucketName, prefix);
    const toProcess = missing.slice(0, limit);
    const successes = [];
    const failures = [];

    // Limit concurrency to 5
    const concurrency = 3;
    let index = 0;
    async function worker() {
      while (index < toProcess.length) {
        const i = index++;
        const pngPath = toProcess[i];
        try {
          const out = await convertPngToWebp(storage, bucketName, pngPath);
          successes.push({ png: pngPath, webp: out });
        } catch (e) {
          const code = e && (e.code || e.statusCode || e.status);
          const message = e && e.message ? e.message : String(e);
          failures.push({ png: pngPath, code, error: message });
        }
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, toProcess.length) }, () => worker());
    await Promise.all(workers);

    // Summarize frequent failure reasons (top 3)
    const reasonCounts = failures.reduce((acc, f) => { const k = (f.code || f.error || 'unknown').toString(); acc[k] = (acc[k]||0)+1; return acc; }, {});
    const topReasons = Object.entries(reasonCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([reason,count])=>({ reason, count }));

    return res.status(200).json({
      success: true,
      bucket: bucketName,
      prefix,
      attempted: toProcess.length,
      created: successes.length,
      failed: failures.length,
      remainingEstimate: Math.max(0, missing.length - toProcess.length),
      successes,
      failures,
      topReasons,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('visual-fix error:', error);
    return res.status(500).json({ success: false, error: 'Internal error', message: error.message });
  }
}


