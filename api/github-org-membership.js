import { checkGithubOrgMembershipByLogin, normalizeGithubLogin } from '../lib/server/github-org-check.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  }

  try {
    const requiredOrg = String(process.env.GITHUB_REQUIRED_ORG || 'levante-framework').trim().toLowerCase();
    const username = normalizeGithubLogin(req.query?.username || req.query?.login || '');
    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'invalid_username',
        message: 'Please provide a valid GitHub username.'
      });
    }

    const result = await checkGithubOrgMembershipByLogin(username, requiredOrg);
    if (!result.success) {
      if (result.error === 'missing_github_token') {
        return res.status(500).json({
          success: false,
          error: 'missing_github_token',
          message: 'Server missing GITHUB_TOKEN for membership checks.'
        });
      }
      return res.status(502).json({
        success: false,
        error: result.error || 'github_check_failed',
        message: result.message || 'Unable to verify GitHub organization membership.'
      });
    }

    return res.status(200).json({
      success: true,
      organization: requiredOrg,
      username,
      member: result.allowed === true
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      message: error?.message || String(error)
    });
  }
}
