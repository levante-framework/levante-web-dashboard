const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const area = require('@turf/area').default;
const distance = require('@turf/distance').default;
const centroid = require('@turf/centroid').default;
const { point: turfPoint } = require('@turf/helpers');
const osmtogeojson = require('osmtogeojson');
const { countries } = require('../config/gadm-countries.json');

const OVERPASS_ENDPOINT = process.env.OVERPASS_API_URL || 'https://overpass-api.de/api/interpreter';
const ADMIN_LEVEL_REGEX = '6|7|8|9|10';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const responseCache = new Map();

const COUNTRY_SYNONYMS = new Map([
  ['usa', 'usa'],
  ['us', 'usa'],
  ['united states', 'usa'],
  ['united states of america', 'usa'],
  ['scotland', 'scotland'],
  ['canada', 'canada'],
  ['colombia', 'colombia'],
  ['india', 'india'],
  ['argentina', 'argentina'],
  ['netherlands', 'netherlands'],
  ['the netherlands', 'netherlands'],
  ['holland', 'netherlands'],
  ['ghana', 'ghana'],
  ['switzerland', 'switzerland'],
  ['germany', 'germany']
]);

const SUPPORTED_COUNTRIES = new Set(
  countries.map((name) => name.toLowerCase()).filter(Boolean)
);

function normalizeCountry(input) {
  const lower = (input || '').trim().toLowerCase();
  if (SUPPORTED_COUNTRIES.has(lower)) {
    return lower;
  }
  if (COUNTRY_SYNONYMS.has(lower)) {
    const canonical = COUNTRY_SYNONYMS.get(lower);
    return SUPPORTED_COUNTRIES.has(canonical) ? canonical : null;
  }
  return null;
}

