const { readLog } = require('../lib/locationLog');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  try {
    const entries = await readLog();
    res.status(200).json(entries);
  } catch (error) {
    console.error('location-log: failed to serve log', error);
    res.status(500).json({ error: 'read_failed', message: error.message });
  }
}






