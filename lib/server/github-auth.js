import crypto from 'crypto';

export const SESSION_COOKIE_NAME = 'levante_auth_session';
const STATE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function hmacSha256(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function parseCookies(req) {
  const raw = String(req?.headers?.cookie || '');
  if (!raw) return {};
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const idx = item.indexOf('=');
      if (idx <= 0) return acc;
      const key = decodeURIComponent(item.slice(0, idx).trim());
      const value = decodeURIComponent(item.slice(idx + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

export function serializeCookie(name, value, options = {}) {
  const {
    httpOnly = true,
    secure = true,
    sameSite = 'Lax',
    path = '/',
    maxAge,
    expires
  } = options;
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(String(value ?? ''))}`];
  if (Number.isFinite(Number(maxAge))) parts.push(`Max-Age=${Math.max(0, Math.floor(Number(maxAge)))}`);
  if (expires instanceof Date) parts.push(`Expires=${expires.toUTCString()}`);
  if (path) parts.push(`Path=${path}`);
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push('Secure');
  if (httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

export function getSessionSecret() {
  const secret = String(
    process.env.AUTH_SESSION_SECRET
    || process.env.GITHUB_AUTH_SESSION_SECRET
    || process.env.GITHUB_CLIENT_SECRET
    || ''
  ).trim();
  if (!secret) return null;
  return secret;
}

export function getRequestOrigin(req) {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  if (!host) return null;
  return `${proto}://${host}`;
}

export function isSecureRequest(req) {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (forwardedProto) return forwardedProto === 'https';
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

export function sanitizeReturnTo(value, fallback = '/') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//')) return fallback;
  return raw;
}

export function createSignedToken(payload, secret) {
  const body = base64UrlEncode(JSON.stringify(payload || {}));
  const signature = hmacSha256(body, secret);
  return `${body}.${signature}`;
}

export function verifySignedToken(token, secret) {
  try {
    const raw = String(token || '').trim();
    if (!raw.includes('.')) return null;
    const [body, signature] = raw.split('.');
    if (!body || !signature) return null;
    const expected = hmacSha256(body, secret);
    const sigA = Buffer.from(signature);
    const sigB = Buffer.from(expected);
    if (sigA.length !== sigB.length) return null;
    if (!crypto.timingSafeEqual(sigA, sigB)) return null;
    const parsed = JSON.parse(base64UrlDecode(body));
    if (parsed?.exp && Number.isFinite(Number(parsed.exp))) {
      if (Math.floor(Date.now() / 1000) >= Number(parsed.exp)) return null;
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

export function createOauthStateToken({ returnTo = '/' }, secret) {
  const now = Math.floor(Date.now() / 1000);
  return createSignedToken({
    typ: 'oauth_state',
    iat: now,
    exp: now + STATE_TTL_SECONDS,
    nonce: crypto.randomBytes(8).toString('hex'),
    returnTo: sanitizeReturnTo(returnTo)
  }, secret);
}

export function verifyOauthStateToken(stateToken, secret) {
  const parsed = verifySignedToken(stateToken, secret);
  if (!parsed || parsed.typ !== 'oauth_state') return null;
  return parsed;
}

export function createSessionCookieValue(profile, secret) {
  const now = Math.floor(Date.now() / 1000);
  return createSignedToken({
    typ: 'session',
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
    ...profile
  }, secret);
}

export function parseSessionCookieValue(rawCookieValue, secret) {
  const parsed = verifySignedToken(rawCookieValue, secret);
  if (!parsed || parsed.typ !== 'session') return null;
  return parsed;
}

export function getGithubAuthConfig(req) {
  const clientId = String(process.env.GITHUB_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GITHUB_CLIENT_SECRET || '').trim();
  const origin = getRequestOrigin(req) || String(process.env.PUBLIC_BASE_URL || '').trim();
  const redirectUri = String(process.env.GITHUB_OAUTH_REDIRECT_URI || '').trim()
    || (origin ? `${origin}/api/auth-github-callback` : '');
  return {
    clientId,
    clientSecret,
    redirectUri,
    scope: String(process.env.GITHUB_OAUTH_SCOPE || 'read:user user:email read:org').trim()
  };
}

export async function exchangeGithubCodeForAccessToken({ code, clientId, clientSecret, redirectUri }) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'levante-web-dashboard-auth'
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    const message = payload?.error_description || payload?.error || `GitHub token exchange failed (${response.status})`;
    throw new Error(message);
  }
  return String(payload.access_token).trim();
}

async function githubGet(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'levante-web-dashboard-auth'
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GitHub API ${path} failed (${response.status}): ${text}`);
  }
  return response.json();
}

async function githubGetRaw(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'levante-web-dashboard-auth'
    }
  });
  const text = await response.text().catch(() => '');
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = null;
    }
  }
  return { response, text, json };
}

export async function fetchGithubProfile(token) {
  const user = await githubGet('/user', token);
  const emails = await githubGet('/user/emails', token).catch(() => []);
  const primary = Array.isArray(emails)
    ? emails.find((entry) => entry?.primary === true && entry?.verified === true)
      || emails.find((entry) => entry?.verified === true)
      || emails.find((entry) => entry?.primary === true)
      || emails[0]
    : null;
  const orgs = await githubGet('/user/orgs?per_page=100', token).catch(() => []);
  const memberships = await githubGet('/user/memberships/orgs?per_page=100', token).catch(() => []);
  const orgSet = new Set();
  if (Array.isArray(orgs)) {
    for (const org of orgs) {
      const login = String(org?.login || '').trim();
      if (login) orgSet.add(login);
    }
  }
  if (Array.isArray(memberships)) {
    for (const membership of memberships) {
      const state = String(membership?.state || '').trim().toLowerCase();
      const login = String(membership?.organization?.login || membership?.organization?.name || '').trim();
      if (state === 'active' && login) orgSet.add(login);
    }
  }

  return {
    githubId: String(user?.id || ''),
    login: String(user?.login || ''),
    name: String(user?.name || ''),
    email: String(primary?.email || user?.email || ''),
    avatarUrl: String(user?.avatar_url || ''),
    orgs: Array.from(orgSet)
  };
}

export async function checkGithubOrgMembership(token, requiredOrgRaw) {
  const requiredOrg = String(requiredOrgRaw || '').trim().toLowerCase();
  if (!requiredOrg) {
    return { allowed: true, reason: null, org: null };
  }

  const path = `/user/memberships/orgs/${encodeURIComponent(requiredOrg)}`;
  const { response, text, json } = await githubGetRaw(path, token);

  if (response.status === 200) {
    const state = String(json?.state || '').trim().toLowerCase();
    if (state === 'active') {
      return { allowed: true, reason: null, org: requiredOrg };
    }
    return { allowed: false, reason: 'org_membership_not_active', org: requiredOrg };
  }

  if (response.status === 404) {
    return { allowed: false, reason: 'org_membership_not_found', org: requiredOrg };
  }

  if (response.status === 403) {
    const ssoHeader = String(response.headers.get('x-github-sso') || '').trim();
    if (/required/i.test(ssoHeader)) {
      const match = ssoHeader.match(/url=([^;,\s]+)/i);
      const ssoUrl = match ? decodeURIComponent(match[1]) : null;
      return {
        allowed: false,
        reason: 'github_sso_required',
        org: requiredOrg,
        ssoUrl
      };
    }

    const bodyMessage = String(json?.message || text || '').toLowerCase();
    if (bodyMessage.includes('oauth app access restrictions')
      || bodyMessage.includes('access to third-parties is limited')
      || bodyMessage.includes('restricting-access-to-your-organization-s-data')) {
      return {
        allowed: false,
        reason: 'github_oauth_app_restricted',
        org: requiredOrg,
        helpUrl: 'https://docs.github.com/articles/restricting-access-to-your-organization-s-data/'
      };
    }
  }

  const message = json?.message || text || `GitHub org membership check failed (${response.status})`;
  return { allowed: false, reason: message, org: requiredOrg };
}

export function appendQueryParam(path, key, value) {
  const base = String(path || '/');
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${encodeURIComponent(key)}=${encodeURIComponent(String(value ?? ''))}`;
}
