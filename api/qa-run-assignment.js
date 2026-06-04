/**
 * Trigger a LEVANTE-QA assignment run on GitHub Actions.
 *
 * Pitwall can't run Cypress itself, so this proxies a `workflow_dispatch` to the
 * levante-qa `assignment-run.yml` workflow, which provisions participants, runs
 * the assignment's tasks, and mirrors results to gs://levante-tools/levante-qa/.
 * We generate the batchId here and pass it as an input so the caller can filter
 * the QA Runs page for the batch while it fills in.
 *
 *   POST /api/qa-run-assignment
 *     body: { assignmentId?, assignmentName?, agent?, provider?, ageYears?,
 *             ageMonths?, batchLabel?, failOnError? }
 *     → { batchId, dispatched: true, actionsUrl }
 *
 * Env:
 *   QA_GH_DISPATCH_TOKEN (preferred) | GITHUB_TOKEN | GH_TOKEN
 *     — needs `actions: write` on levante-framework/levante-qa
 *   QA_GH_OWNER  (default 'levante-framework')
 *   QA_GH_REPO   (default 'levante-qa')
 *   QA_GH_WORKFLOW (default 'assignment-run.yml')
 *   QA_GH_REF    (default 'main')
 */
import { randomUUID } from 'node:crypto';

const OWNER = process.env.QA_GH_OWNER || 'levante-framework';
const REPO = process.env.QA_GH_REPO || 'levante-qa';
const WORKFLOW = process.env.QA_GH_WORKFLOW || 'assignment-run.yml';
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

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch { body = {}; }
  }
  body = body || {};

  const assignmentId = body.assignmentId ? String(body.assignmentId) : '';
  const assignmentName = body.assignmentName ? String(body.assignmentName) : '';
  if (!assignmentId && !assignmentName) {
    return res.status(400).json({ error: 'Provide assignmentId or assignmentName' });
  }

  const agent = ['oracle', 'vlm', 'child', 'wrong'].includes(body.agent) ? body.agent : 'oracle';
  const provider = ['gemini', 'openai', 'anthropic'].includes(body.provider) ? body.provider : 'gemini';
  const batchId = body.batchId ? String(body.batchId) : randomUUID();

  // workflow_dispatch inputs must be strings.
  const inputs = {
    assignment_id: assignmentId,
    assignment_name: assignmentName,
    agent,
    provider,
    age_years: String(body.ageYears ?? 8),
    age_months: String(body.ageMonths ?? 0),
    batch_id: batchId,
    batch_label: body.batchLabel ? String(body.batchLabel) : (assignmentName || ''),
    fail_on_error: body.failOnError ? 'true' : 'false',
  };

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
      body: JSON.stringify({ ref: REF, inputs }),
    });

    if (ghRes.status === 204) {
      return res.status(200).json({
        batchId,
        dispatched: true,
        agent,
        provider: agent === 'vlm' || agent === 'child' ? provider : null,
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
