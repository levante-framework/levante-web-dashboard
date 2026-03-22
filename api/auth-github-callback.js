import {
  appendQueryParam,
  checkGithubOrgMembership,
  createSessionCookieValue,
  exchangeGithubCodeForAccessToken,
  fetchGithubProfile,
  getGithubAuthConfig,
  getSessionSecret,
  isSecureRequest,
  serializeCookie,
  SESSION_COOKIE_NAME,
  verifyOauthStateToken
} from '../lib/server/github-auth.js';

function redirectWithError(res, returnTo, message, options = {}) {
  let target = appendQueryParam(returnTo || '/', 'authError', message || 'auth_failed');
  const ssoUrl = String(options?.ssoUrl || '').trim();
  if (ssoUrl) {
    target = appendQueryParam(target, 'authSsoUrl', ssoUrl);
  }
  const helpUrl = String(options?.helpUrl || '').trim();
  if (helpUrl) {
    target = appendQueryParam(target, 'authHelpUrl', helpUrl);
  }
  const actionLabel = String(options?.actionLabel || '').trim();
  if (actionLabel) {
    target = appendQueryParam(target, 'authActionLabel', actionLabel);
  }
  return res.redirect(302, target);
}

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

  const code = String(req.query?.code || '').trim();
  const stateToken = String(req.query?.state || '').trim();
  if (!code || !stateToken) {
    return redirectWithError(res, '/', 'missing_code_or_state');
  }

  const state = verifyOauthStateToken(stateToken, secret);
  if (!state) {
    return redirectWithError(res, '/', 'invalid_state');
  }
  const returnTo = String(state.returnTo || '/');

  try {
    const { clientId, clientSecret, redirectUri } = getGithubAuthConfig(req);
    if (!clientId || !clientSecret || !redirectUri) {
      return redirectWithError(res, returnTo, 'missing_github_oauth_config');
    }

    const accessToken = await exchangeGithubCodeForAccessToken({
      code,
      clientId,
      clientSecret,
      redirectUri
    });
    const profile = await fetchGithubProfile(accessToken);
    if (!profile.login) {
      return redirectWithError(res, returnTo, 'github_profile_missing_login');
    }

    const requiredOrg = String(process.env.GITHUB_REQUIRED_ORG || 'levante-framework').trim().toLowerCase();
    const orgCheck = await checkGithubOrgMembership(accessToken, requiredOrg);
    if (!orgCheck.allowed) {
      if (orgCheck.reason === 'github_sso_required') {
        return redirectWithError(
          res,
          returnTo,
          `GitHub SSO authorization required for ${requiredOrg}. Authorize this app in your org SSO settings and try again.`,
          { ssoUrl: orgCheck.ssoUrl || '', actionLabel: 'Authorize GitHub SSO Access' }
        );
      }
      if (orgCheck.reason === 'github_oauth_app_restricted') {
        return redirectWithError(
          res,
          returnTo,
          `GitHub OAuth app access is restricted by organization policy for ${requiredOrg}. An org owner must allow this OAuth app (or grant your account access) before login can succeed.`,
          {
            helpUrl: orgCheck.helpUrl || 'https://docs.github.com/articles/restricting-access-to-your-organization-s-data/',
            actionLabel: 'Open GitHub Org Access Help'
          }
        );
      }
      if (orgCheck.reason === 'org_membership_not_found' || orgCheck.reason === 'org_membership_not_active') {
        return redirectWithError(
          res,
          returnTo,
          `Access denied. You must be an active member of GitHub organization: ${requiredOrg}.`
        );
      }
      return redirectWithError(res, returnTo, `GitHub org check failed: ${orgCheck.reason}`);
    }

    const sessionValue = createSessionCookieValue({
      githubId: profile.githubId,
      login: profile.login,
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      orgs: profile.orgs
    }, secret);

    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, sessionValue, {
      httpOnly: true,
      secure: isSecureRequest(req),
      sameSite: 'Lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60
    }));
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, appendQueryParam(returnTo, 'auth', 'success'));
  } catch (error) {
    console.error('auth-github-callback error', error);
    return redirectWithError(res, returnTo, error?.message || 'auth_failed');
  }
}
