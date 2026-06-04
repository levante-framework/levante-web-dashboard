/**
 * Refresh the LEVANTE-QA assignment catalogue.
 *
 * The Pitwall "Run an assignment" picker reads a cached snapshot
 * (gs://levante-tools/levante-qa/assignments.json). To pick up assignments that
 * were just created/edited on the qa-tests site, this proxies a
 * `workflow_dispatch` to the levante-qa `publish-assignments.yml` workflow, which
 * re-reads Firestore and rewrites assignments.json. The page then polls
 * /api/qa-assignments until `updatedAt` advances.
 *
 *   POST /api/qa-refresh-assignments → { dispatched: true, actionsUrl }
 *
 * Env:
 *   QA_GH_DISPATCH_TOKEN (preferred) | GITHUB_TOKEN | GH_TOKEN
 *     — needs `actions: write` on levante-framework/levante-qa
 *   QA_GH_OWNER (default 'levante-framework')
 *   QA_GH_REPO  (default 'levante-qa')
 *   QA_GH_PUBLISH_WORKFLOW (default 'publish-assignments.yml')
 *   QA_GH_REF   (default 'main')
 */
const OWNER = process.env.QA_GH_OWNER || 'levante-framework';
const REPO = process.env.QA_GH_REPO || 'levante-qa';
const WORKFLOW = process.env.QA_GH_PUBLISH_WORKFLOW || 'publish-assignments.yml';
const REF = process.env.QA_GH_REF || 'main';

function token() {
  return (
    process.env.QA_GH_DISPATCH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_AUTH_TOKEN ||
    ''
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const gh = token();
  if (!gh) {
    return res.status(503).json({
      error: 'No GitHub dispatch token configured. Set QA_GH_DISPATCH_TOKEN (actions:write on levante-qa).',
    });
  }

  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
  try {
    const ghRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gh}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'pitwall-qa-runs',
      },
      body: JSON.stringify({ ref: REF, inputs: {} }),
    });

    if (ghRes.status === 204) {
      return res.status(200).json({
        dispatched: true,
        actionsUrl: `https://github.com/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}`,
      });
    }
    const text = await ghRes.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { message: text }; }
    return res.status(ghRes.status).json({
      error: `GitHub dispatch failed (${ghRes.status})`,
      detail: payload?.message || text?.slice(0, 300),
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Dispatch failed' });
  }
}
