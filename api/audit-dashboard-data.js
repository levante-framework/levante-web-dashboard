import { Storage } from '@google-cloud/storage';
import {
  getSessionSecret,
  parseCookies,
  parseSessionCookieValue,
  SESSION_COOKIE_NAME,
} from '../lib/server/github-auth.js';
import { checkGithubOrgMembershipByLogin } from '../lib/server/github-org-check.js';

let storageClient = null;
let firestoreAccessTokenCache = { token: null, expiresAt: 0 };

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

function inferEntityFromPath(path) {
  const normalized = String(path || '').trim().replace(/^\/+/, '');
  if (!normalized) return null;
  const match = normalized.match(/(?:^|\/)(sites|schools|districts|organizations|orgs|admins|users)\/([^/]+)/i);
  if (match) {
    return {
      kind: String(match[1]).toLowerCase(),
      id: String(match[2] || '').trim(),
      path: normalized,
    };
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return {
      kind: String(parts[0]).toLowerCase(),
      id: String(parts[1]).trim(),
      path: normalized,
    };
  }
  return {
    kind: 'unscoped',
    id: parts[0] || normalized,
    path: normalized,
  };
}

function parseServiceAccountCredentials() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const credentials = tryParseServiceAccountJson(raw);
  return credentials || null;
}

async function getFirestoreAccessToken() {
  const now = Date.now();
  if (firestoreAccessTokenCache.token && firestoreAccessTokenCache.expiresAt > now + 60_000) {
    return firestoreAccessTokenCache.token;
  }
  try {
    const credentials = parseServiceAccountCredentials();
    const { GoogleAuth } = await import('google-auth-library');
    const auth = credentials
      ? new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/datastore'] })
      : new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/datastore'] });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const token = tokenResponse?.token || tokenResponse || null;
    if (!token) return null;
    firestoreAccessTokenCache = {
      token: String(token),
      expiresAt: now + (50 * 60 * 1000),
    };
    return firestoreAccessTokenCache.token;
  } catch (error) {
    console.warn('audit-dashboard-data: unable to get Firestore access token', error?.message || error);
    return null;
  }
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return Number(value.doubleValue);
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.nullValue !== undefined) return null;
  if (value.arrayValue) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if (value.mapValue) {
    const out = {};
    const fields = value.mapValue.fields || {};
    for (const [key, nested] of Object.entries(fields)) out[key] = decodeFirestoreValue(nested);
    return out;
  }
  return value;
}

function normalizeSiteScope(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = String(candidate.id || candidate.siteId || '').trim();
  const name = String(candidate.name || candidate.siteName || '').trim();
  if (!id && !name) return null;
  return {
    kind: 'site',
    id: id || name,
    name: name || '',
    label: name && id ? `${name} (${id})` : (name || id),
  };
}

function pickUserSiteScope(userDoc) {
  const roles = Array.isArray(userDoc?.roles) ? userDoc.roles : [];
  for (const role of roles) {
    const scoped = normalizeSiteScope(role);
    if (scoped) return scoped;
  }
  const districtCurrent = Array.isArray(userDoc?.districts?.current) ? userDoc.districts.current : [];
  if (districtCurrent[0]) {
    return { kind: 'district', id: String(districtCurrent[0]), name: '', label: String(districtCurrent[0]) };
  }
  const schoolCurrent = Array.isArray(userDoc?.schools?.current) ? userDoc.schools.current : [];
  if (schoolCurrent[0]) {
    return { kind: 'school', id: String(schoolCurrent[0]), name: '', label: String(schoolCurrent[0]) };
  }
  const groupCurrent = Array.isArray(userDoc?.groups?.current) ? userDoc.groups.current : [];
  if (groupCurrent[0]) {
    return { kind: 'group', id: String(groupCurrent[0]), name: '', label: String(groupCurrent[0]) };
  }
  return null;
}

