import { Storage } from '@google-cloud/storage';

const BUCKET_NAME = process.env.VALIDATION_BUCKET || process.env.TOOLS_BUCKET || 'levante-tools';
const PREFIX = process.env.LAYOUT_OVERRIDES_PREFIX || 'layout-overrides';
const REQUIRED_TOKEN = String(process.env.LAYOUT_EDITOR_TOKEN || '').trim();

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) return null;
  try {
    const credentials = JSON.parse(raw);
    return new Storage({ credentials });
  } catch (_) {
    return null;
  }
}

function safeKey(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function objectPath(pageKey, regionKey) {
  const safePage = safeKey(pageKey);
  const safeRegion = safeKey(regionKey);
  if (!safePage || !safeRegion) return '';
  return `${PREFIX}/${safePage}/${safeRegion}.json`;
}

function sanitizeHtml(html) {
  let out = String(html || '');
  out = out.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  out = out.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  out = out.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '');
  out = out.replace(/<embed\b[^>]*>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '');
  out = out.replace(/\s(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '');
  return out.trim();
}

async function readOverride(storage, pageKey, regionKey) {
  const path = objectPath(pageKey, regionKey);
  if (!path) return { exists: false, html: '', objectPath: '' };
  const file = storage.bucket(BUCKET_NAME).file(path);
  const [exists] = await file.exists();
  if (!exists) return { exists: false, html: '', objectPath: path };
  const [buf] = await file.download();
  let parsed = {};
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch (_) {
    parsed = {};
  }
  return {
    exists: true,
    html: String(parsed?.html || '').trim(),
    updatedAt: parsed?.updatedAt || '',
    updatedBy: parsed?.updatedBy || '',
    objectPath: path,
  };
}

async function writeOverride(storage, pageKey, regionKey, html, updatedBy) {
  const path = objectPath(pageKey, regionKey);
  if (!path) throw new Error('Invalid page or region key');
  const file = storage.bucket(BUCKET_NAME).file(path);
  const payload = {
    pageKey: safeKey(pageKey),
    regionKey: safeKey(regionKey),
    html,
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || '').trim(),
  };
  await file.save(JSON.stringify(payload, null, 2), {
    contentType: 'application/json',
    resumable: false,
  });
  return { objectPath: path, updatedAt: payload.updatedAt };
}

function isAuthorized(req) {
  if (!REQUIRED_TOKEN) return true;
  const tokenHeader = String(req.headers?.['x-layout-editor-token'] || '').trim();
  const tokenBody = String(req.body?.token || '').trim();
  return tokenHeader === REQUIRED_TOKEN || tokenBody === REQUIRED_TOKEN;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-layout-editor-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const storage = getStorageClient();
  if (!storage) {
    return res.status(200).json({ ok: false, reason: 'GCS credentials not configured', source: 'none' });
  }

  try {
    if (req.method === 'GET') {
      const pageKey = String(req.query?.page || '').trim();
      const regionKey = String(req.query?.region || '').trim();
      if (!pageKey || !regionKey) {
        return res.status(400).json({ ok: false, error: 'Missing query params: page, region' });
      }
      const data = await readOverride(storage, pageKey, regionKey);
      return res.status(200).json({
        ok: true,
        pageKey: safeKey(pageKey),
        regionKey: safeKey(regionKey),
        exists: data.exists,
        html: data.html,
        updatedAt: data.updatedAt || '',
        updatedBy: data.updatedBy || '',
        bucket: BUCKET_NAME,
        objectPath: data.objectPath,
      });
    }

    if (req.method === 'POST') {
      const pageKey = String(req.body?.page || '').trim();
      const regionKey = String(req.body?.region || '').trim();
      const updatedBy = String(req.body?.updatedBy || '').trim();
      const rawHtml = String(req.body?.html || '');
      if (!pageKey || !regionKey) {
        return res.status(400).json({ ok: false, error: 'Missing body fields: page, region' });
      }
      if (rawHtml.length > 100000) {
        return res.status(413).json({ ok: false, error: 'HTML payload too large' });
      }
      const html = sanitizeHtml(rawHtml);
      const { objectPath, updatedAt } = await writeOverride(storage, pageKey, regionKey, html, updatedBy);
      return res.status(200).json({
        ok: true,
        pageKey: safeKey(pageKey),
        regionKey: safeKey(regionKey),
        html,
        updatedAt,
        bucket: BUCKET_NAME,
        objectPath,
      });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
}

