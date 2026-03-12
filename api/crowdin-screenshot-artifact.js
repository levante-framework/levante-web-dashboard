import { Storage } from '@google-cloud/storage';

const BUCKET_NAME = process.env.DASHBOARD_DATA_BUCKET || 'levante-dashboard-dev';
const PREFIX = process.env.CROWDIN_SCREENSHOT_ARTIFACT_PREFIX || 'pitwall/crowdin';
const OBJECT_NAME = process.env.CROWDIN_SCREENSHOT_ARTIFACT_OBJECT || 'crowdin-screenshot-artifact.json';
const CACHE_BUCKET = process.env.CROWDIN_SCREENSHOT_CACHE_BUCKET || 'levante-assets-draft';
const CACHE_PREFIX = process.env.CROWDIN_SCREENSHOT_CACHE_PREFIX || 'screenshots';
const CACHE_PUBLIC_BASE = process.env.CROWDIN_SCREENSHOT_CACHE_PUBLIC_BASE || `https://storage.googleapis.com/${CACHE_BUCKET}`;
const CROWDIN_API_BASE = 'https://api.crowdin.com/api/v2';
const DEFAULT_PROJECT_ID = '756721';

function normalizePrefix(prefix) {
  if (!prefix) return '';
  return String(prefix).endsWith('/') ? String(prefix) : `${String(prefix)}/`;
}

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON is not set');
  }
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (_e) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  return new Storage({ credentials });
}

function extractScreenshotUrl(screenshotData) {
  return String(
    screenshotData?.thumbnailUrl ||
    screenshotData?.previewUrl ||
    screenshotData?.url ||
    screenshotData?.webUrl ||
    screenshotData?.imageUrl ||
    ''
  ).trim();
}

async function resolveScreenshotUrl(projectId, screenshotId, token) {
  const url = `${CROWDIN_API_BASE}/projects/${encodeURIComponent(projectId)}/screenshots/${encodeURIComponent(screenshotId)}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Crowdin screenshot lookup failed: ${response.status} ${body}`);
  }
  const payload = await response.json();
  return extractScreenshotUrl(payload?.data || {});
}

async function resolveCachedScreenshotUrl(storage, screenshotId) {
  const safePrefix = normalizePrefix(CACHE_PREFIX);
  const extensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
  const bucket = storage.bucket(CACHE_BUCKET);
  for (const ext of extensions) {
    const objectPath = `${safePrefix}${screenshotId}${ext}`;
    const [exists] = await bucket.file(objectPath).exists();
    if (!exists) continue;
    return `${String(CACHE_PUBLIC_BASE || '').replace(/\/+$/, '')}/${objectPath}`;
  }
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const objectPath = `${normalizePrefix(PREFIX)}${OBJECT_NAME}`;
  try {
    const screenshotId = String(req.query?.screenshotId || '').trim();
    if (screenshotId) {
      const fallbackUrl = String(req.query?.fallbackUrl || '').trim();
      try {
        const storage = getStorageClient();
        const cachedUrl = await resolveCachedScreenshotUrl(storage, screenshotId);
        if (cachedUrl) {
          res.setHeader('x-screenshot-source', 'cache');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.redirect(302, cachedUrl);
        }
      } catch (cacheLookupError) {
        console.warn('crowdin-screenshot cache lookup warning:', cacheLookupError?.message || cacheLookupError);
      }

      const token = String(process.env.CROWDIN_API_TOKEN || '').trim();
      const projectId = String(process.env.LEVANTE_TRANSLATIONS_PROJECT_ID || DEFAULT_PROJECT_ID).trim();
      if (!token) {
        if (fallbackUrl) {
          res.setHeader('x-screenshot-source', 'fallback');
          return res.redirect(302, fallbackUrl);
        }
        return res.status(500).json({ success: false, error: 'CROWDIN_API_TOKEN is not set' });
      }
      try {
        const liveUrl = await resolveScreenshotUrl(projectId, screenshotId, token);
        if (!liveUrl) {
          if (fallbackUrl) {
            res.setHeader('x-screenshot-source', 'fallback');
            return res.redirect(302, fallbackUrl);
          }
          return res.status(404).json({ success: false, error: 'Screenshot URL not found' });
        }
        res.setHeader('x-screenshot-source', 'crowdin');
        res.setHeader('Cache-Control', 'public, max-age=1800');
        return res.redirect(302, liveUrl);
      } catch (error) {
        if (fallbackUrl) {
          res.setHeader('x-screenshot-source', 'fallback');
          return res.redirect(302, fallbackUrl);
        }
        return res.status(500).json({ success: false, error: error?.message || 'Failed to resolve screenshot URL' });
      }
    }

    const storage = getStorageClient();
    const file = storage.bucket(BUCKET_NAME).file(objectPath);
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(200).json({
        success: false,
        entries: [],
        error: `No screenshot artifact found at gs://${BUCKET_NAME}/${objectPath}`,
      });
    }
    const [contents] = await file.download();
    const json = JSON.parse(contents.toString('utf8'));
    return res.status(200).json({ success: true, ...json });
  } catch (error) {
    console.warn('crowdin-screenshot-artifact API warning:', error?.message || error);
    return res.status(200).json({
      success: false,
      entries: [],
      error: error?.message || 'Unknown error',
    });
  }
}

