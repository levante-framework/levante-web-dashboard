import crowdinOtaLib from './lib/crowdin-ota-client.js';

const { clearOtaClientCache } = crowdinOtaLib;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-revalidate-secret');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const expected = String(process.env.REVALIDATE_SECRET || '').trim();
  const provided = String(req.headers['x-revalidate-secret'] || '').trim();

  if (!expected || provided !== expected) {
    res.status(401).json({ revalidated: false, error: 'Unauthorized' });
    return;
  }

  clearOtaClientCache();
  res.status(200).json({
    revalidated: true,
    now: new Date().toISOString(),
  });
}