function getAdminLevel(feature) {
  const levelStr =
    feature?.properties?.tags?.admin_level ||
    feature?.properties?.admin_level ||
    feature?.properties?.tags?.['admin_level'];
  const parsed = Number.parseInt(levelStr, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

function computeArea(feature) {
  try {
    return area(feature);
  } catch {
    return Infinity;
  }
}

function cacheKey(lat, lon) {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

async function queryOverpass(lat, lon) {
  const key = cacheKey(lat, lon);
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // Query for administrative boundaries containing the point
  const query = `
    [out:json][timeout:25];
    is_in(${lat},${lon})->.a;
    rel(pivot.a)["boundary"="administrative"]["admin_level"~"${ADMIN_LEVEL_REGEX}"];
    out body;
    >;
    out geom;
  `;

  const params = new URLSearchParams({ data: query });
  const response = await fetch(OVERPASS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    throw new Error(`Overpass error ${response.status}`);
  }
  const payload = await response.json();
  const geojson = osmtogeojson(payload, { flatProperties: true });
  responseCache.set(key, { timestamp: Date.now(), data: geojson });
  return geojson;
}

async function queryNearbyCities(lat, lon, radiusKm = 10) {
  // Query for nearby city/town boundaries (admin_level >= 7) within radius
  const query = `
    [out:json][timeout:25];
    (
      rel["boundary"="administrative"]["admin_level"~"7|8|9|10"](around:${radiusKm * 1000},${lat},${lon});
    );
    out body;
    >;
    out geom;
  `;

  const params = new URLSearchParams({ data: query });
  const response = await fetch(OVERPASS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    throw new Error(`Overpass error ${response.status}`);
  }
  const payload = await response.json();
  return osmtogeojson(payload, { flatProperties: true });
}

function distanceToPolygon(lat, lon, feature) {
  try {
    const pt = turfPoint([lon, lat]);
    // If point is inside polygon, distance is 0
    if (booleanPointInPolygon(pt, feature.geometry)) {
      return 0;
    }
    // Otherwise, calculate distance to centroid as approximation
    const center = centroid(feature);
    return distance(pt, center, { units: 'kilometers' });
  } catch {
    return Infinity;
  }
}

function pickBestFeature(features, lat, lon) {
  const pt = turfPoint([lon, lat]);
  const candidates = [];

  for (const feature of features) {
    if (!feature?.geometry) continue;
    try {
      if (booleanPointInPolygon(pt, feature.geometry)) {
        candidates.push(feature);
      }
    } catch (error) {
      console.warn('gadm-polygon: failed boolean check', error.message);
    }
  }

  if (!candidates.length) {
    return null;
  }

  // Filter out counties (admin_level=6) if we have any city/town boundaries (admin_level >= 7)
  const hasCityLevel = candidates.some(f => getAdminLevel(f) >= 7);
  const filtered = hasCityLevel 
    ? candidates.filter(f => getAdminLevel(f) >= 7)
    : candidates;

  filtered.sort((a, b) => {
    const levelA = getAdminLevel(a);
    const levelB = getAdminLevel(b);
    
    // Prefer higher admin level (more specific)
    if (levelA !== levelB) {
      return levelB - levelA;
    }
    
    // Within same admin level, prefer smaller area
    const areaA = computeArea(a);
    const areaB = computeArea(b);
    return areaA - areaB;
  });

  const best = filtered[0];
  return {
    feature: best,
    adminLevel: getAdminLevel(best),
    candidates: candidates.length,
    filtered: filtered.length
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const { lat, lon, country } = req.query;
  const latNum = Number(lat);
  const lonNum = Number(lon);

  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    res.status(400).json({ error: 'invalid_coordinates' });
    return;
  }

  const normalizedCountry = normalizeCountry(country);
  if (!normalizedCountry) {
    res.status(400).json({ error: 'unsupported_country', allowed: Array.from(SUPPORTED_COUNTRIES) });
    return;
  }

  try {
    const geojson = await queryOverpass(latNum, lonNum);
    if (!geojson?.features?.length) {
      res.status(404).json({ error: 'polygon_not_found', source: 'overpass', message: 'No administrative relations returned' });
      return;
    }

    let selection = pickBestFeature(geojson.features, latNum, lonNum);
    if (!selection) {
      res.status(404).json({ error: 'polygon_not_found', source: 'overpass', message: 'No polygons contained the point' });
      return;
    }

    // If we only got a county (admin_level=6), try to find a nearby city that's closer
    if (selection.adminLevel === 6) {
      try {
        const nearbyCities = await queryNearbyCities(latNum, lonNum, 10);
        if (nearbyCities?.features?.length) {
          // Calculate distance to each nearby city
          const cityDistances = nearbyCities.features
            .map(f => ({
              feature: f,
              distance: distanceToPolygon(latNum, lonNum, f),
              adminLevel: getAdminLevel(f)
            }))
            .filter(c => c.adminLevel >= 7 && c.distance < Infinity)
            .sort((a, b) => a.distance - b.distance);

          // If we found a city within 5km, prefer it over the county
          if (cityDistances.length > 0 && cityDistances[0].distance < 5) {
            selection = {
              feature: cityDistances[0].feature,
              adminLevel: cityDistances[0].adminLevel,
              candidates: selection.candidates,
              filtered: 1,
              fallback: 'nearby_city',
              distanceKm: cityDistances[0].distance.toFixed(2)
            };
          }
        }
      } catch (nearbyError) {
        // If nearby city query fails, fall back to county
        console.warn('gadm-polygon: nearby city query failed', nearbyError.message);
      }
    }

    res.status(200).json({
      feature: selection.feature,
      adminLevel: selection.adminLevel,
      candidates: selection.candidates,
      source: 'overpass',
      cache: responseCache.has(cacheKey(latNum, lonNum)),
      fallback: selection.fallback || null,
      distanceKm: selection.distanceKm || null
    });
  } catch (error) {
    console.error('gadm-polygon: overpass failure', error);
    res.status(502).json({ error: 'overpass_failed', message: error.message });
  }
}

module.exports = handler;
