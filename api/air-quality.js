/**
 * Air Quality proxy (AQICN / WAQI)
 *
 * Privacy model:
 * - The device never sends its raw GPS to this endpoint.
 * - For an area lookup the device sends a privacy-masked bounding box
 *   (`latlng` = lat1,lon1,lat2,lon2). The box is a ~10km x 10km area whose
 *   center has already been shifted on-device, so the precise location is not
 *   recoverable from the request.
 * - For an enrichment lookup the device sends a public WAQI station id (`uid`).
 *   A station id is public information and does not reveal the device location.
 *
 * This endpoint only attaches the secret WAQI token (kept server-side) and
 * forwards the request to the WAQI API. It does not log or store coordinates.
 *
 * Configuration:
 * - Set WAQI_TOKEN (or AQICN_TOKEN) in the environment. Get a free token at
 *   https://aqicn.org/data-platform/token/
 *
 * Usage:
 * - Area (bounding box) lookup:
 *     GET /api/air-quality?latlng=<lat1>,<lon1>,<lat2>,<lon2>
 * - Station enrichment lookup:
 *     GET /api/air-quality?uid=<stationUid>
 */
const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': 'levante-web-dashboard/1.0',
            Accept: 'application/json'
          }
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode !== 200) {
              return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            }
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        }
      )
      .on('error', reject);
  });
}

// Validates the privacy-masked bounding box: four finite numbers and an area
// no larger than a metro-scale box, so callers cannot turn this into a
// country-scale scraper while still allowing the client to expand the search
// area (up to ~50km) when no station falls inside the initial neighborhood box.
function parseBoundingBox(latlng) {
  const parts = String(latlng || '')
    .split(',')
    .map((n) => Number(n.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const [lat1, lon1, lat2, lon2] = parts;
  if (Math.abs(lat1) > 90 || Math.abs(lat2) > 90 || Math.abs(lon1) > 180 || Math.abs(lon2) > 180) {
    return null;
  }
  const MAX_SPAN_DEG = 0.9; // metro-scale cap; allows ~50km client fallback boxes
  if (Math.abs(lat2 - lat1) > MAX_SPAN_DEG || Math.abs(lon2 - lon1) > MAX_SPAN_DEG) {
    return null;
  }
  return { lat1, lon1, lat2, lon2 };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const token = process.env.WAQI_TOKEN || process.env.AQICN_TOKEN || '';
  if (!token) {
    res.status(200).json({ ok: false, error: 'missing_token', reason: 'WAQI_TOKEN is not configured on the server' });
    return;
  }

  const query = req.query || {};
  const latlng = query.latlng;
  const uid = query.uid;

  try {
    // Station enrichment: fetch detailed feed for a single public station id.
    if (uid != null && String(uid).trim() !== '') {
      const cleanUid = String(uid).trim().replace(/[^0-9]/g, '');
      if (!cleanUid) {
        res.status(400).json({ ok: false, error: 'invalid_uid' });
        return;
      }
      const url = `https://api.waqi.info/feed/@${encodeURIComponent(cleanUid)}/?token=${encodeURIComponent(token)}`;
      const json = await fetchJson(url);
      if (json?.status !== 'ok' || !json?.data) {
        res.status(200).json({ ok: false, error: 'feed_unavailable', reason: json?.data || json?.status || 'unknown' });
        return;
      }
      const d = json.data;
      res.status(200).json({
        ok: true,
        mode: 'station',
        station: {
          uid: cleanUid,
          aqi: Number(d.aqi),
          dominantPollutant: d.dominentpol || null,
          name: d?.city?.name || null,
          observedAt: d?.time?.iso || d?.time?.s || null,
          pollutants: d.iaqi && typeof d.iaqi === 'object'
            ? Object.fromEntries(
                Object.entries(d.iaqi)
                  .filter(([, v]) => v && Number.isFinite(Number(v.v)))
                  .map(([k, v]) => [k, Number(v.v)])
              )
            : {}
        }
      });
      return;
    }

    // Area lookup: privacy-masked bounding box -> list of nearby stations.
    if (latlng != null) {
      const box = parseBoundingBox(latlng);
      if (!box) {
        res.status(400).json({ ok: false, error: 'invalid_bbox', reason: 'latlng must be lat1,lon1,lat2,lon2 within a small area' });
        return;
      }
      const bounds = `${box.lat1},${box.lon1},${box.lat2},${box.lon2}`;
      const url = `https://api.waqi.info/v2/map/bounds/?latlng=${encodeURIComponent(bounds)}&networks=all&token=${encodeURIComponent(token)}`;
      const json = await fetchJson(url);
      if (json?.status !== 'ok' || !Array.isArray(json?.data)) {
        res.status(200).json({ ok: false, error: 'bounds_unavailable', reason: json?.data || json?.status || 'unknown' });
        return;
      }
      // Only return stations that actually report an AQI value. We intentionally
      // pass through station coordinates so the device can pick the closest one
      // on-device; the requested box is already de-identified.
      const stations = json.data
        .map((s) => {
          const aqi = Number(s.aqi);
          return {
            uid: s.uid,
            lat: Number(s.lat),
            lon: Number(s.lon),
            aqi: Number.isFinite(aqi) ? aqi : null,
            name: s?.station?.name || null,
            observedAt: s?.station?.time || null
          };
        })
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && Number.isFinite(s.aqi));
      res.status(200).json({ ok: true, mode: 'bounds', count: stations.length, stations });
      return;
    }

    res.status(400).json({ ok: false, error: 'missing_query', reason: 'provide latlng (bbox) or uid (station)' });
  } catch (err) {
    console.error('air-quality error:', err);
    res.status(200).json({ ok: false, error: 'exception', reason: 'lookup_failed' });
  }
};
