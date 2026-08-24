import { Storage } from '@google-cloud/storage';
import {
  getSessionSecret,
  parseCookies,
  parseSessionCookieValue,
  SESSION_COOKIE_NAME,
} from '../lib/server/github-auth.js';
import { checkGithubOrgMembershipByLogin } from '../lib/server/github-org-check.js';

let storageClient = null;

const SKIP_HEADINGS = new Set([
  'entry template',
  'entry template (for appends)',
  'issue-id',
]);

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
        console.warn('bug-log-data: service account JSON parse failed');
        return null;
      }
      storageClient = new Storage({ credentials, projectId: credentials.project_id });
      return storageClient;
    }
    storageClient = new Storage();
    return storageClient;
  } catch (error) {
    console.warn('bug-log-data: failed to initialize storage', error?.message || error);
    return null;
  }
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function splitTableRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|')) return null;
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim());
}

function extractIdFromCell(cell) {
  const text = String(cell || '').trim();
  const link = text.match(/\[([^\]]+)\]\((#[^)]+)\)/);
  if (link) {
    return {
      id: link[1].trim(),
      slug: String(link[2] || '').replace(/^#/, '').trim() || slugify(link[1]),
    };
  }
  const id = text.replace(/[`\[\]]/g, '').trim();
  return { id, slug: slugify(id) };
}

function parseBulletField(text, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`^- \\*\\*${escaped}:\\*\\*\\s*(.+)$`, 'im'));
  return match ? match[1].trim() : '';
}

function extractLinkUrl(markdown) {
  const match = String(markdown || '').match(/\((https?:\/\/[^)\s]+)\)/);
  return match ? match[1] : '';
}

function parseIndexRows(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const rows = [];
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith('## ')) break;
    const cells = splitTableRow(line);
    if (!cells) {
      if (inTable) break;
      continue;
    }
    const joined = cells.join('').replace(/\|/g, '');
    if (/^[-:\s]+$/.test(joined)) continue;
    if (/^id$/i.test(cells[0] || '')) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    const { id, slug } = extractIdFromCell(cells[0]);
    if (!id) continue;
    rows.push({
      id,
      slug,
      lastUpdated: cells[1] || '',
      assessment: cells[2] || '',
      oneLiner: cells[3] || '',
      status: cells[4] || '',
    });
  }
  return rows;
}

function parseSectionBody(body) {
  const text = String(body || '');
  const parts = text.split(/^### /m);
  const preamble = parts[0] || '';
  const followUps = [];
  const subsections = {};
  for (let i = 1; i < parts.length; i += 1) {
    const block = parts[i];
    const newline = block.indexOf('\n');
    const title = (newline === -1 ? block : block.slice(0, newline)).trim();
    const content = (newline === -1 ? '' : block.slice(newline + 1)).trim();
    if (/^follow-up/i.test(title)) {
      followUps.push({ title, body: content });
    } else {
      subsections[title.toLowerCase()] = content;
    }
  }
  const assessmentRaw = subsections.assessment || '';
  const assessmentMatch = assessmentRaw.match(/Assessment:\s*([^`\n]+)/i);
  return {
    sentry: parseBulletField(preamble, 'Sentry'),
    sentryUrl: extractLinkUrl(parseBulletField(preamble, 'Sentry')),
    error: parseBulletField(preamble, 'Error'),
    where: parseBulletField(preamble, 'Where'),
    github: parseBulletField(preamble, 'GitHub'),
    environment: parseBulletField(preamble, 'Environment'),
    analyzed: parseBulletField(preamble, 'Analyzed'),
    assessmentDetail: (assessmentMatch ? assessmentMatch[1] : assessmentRaw).replace(/`/g, '').trim(),
    rootCause: subsections['root cause'] || '',
    impact: subsections['impact / data'] || subsections.impact || '',
    actions: subsections['actions taken'] || '',
    statusDetail: subsections.status || '',
    followUps,
    bodyMarkdown: text.trim(),
  };
}

function parseBugLogMarkdown(markdown) {
  const source = String(markdown || '');
  const indexRows = parseIndexRows(source);
  const byId = new Map();
  for (const row of indexRows) {
    byId.set(row.id.toUpperCase(), {
      ...row,
      sentry: '',
      sentryUrl: '',
      error: '',
      where: '',
      github: '',
      environment: '',
      analyzed: '',
      rootCause: '',
      impact: '',
      actions: '',
      followUps: [],
      bodyMarkdown: '',
    });
  }

  const headingRe = /^## (.+)$/gm;
  const matches = [];
  let match = headingRe.exec(source);
  while (match) {
    matches.push({ title: match[1].trim(), start: match.index, headingEnd: match.index + match[0].length });
    match = headingRe.exec(source);
  }

  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const titleKey = current.title.toLowerCase();
    if (SKIP_HEADINGS.has(titleKey)) continue;
    const end = i + 1 < matches.length ? matches[i + 1].start : source.length;
    const body = source.slice(current.headingEnd, end).replace(/^\n+/, '');
    const parsed = parseSectionBody(body);
    const id = current.title.trim();
    const key = id.toUpperCase();
    const existing = byId.get(key);
    const next = {
      id,
      slug: existing?.slug || slugify(id),
      lastUpdated: existing?.lastUpdated || parsed.analyzed || '',
      assessment: existing?.assessment || parsed.assessmentDetail || '',
      oneLiner: existing?.oneLiner || parsed.error || '',
      status: existing?.status || parsed.statusDetail || '',
      ...parsed,
    };
    if (existing?.assessment) next.assessment = existing.assessment;
    if (existing?.status) next.status = existing.status;
    byId.set(key, next);
  }

  return Array.from(byId.values());
}

function loginReturnToFromReferer(req, fallback) {
  const referer = String(req?.headers?.referer || '').trim();
  if (!referer) return fallback;
  try {
    const parsed = new URL(referer);
    if (!parsed.pathname || !parsed.pathname.startsWith('/')) return fallback;
    const params = new URLSearchParams(parsed.search);
    ['auth', 'authError', 'authSsoUrl', 'authHelpUrl', 'authActionLabel'].forEach((key) => params.delete(key));
    const query = params.toString();
    return query ? `${parsed.pathname}?${query}` : parsed.pathname;
  } catch (_) {
    return fallback;
  }
}

export { parseBugLogMarkdown };

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
      const loginReturnTo = loginReturnToFromReferer(req, '/bug-log.html');
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Authentication is required to access the bug log.',
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

  const bucketName = String(process.env.BUG_LOG_BUCKET || 'levante-tools').trim();
  const objectName = String(process.env.BUG_LOG_OBJECT || 'support/bug-analysis-history.md')
    .trim()
    .replace(/^\/+/, '');

  if (!bucketName || !objectName) {
    return res.status(500).json({
      success: false,
      error: 'invalid_configuration',
      message: 'BUG_LOG_BUCKET and BUG_LOG_OBJECT must be configured.',
    });
  }

  try {
    const file = storage.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: `No bug log found at gs://${bucketName}/${objectName}`,
      });
    }

    const [buffer, metadata] = await Promise.all([
      file.download().then(([data]) => data),
      file.getMetadata().then(([info]) => info).catch(() => null),
    ]);

    const issues = parseBugLogMarkdown(String(buffer || ''));
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
        updated: metadata?.updated || null,
        generation: metadata?.generation || null,
      },
      issues,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'read_failed',
      message: error?.message || String(error),
    });
  }
}
