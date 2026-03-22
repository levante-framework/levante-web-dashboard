import { Storage } from '@google-cloud/storage';
import {
  getSessionSecret,
  parseCookies,
  parseSessionCookieValue,
  SESSION_COOKIE_NAME,
} from '../lib/server/github-auth.js';
import { checkGithubOrgMembershipByLogin } from '../lib/server/github-org-check.js';

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

function tryParseServiceAccountJson(raw) {
  const base = String(raw || '').trim();
  if (!base) return null;
  try {
    return JSON.parse(base);
  } catch (_) {}
  try {
    return JSON.parse(normalizeCredentialJson(base));
  } catch (_) {}
  return null;
}

function getStorage() {
  if (storageClient) return storageClient;
  try {
    const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (raw) {
      const credentials = tryParseServiceAccountJson(raw);
      if (!credentials) {
        console.warn('audit-dashboard-files: service account JSON parse failed');
        return null;
      }
      storageClient = new Storage({ credentials, projectId: credentials.project_id });
      return storageClient;
    }
    storageClient = new Storage();
    return storageClient;
  } catch (error) {
    console.warn('audit-dashboard-files: failed to initialize storage', error?.message || error);
    return null;
  }
}

function buildLoginUrl(req) {
  const fallback = '/audit-dashboard.html';
  let loginReturnTo = fallback;
  const referer = String(req?.headers?.referer || '').trim();
  if (referer) {
    try {
      const parsed = new URL(referer);
      if (parsed.pathname && parsed.pathname.startsWith('/')) loginReturnTo = parsed.pathname;
    } catch (_) {}
  }
  return `/api/auth-github-start?returnTo=${encodeURIComponent(loginReturnTo)}`;
}

function normalizePrefix(value) {
  const trimmed = String(value || '').trim().replace(/^\/+/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function isAllowedPath(path, prefix) {
  const normalizedPath = String(path || '').trim().replace(/^\/+/, '');
  if (!normalizedPath || !prefix) return false;
  if (!normalizedPath.startsWith(prefix)) return false;
  return normalizedPath.endsWith('.json');
}

function sanitizeFilename(path) {
  const leaf = String(path || '').split('/').pop() || 'report.json';
  return leaf.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  }

  const requiresAuth = parseBoolean(process.env.AUDIT_DASHBOARD_REQUIRE_AUTH, true);
  const allowedOrgs = String(process.env.AUDIT_DASHBOARD_ALLOWED_ORGS || 'levante-framework')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  let session = null;
  if (requiresAuth) {
    const secret = getSessionSecret();
    if (!secret) {
      return res.status(500).json({
        success: false,
        error: 'missing_session_secret',
        message: 'Missing AUTH_SESSION_SECRET (or GITHUB_AUTH_SESSION_SECRET).',
      });
    }
    const cookies = parseCookies(req);
    const rawSession = cookies[SESSION_COOKIE_NAME];
    session = parseSessionCookieValue(rawSession, secret);
    if (!session) {
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Authentication is required to access audit dashboard files.',
        loginUrl: buildLoginUrl(req),
      });
    }
    if (allowedOrgs.length > 0) {
      const login = String(session.login || '').trim();
      if (!login) {
        return res.status(403).json({
          success: false,
          error: 'forbidden',
          message: 'Authenticated session missing GitHub login for org membership verification.',
          requiredOrgs: allowedOrgs,
        });
      }
      let allowed = false;
      let lastCheckError = null;
      for (const org of allowedOrgs) {
        try {
          const check = await checkGithubOrgMembershipByLogin(login, org);
          if (check.success && check.allowed) {
            allowed = true;
            break;
          }
          if (!check.success) {
            lastCheckError = check.message || check.error || 'membership_check_failed';
          }
        } catch (error) {
          lastCheckError = error?.message || String(error);
        }
      }
      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'forbidden',
          message: `This endpoint requires membership in one of: ${allowedOrgs.join(', ')}`,
          requiredOrgs: allowedOrgs,
          memberLogin: login,
          membershipCheckError: lastCheckError || null,
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
  const prefix = normalizePrefix(
    process.env.AUDIT_DASHBOARD_DOWNLOAD_PREFIX || process.env.AUDIT_DASHBOARD_OBJECT || 'pitwall/audit-mini-dashboard',
  ).replace(/dashboard-data\.json\/?$/, '');

  if (!bucketName || !prefix) {
    return res.status(500).json({
      success: false,
      error: 'invalid_configuration',
      message: 'AUDIT_DASHBOARD_BUCKET and AUDIT_DASHBOARD_DOWNLOAD_PREFIX must be configured.',
    });
  }

  const action = String(req.query?.action || 'list').trim().toLowerCase();
  const bucket = storage.bucket(bucketName);

  if (action === 'download') {
    const path = String(req.query?.path || '').trim();
    if (!isAllowedPath(path, prefix)) {
      return res.status(400).json({
        success: false,
        error: 'invalid_path',
        message: `Path must start with ${prefix} and end with .json`,
      });
    }
    try {
      const file = bucket.file(path);
      const [exists] = await file.exists();
      if (!exists) {
        return res.status(404).json({ success: false, error: 'not_found', message: 'Requested file not found.' });
      }
      const filename = sanitizeFilename(path);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      file.createReadStream()
        .on('error', (error) => {
          if (!res.headersSent) {
            res.status(500).json({
              success: false,
              error: 'download_failed',
              message: error?.message || String(error),
            });
          } else {
            res.end();
          }
        })
        .pipe(res);
      return;
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: 'download_failed',
        message: error?.message || String(error),
      });
    }
  }

  try {
    const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
    const jsonFiles = files
      .map((file) => ({
        path: String(file?.name || ''),
        updatedAt: file?.metadata?.updated || file?.metadata?.timeCreated || null,
        size: Number(file?.metadata?.size || 0),
      }))
      .filter((entry) => entry.path.endsWith('.json'))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    return res.status(200).json({
      success: true,
      bucket: bucketName,
      prefix,
      viewer: session
        ? {
            login: String(session.login || ''),
            orgs: Array.isArray(session.orgs) ? session.orgs : [],
          }
        : null,
      files: jsonFiles,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'list_failed',
      message: error?.message || String(error),
    });
  }
}
