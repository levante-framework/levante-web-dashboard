const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_PATH = path.join(process.cwd(), 'data', 'geocoder', 'cities.min.json');
const DATA_PATH_GZ = path.join(process.cwd(), 'data', 'geocoder', 'cities.min.json.gz');

let geoData = null;

function loadData() {
  if (geoData) return;
  let raw;
  if (fs.existsSync(DATA_PATH_GZ)) {
    raw = zlib.gunzipSync(fs.readFileSync(DATA_PATH_GZ)).toString();
  } else if (fs.existsSync(DATA_PATH)) {
    raw = fs.readFileSync(DATA_PATH, 'utf8');
  } else {
    throw new Error('Geocoder dataset not found');
  }
  geoData = JSON.parse(raw);
  if (!Array.isArray(geoData) || geoData.length === 0) {
    throw new Error('Geocoder dataset empty or invalid');
  }
}

function uniqueSorted(arr) {
  return Array.from(new Set(arr.filter(Boolean))).sort();
}

function listCountries() {
  return uniqueSorted(geoData.map((c) => c.country));
}

function listStates(country) {
  return uniqueSorted(
    geoData
      .filter((c) => c.country === country)
      .map((c) => c.admin1)
  );
}

function listCities(country, admin1, limit = 300) {
  const results = [];
  for (const city of geoData) {
    if (city.country !== country) continue;
    if (admin1 && city.admin1 !== admin1) continue;
    if (!city.name) continue;
    results.push({
      name: city.name,
      admin1: city.admin1,
      country: city.country,
      lat: city.lat,
      lon: city.lon,
      population: city.population
    });
    if (results.length >= limit) break;
  }
  return results;
}

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
    loadData();
  } catch (err) {
    res.status(500).json({ error: 'dataset_unavailable', message: err.message });
    return;
  }

  const country = (req.query.country || '').trim();
  const admin1 = (req.query.admin1 || '').trim();
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 300));

  // No country provided: return country list
  if (!country) {
    return res.status(200).json({ countries: listCountries() });
  }

  // Country provided, no admin1: return state list
  if (country && !admin1) {
    return res.status(200).json({ states: listStates(country) });
  }

  // Country + admin1: return cities
  return res.status(200).json({ cities: listCities(country, admin1, limit) });
};

