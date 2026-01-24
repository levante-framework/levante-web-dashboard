const PROJECT_ID = process.env.E2E_PROJECT_ID || 'hs-levante-admin-dev';
const FUNCTIONS_BASE_URL =
  process.env.E2E_FUNCTIONS_BASE_URL || `https://us-central1-${PROJECT_ID}.cloudfunctions.net/api`;
const RUNNER_TOKEN = process.env.E2E_RUNNER_TOKEN || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const authHeader = req.headers.authorization || '';
    const runnerAuthHeader = RUNNER_TOKEN ? `Bearer ${RUNNER_TOKEN}` : authHeader;
    const response = await fetch(`${FUNCTIONS_BASE_URL}/e2e/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(runnerAuthHeader ? { Authorization: runnerAuthHeader } : {})
      },
      body: JSON.stringify(req.body || {})
    });

    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    res.status(response.status).json(
      typeof payload === 'string' ? { error: payload } : payload
    );
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Runner proxy failed' });
  }
}
