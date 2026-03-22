function getGithubToken() {
  return String(
    process.env.GITHUB_TOKEN
    || process.env.github_token
    || process.env.GH_TOKEN
    || ''
  ).trim();
}

function normalizeGithubLogin(value) {
  const login = String(value || '').trim();
  if (!login) return '';
  if (!/^[a-z\d](?:[a-z\d-]{0,37})$/i.test(login)) return '';
  return login;
}

async function checkGithubOrgMembershipByLogin(loginRaw, orgRaw) {
  const login = normalizeGithubLogin(loginRaw);
  const org = String(orgRaw || '').trim().toLowerCase();
  if (!login) {
    return { success: false, allowed: false, error: 'invalid_github_login' };
  }
  if (!org) {
    return { success: false, allowed: false, error: 'missing_org' };
  }

  const token = getGithubToken();
  if (!token) {
    return { success: false, allowed: false, error: 'missing_github_token' };
  }

  const response = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'levante-web-dashboard-org-check'
    }
  });

  if (response.status === 204) {
    return { success: true, allowed: true, login, org };
  }
  if (response.status === 404) {
    return { success: true, allowed: false, login, org, error: 'not_member' };
  }

  const body = await response.text().catch(() => '');
  return {
    success: false,
    allowed: false,
    login,
    org,
    error: `github_api_${response.status}`,
    message: body || `GitHub API error (${response.status})`
  };
}

export {
  getGithubToken,
  normalizeGithubLogin,
  checkGithubOrgMembershipByLogin
};
