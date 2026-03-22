import {
  createOauthStateToken,
  getGithubAuthConfig,
  getSessionSecret,
  sanitizeReturnTo
} from '../lib/server/github-auth.js';

export default async function handler(req, res) {
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

  const { clientId, redirectUri, scope } = getGithubAuthConfig(req);
  if (!clientId || !redirectUri) {
    return res.status(500).json({
      success: false,
      error: 'missing_github_oauth_config',
      message: 'Missing GITHUB_CLIENT_ID or GITHUB_OAUTH_REDIRECT_URI.'
    });
  }

  const returnTo = sanitizeReturnTo(req.query?.returnTo || '/', '/');
  const state = createOauthStateToken({ returnTo }, secret);

  const githubUrl = new URL('https://github.com/login/oauth/authorize');
  githubUrl.searchParams.set('client_id', clientId);
  githubUrl.searchParams.set('redirect_uri', redirectUri);
  githubUrl.searchParams.set('scope', scope || 'read:user user:email read:org');
  githubUrl.searchParams.set('state', state);
  githubUrl.searchParams.set('allow_signup', 'false');

  res.setHeader('Cache-Control', 'no-store');
  return res.redirect(302, githubUrl.toString());
}
