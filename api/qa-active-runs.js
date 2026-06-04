/**
 * Live LEVANTE-QA activity for the Pitwall "Running now" cards.
 *
 * CI runs don't appear in runs.json until each task finalizes, so to show what's
 * currently executing we list the levante-qa `assignment-run.yml` workflow runs
 * that are queued or in progress via the GitHub API. The workflow sets a
 * descriptive `run-name` (assignment · agent · batch), which we surface as the
 * card title.
 *
 *   GET /api/qa-active-runs → { runs: [{ id, title, status, createdAt, htmlUrl }], source }
 *
 * Env:
 *   QA_GH_DISPATCH_TOKEN (preferred) | GITHUB_TOKEN | GH_TOKEN  — needs actions:read on levante-qa
 *   QA_GH_OWNER (default 'levante-framework')
 *   QA_GH_REPO  (default 'levante-qa')
 *   QA_GH_WORKFLOW (default 'assignment-run.yml')
 */
const OWNER = process.env.QA_GH_OWNER || 'levante-framework';
const REPO = process.env.QA_GH_REPO || 'levante-qa';
const WORKFLOW = process.env.QA_GH_WORKFLOW || 'assignment-run.yml';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const gh = token();
  if (!gh) return res.status(200).json({ runs: [], source: 'unavailable' });

  // No `status` filter so we capture both queued and in_progress in one call.
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=30&event=workflow_dispatch`;
  try {
    const ghRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${gh}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pitwall-qa-runs',
      },
    });
    if (!ghRes.ok) {
      const text = await ghRes.text();
      return res.status(200).json({ runs: [], source: 'error', error: `GitHub ${ghRes.status}: ${text.slice(0, 200)}` });
    }
    const data = await ghRes.json();
    const runs = (data.workflow_runs || [])
      .filter((r) => r.status && r.status !== 'completed')
      .map((r) => ({
        id: r.id,
        title: r.display_title || r.name || 'Assignment run',
        status: r.status,
        createdAt: r.run_started_at || r.created_at,
        htmlUrl: r.html_url,
        attempt: r.run_attempt,
      }));
    return res.status(200).json({ runs, source: 'gh' });
  } catch (error) {
    return res.status(200).json({ runs: [], source: 'error', error: error?.message || String(error) });
  }
}
