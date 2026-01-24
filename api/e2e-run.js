const DASHBOARD_BASE_URL = process.env.E2E_DASHBOARD_BASE_URL || 'https://hs-levante-admin-dev--ai-tests-dctel36u.web.app';

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
    const response = await fetch(`${DASHBOARD_BASE_URL}/api/e2e/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {})
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
