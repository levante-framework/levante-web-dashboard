import {
  getSessionSecret,
  parseCookies,
  parseSessionCookieValue,
  SESSION_COOKIE_NAME
} from '../lib/server/github-auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  }

  const secret = getSessionSecret();
  if (!secret) {
    return res.status(500).json({
      success: false,
      error: 'missing_session_secret',
      message: 'Missing AUTH_SESSION_SECRET (or GITHUB_AUTH_SESSION_SECRET).'
    });
  }

  const cookies = parseCookies(req);
  const rawSession = cookies[SESSION_COOKIE_NAME];
  const session = parseSessionCookieValue(rawSession, secret);
  if (!session) {
    return res.status(200).json({
      success: true,
      authenticated: false,
      user: null
    });
  }

  return res.status(200).json({
    success: true,
    authenticated: true,
    user: {
      githubId: String(session.githubId || ''),
      login: String(session.login || ''),
      name: String(session.name || ''),
      email: String(session.email || ''),
      avatarUrl: String(session.avatarUrl || ''),
      orgs: Array.isArray(session.orgs) ? session.orgs : []
    },
    expiresAt: Number.isFinite(Number(session.exp))
      ? new Date(Number(session.exp) * 1000).toISOString()
      : null
  });
}
