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
  // Try as-is first (matches how Vercel env values are typically stored).
  try {
    return JSON.parse(base);
  } catch (_) {}
  // Fallback for values wrapped in quotes or with escaped newlines.
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
        console.warn('audit-dashboard-data: service account JSON parse failed');
        return null;
      }
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
      const fallback = '/audit-dashboard.html';
      let loginReturnTo = fallback;
      const referer = String(req?.headers?.referer || '').trim();
      if (referer) {
        try {
          const parsed = new URL(referer);
          if (parsed.pathname && parsed.pathname.startsWith('/')) loginReturnTo = parsed.pathname;
        } catch (_) {}
      }
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Authentication is required to access audit dashboard data.',
        loginUrl: `/api/auth-github-start?returnTo=${encodeURIComponent(loginReturnTo)}`,
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
      viewer: session
        ? {
            login: String(session.login || ''),
            orgs: Array.isArray(session.orgs) ? session.orgs : [],
          }
        : null,
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
