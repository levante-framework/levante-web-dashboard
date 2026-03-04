const { saveLocation, getLocation } = require('./lib/location-store');

const DEFAULT_PROJECT_ID =
  process.env.LOCATION_FIRESTORE_PROJECT_ID ||
  process.env.FIREBASE_PROJECT_ID ||
  'hs-levante-admin-prod';
const DEFAULT_COLLECTION = process.env.LOCATION_FIRESTORE_COLLECTION || 'locations';

function getProjectId(req) {
  const bodyProjectId = req?.body && typeof req.body === 'object' ? req.body.projectId : null;
  const queryProjectId = req?.query?.projectId;
  return bodyProjectId || queryProjectId || DEFAULT_PROJECT_ID;
}

function getCollection(req) {
  const bodyCollection = req?.body && typeof req.body === 'object' ? req.body.collection : null;
  const queryCollection = req?.query?.collection;
  return bodyCollection || queryCollection || DEFAULT_COLLECTION;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      const projectId = getProjectId(req);
      const collection = getCollection(req);
      const location = body.location || body;

      if (!projectId) {
        res.status(400).json({ success: false, error: 'Missing projectId' });
        return;
      }

      const result = await saveLocation({
        projectId,
        collection,
        location,
      });

      res.status(200).json({
        success: true,
        id: result.id,
        path: result.path,
        location: result.location,
      });
      return;
    }

    if (req.method === 'GET') {
      const docId = req.query?.docId;
      const projectId = getProjectId(req);
      const collection = getCollection(req);

      if (!docId || typeof docId !== 'string') {
        res.status(400).json({ success: false, error: 'Missing docId query parameter' });
        return;
      }

      if (!projectId) {
        res.status(400).json({ success: false, error: 'Missing projectId' });
        return;
      }

      const location = await getLocation({
        projectId,
        collection,
        docId,
      });

      if (!location) {
        res.status(404).json({ success: false, error: 'Location not found' });
        return;
      }

      res.status(200).json({ success: true, id: docId, location });
      return;
    }

    res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('location-upsert API error:', error);
    res.status(500).json({ success: false, error: error.message || 'Unknown error' });
  }
};
