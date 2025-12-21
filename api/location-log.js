const { readLog, appendLog } = require('../lib/locationLog');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      // Enforce privacy rule: never accept raw coordinates.
      if (
        body.latitude != null ||
        body.longitude != null ||
        body.lat != null ||
        body.lon != null
      ) {
        res.status(400).json({ error: 'raw_coordinates_not_allowed' });
        return;
      }

      const entry = {
        timestamp: body.timestamp || new Date().toISOString(),
        datasetFile: body.datasetFile || null,
        datasetLoadMs: body.datasetLoadMs ?? null,
        lookupMs: body.lookupMs ?? null,
        resultCount: body.resultCount ?? null,
        cityName: body.cityName || null,
        country: body.country || null,
        admin1: body.admin1 || null,
        admin2: body.admin2 || null,
        source: body.source || 'client'
      };

      appendLog(entry);
      res.status(200).json({ ok: true });
      return;
    } catch (error) {
      console.error('location-log: failed to append log', error);
      res.status(500).json({ error: 'append_failed', message: error.message });
      return;
    }
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  try {
    const entries = await readLog();
    const sanitized = (Array.isArray(entries) ? entries : []).map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const { latitude, longitude, lat, lon, ...rest } = entry;
      return rest;
    });
    res.status(200).json(sanitized);
  } catch (error) {
    console.error('location-log: failed to serve log', error);
    res.status(500).json({ error: 'read_failed', message: error.message });
  }
}






















