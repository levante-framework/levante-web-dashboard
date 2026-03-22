import { Storage } from '@google-cloud/storage';
import {
  getSessionSecret,
  parseCookies,
  parseSessionCookieValue,
  SESSION_COOKIE_NAME,
} from '../lib/server/github-auth.js';

let storageClient = null;

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeCredentialJson(raw) {
  let normalized = String(raw || '').trim();
  if (!normalized) return '';
  if ((normalized.startsWith('"') && normalized.endsWith('"'))
    || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\\n/g, '\n');
}

function getStorage() {
  if (storageClient) return storageClient;
  try {
    const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (raw) {
      const credentials = JSON.parse(normalizeCredentialJson(raw));
      storageClient = new Storage({ credentials, projectId: credentials.project_id });
      return storageClient;
    }
    storageClient = new Storage();
    return storageClient;
  } catch (error) {
    console.warn('audit-dashboard-data: failed to initialize storage', error?.message || error);
    return null;
  }
}

function parseAllowedOrgs() {
  return String(process.env.AUDIT_DASHBOARD_ALLOWED_ORGS || 'levante-framework')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function getSession(req) {
  const secret = getSessionSecret();
  if (!secret) {
    return { session: null, hasSecret: false };
  }
  const cookies = parseCookies(req);
  const rawSession = cookies[SESSION_COOKIE_NAME];
  const session = parseSessionCookieValue(rawSession, secret);
  return { session, hasSecret: true };
}

function getLoginUrl(req) {
  const currentPath = String(req?.url || '/audit-dashboard.html').split('?')[0] || '/audit-dashboard.html';
  return `/api/auth-github-start?returnTo=${encodeURIComponent(currentPath)}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  }

  const requiresAuth = parseBoolean(process.env.AUDIT_DASHBOARD_REQUIRE_AUTH, true);
  if (requiresAuth) {
    const { session, hasSecret } = getSession(req);
    if (!hasSecret) {
      return res.status(500).json({
        success: false,
        error: 'missing_session_secret',
        message: 'Missing AUTH_SESSION_SECRET (or GITHUB_AUTH_SESSION_SECRET).',
      });
    }
    if (!session) {
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Authentication is required to access audit dashboard data.',
        loginUrl: getLoginUrl(req),
      });
    }

    const allowedOrgs = parseAllowedOrgs();
    if (allowedOrgs.length > 0) {
      const sessionOrgs = Array.isArray(session.orgs)
        ? session.orgs.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
        : [];
      const allowed = sessionOrgs.some((org) => allowedOrgs.includes(org));
      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'forbidden',
          message: `This endpoint requires membership in one of: ${allowedOrgs.join(', ')}`,
        });
      }
    }
  }

  const storage = getStorage();
  if (!storage) {
    return res.status(500).json({
      success: false,
      error: 'storage_unavailable',
      message: 'Could not initialize Google Cloud Storage client.',
    });
  }

  const bucketName = String(process.env.AUDIT_DASHBOARD_BUCKET || 'levante-tools').trim();
  const objectName = String(
    process.env.AUDIT_DASHBOARD_OBJECT || 'pitwall/audit-mini-dashboard/dashboard-data.json',
  ).trim().replace(/^\/+/, '');

  if (!bucketName || !objectName) {
    return res.status(500).json({
      success: false,
      error: 'invalid_configuration',
      message: 'AUDIT_DASHBOARD_BUCKET and AUDIT_DASHBOARD_OBJECT must be configured.',
    });
  }

  try {
    const file = storage.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: `No audit dashboard data found at gs://${bucketName}/${objectName}`,
      });
    }

    const [buffer, metadata] = await Promise.all([
      file.download().then(([data]) => data),
      file.getMetadata().then(([info]) => info).catch(() => null),
    ]);

    const parsed = JSON.parse(String(buffer || '{}'));
    return res.status(200).json({
      success: true,
      source: {
        bucket: bucketName,
        object: objectName,
        updatedAt: metadata?.updated || null,
        generation: metadata?.generation || null,
      },
      data: parsed,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'read_failed',
      message: error?.message || String(error),
    });
  }
}