async function fetchUserScopeMap(projectId, userIds) {
  const ids = Array.from(new Set((userIds || []).map((id) => String(id || '').trim()).filter(Boolean)));
  const map = new Map();
  if (!projectId || ids.length === 0) return map;
  const token = await getFirestoreAccessToken();
  if (!token) return map;

  const concurrency = 8;
  for (let i = 0; i < ids.length; i += concurrency) {
    const slice = ids.slice(i, i + concurrency);
    await Promise.all(slice.map(async (userId) => {
      try {
        const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(userId)}`;
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) return;
        const doc = await response.json().catch(() => ({}));
        const fields = doc?.fields && typeof doc.fields === 'object' ? doc.fields : {};
        const decoded = {};
        for (const [fieldName, fieldValue] of Object.entries(fields)) {
          decoded[fieldName] = decodeFirestoreValue(fieldValue);
        }
        const scope = pickUserSiteScope(decoded);
        if (scope) map.set(userId, scope);
      } catch (_) {
        // Best-effort enrichment only.
      }
    }));
  }
  return map;
}

async function buildSiteRegressions(diff, { projectId } = {}) {
  const changed = [
    ...(Array.isArray(diff?.newIssueCodes) ? diff.newIssueCodes : []),
    ...(Array.isArray(diff?.increased) ? diff.increased : []),
  ];

  const userIdsToResolve = new Set();
  for (const issue of changed) {
    const samplePaths = Array.isArray(issue?.newSampleDocPaths)
      ? issue.newSampleDocPaths
      : (Array.isArray(issue?.sampleDocPaths) ? issue.sampleDocPaths : []);
    for (const path of samplePaths) {
      const entity = inferEntityFromPath(path);
      if (entity?.kind === 'users' && entity?.id) userIdsToResolve.add(entity.id);
    }
  }
  const userScopeMap = await fetchUserScopeMap(projectId, Array.from(userIdsToResolve));

  const groups = new Map();
  for (const issue of changed) {
    const code = String(issue?.code || 'UNKNOWN').trim();
    const delta = Number(issue?.delta || 0);
    const category = String(issue?.category || '').trim() || 'uncategorized';
    const samplePaths = Array.isArray(issue?.newSampleDocPaths)
      ? issue.newSampleDocPaths
      : (Array.isArray(issue?.sampleDocPaths) ? issue.sampleDocPaths : []);
    const normalizedPaths = Array.from(new Set(samplePaths.map((p) => String(p || '').trim()).filter(Boolean)));
    const entities = normalizedPaths.map((p) => inferEntityFromPath(p)).filter(Boolean);
    const resolvedScopes = entities.map((entity) => {
      if (entity.kind === 'users' && entity.id) {
        const scope = userScopeMap.get(entity.id);
        if (scope) return scope;
      }
      const kindMap = {
        users: 'user',
        admins: 'admin',
        schools: 'school',
        sites: 'site',
        districts: 'district',
        organizations: 'organization',
        orgs: 'organization',
      };
      return {
        kind: kindMap[entity.kind] || 'entity',
        id: entity.id || entity.path || 'unknown',
        name: '',
        label: entity.id || entity.path || 'unknown',
      };
    });
    const uniqueScopes = Array.from(new Map(
      resolvedScopes
        .filter(Boolean)
        .map((scope) => [`${scope.kind}/${scope.id}`, scope]),
    ).values());
    const targetScopes = uniqueScopes.length > 0
      ? uniqueScopes
      : [{ kind: 'unscoped', id: 'N/A', name: '', label: 'N/A' }];

    for (const scope of targetScopes) {
      const groupKey = `${scope.kind}/${scope.id}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          groupKey,
          scopeKind: scope.kind,
          scopeId: scope.id,
          scopeName: scope.name || '',
          scopeLabel: scope.label || scope.id,
          issueCount: 0,
          totalDelta: 0,
          categories: new Set(),
          regressions: [],
        });
      }
      const group = groups.get(groupKey);
      group.issueCount += 1;
      group.totalDelta += Number.isFinite(delta) ? delta : 0;
      group.categories.add(category);
      group.regressions.push({
        code,
        delta,
        category,
        baseline: Number.isFinite(Number(issue?.baseline)) ? Number(issue.baseline) : null,
        current: Number.isFinite(Number(issue?.current)) ? Number(issue.current) : null,
        samplePaths: normalizedPaths,
      });
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      groupKey: group.groupKey,
      scopeKind: group.scopeKind,
      scopeId: group.scopeId,
      scopeName: group.scopeName,
      scopeLabel: group.scopeLabel,
      issueCount: group.issueCount,
      totalDelta: group.totalDelta,
      categories: Array.from(group.categories).sort(),
      regressions: group.regressions,
    }))
    .sort((a, b) => {
      if (b.totalDelta !== a.totalDelta) return b.totalDelta - a.totalDelta;
      if (b.issueCount !== a.issueCount) return b.issueCount - a.issueCount;
      return String(a.scopeLabel || a.scopeId || '').localeCompare(String(b.scopeLabel || b.scopeId || ''));
    });
}

async function addCanonicalSiteRegressions(payload) {
  const envs = payload?.envs && typeof payload.envs === 'object' ? payload.envs : null;
  if (!envs) return payload;
  for (const envName of Object.keys(envs)) {
    const envData = envs[envName];
    if (!envData || typeof envData !== 'object') continue;
    const diff = envData.diff && typeof envData.diff === 'object' ? envData.diff : null;
    if (!diff) continue;
    diff.siteRegressions = await buildSiteRegressions(diff, { projectId: envData.projectId });
    diff.siteRegressionMetadata = {
      source: 'api-derived',
      derivedAt: new Date().toISOString(),
      groupingKey: 'site_scope_resolved',
    };
  }
  return payload;
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

    const parsed = await addCanonicalSiteRegressions(JSON.parse(String(buffer || '{}')));
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
