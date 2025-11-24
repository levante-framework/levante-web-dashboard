const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { appendLog } = require('../lib/locationLog');

const DATA_PATH = path.join(process.cwd(), 'data', 'geocoder', 'cities.min.json');
const DATA_PATH_GZ = path.join(process.cwd(), 'data', 'geocoder', 'cities.min.json.gz');
const EARTH_RADIUS_KM = 6371;

const WEATHER_CODES = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow fall',
  73: 'Moderate snow fall',
  75: 'Heavy snow fall',
  77: 'Snow grains',
  80: 'Rain showers',
  81: 'Heavy rain showers',
  82: 'Violent rain showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with heavy hail'
};


let geoData = null;
let datasetStats = null;

function msSince(startNs) {
  return Number((process.hrtime.bigint() - startNs) / 1000000n);
}

function describeWeather(code) {
  return WEATHER_CODES[code] || 'Unknown conditions';
}

async function fetchWeatherSnapshot(lat, lon) {
  if (typeof fetch !== 'function') return null;
  try {
    const params = new URLSearchParams({
      latitude: lat.toString(),
      longitude: lon.toString(),
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code',
      temperature_unit: 'fahrenheit',
      wind_speed_unit: 'mph',
      timezone: 'UTC'
    });
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
      headers: { 'User-Agent': 'LevanteDashboard/1.0' }
    });
    if (!response.ok) throw new Error(`Weather status ${response.status}`);
    const data = await response.json();
    const current = data?.current;
    if (!current) return null;
    return {
      temperature: current.temperature_2m,
      apparent: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      wind: current.wind_speed_10m,
      windUnit: data?.current_units?.wind_speed_10m || 'mph',
      description: describeWeather(current.weather_code),
      observedAt: current.time,
      source: 'open-meteo'
    };
  } catch (error) {
    console.warn('reverse-geocode: weather fetch failed', error.message);
    return null;
  }
}

function loadData() {
  if (geoData && datasetStats) return datasetStats;
  
  const loadStart = process.hrtime.bigint();
  let raw, filePath, fileStats;
  
  // Use compressed file (smaller download) - prefer .gz, fallback to uncompressed
  if (fs.existsSync(DATA_PATH_GZ)) {
    filePath = DATA_PATH_GZ;
    console.log(`location-log: Loading compressed dataset from ${DATA_PATH_GZ}`);
    const compressed = fs.readFileSync(DATA_PATH_GZ);
    raw = zlib.gunzipSync(compressed).toString('utf8');
    fileStats = fs.statSync(DATA_PATH_GZ);
  } else if (fs.existsSync(DATA_PATH)) {
    filePath = DATA_PATH;
    console.log(`location-log: Loading uncompressed dataset from ${DATA_PATH} (compressed file not found)`);
    raw = fs.readFileSync(DATA_PATH, 'utf8');
    fileStats = fs.statSync(DATA_PATH);
  } else {
    throw new Error(`Geocoder dataset missing at ${DATA_PATH} or ${DATA_PATH_GZ}. Run "npm run geocoder:build" first.`);
  }
  
  geoData = JSON.parse(raw);
  datasetStats = {
    filePath: filePath,
    fileName: path.basename(filePath),
    loadDurationMs: Number(msSince(loadStart).toFixed ? Number(msSince(loadStart).toFixed(2)) : msSince(loadStart)),
    fileSizeBytes: fileStats.size,
    totalPoints: geoData.length,
    loadedAt: new Date().toISOString()
  };
  return datasetStats;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRadians = (deg) => (deg * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon1 - lon2);
  const radLat1 = toRadians(lat1);
  const radLat2 = toRadians(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(radLat1) * Math.cos(radLat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

// Simple brute-force nearest neighbor search
// For ~50k cities, this is fast enough (<100ms)
function findNearest(data, lng, lat, maxResults = 10, maxDistanceKm = Infinity) {
  const results = [];
  
  for (let i = 0; i < data.length; i++) {
    const point = data[i];
    const dist = haversineDistance(lat, lng, point.lat, point.lon);
    
    if (dist > maxDistanceKm) continue;
    
    results.push({ idx: i, dist });
    
    // Keep only the closest N results
    if (results.length > maxResults * 2) {
      results.sort((a, b) => a.dist - b.dist);
      results.splice(maxResults);
    }
  }
  
  // Sort and return top results
  results.sort((a, b) => a.dist - b.dist);
  return results.slice(0, maxResults).map(item => item.idx);
}

module.exports = async function handler(req, res) {
  try {
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

  let datasetInfo;
  try {
    datasetInfo = loadData();
  } catch (error) {
    console.error('reverse-geocode: dataset unavailable', error);
    res.status(500).json({ error: 'dataset_missing', message: error.message });
    return;
  }

  const lat = toNumber(req.query.lat);
  const lon = toNumber(req.query.lon);

  if (lat === null || lon === null) {
    res.status(400).json({ error: 'invalid_coordinates', message: 'lat and lon query params are required numbers.' });
    return;
  }

  const limit = Math.max(1, Math.min(10, toNumber(req.query.limit) || 3));
  const maxDistanceKm = toNumber(req.query.maxDistanceKm) || 150; // default 150km

  let results = [];
  const lookupStart = process.hrtime.bigint();
  try {
    const matches = findNearest(geoData, lon, lat, limit * 2, maxDistanceKm);

    for (const idx of matches) {
      const city = geoData[idx];
      if (!city) continue;
      const distanceKm = haversineDistance(lat, lon, city.lat, city.lon);
      if (maxDistanceKm && distanceKm > maxDistanceKm) continue;
      results.push({
        id: city.id,
        name: city.name,
        ascii: city.ascii,
        lat: city.lat,
        lon: city.lon,
        country: city.country,
        admin1: city.admin1,
        admin2: city.admin2,
        population: city.population,
        distanceKm: Number(distanceKm.toFixed(2))
      });
      if (results.length >= limit) break;
    }
  } catch (error) {
    console.error('reverse-geocode: lookup failed', error);
    res.status(500).json({ error: 'lookup_failed', message: error.message || 'Unknown error' });
    return;
  }
  const lookupDurationMs = msSince(lookupStart);

  try {
    // Extract best result city info for logging
    const bestResult = results.length > 0 ? {
      cityName: results[0].name,
      admin1: results[0].admin1,
      country: results[0].country,
      distanceKm: results[0].distanceKm
    } : null;
    
    const weatherSnapshot = await fetchWeatherSnapshot(lat, lon);

    const logEntry = {
      timestamp: new Date().toISOString(),
      latitude: lat,
      longitude: lon,
      datasetFile: datasetInfo?.fileName || path.basename(DATA_PATH),
      datasetPath: datasetInfo?.filePath || DATA_PATH,
      datasetLoadMs: datasetInfo?.loadDurationMs ?? null,
      lookupMs: Number(lookupDurationMs.toFixed ? lookupDurationMs.toFixed(2) : lookupDurationMs),
      resultCount: results.length,
      ...(bestResult ? {
        cityName: bestResult.cityName,
        admin1: bestResult.admin1,
        country: bestResult.country,
        distanceKm: bestResult.distanceKm
      } : {})
    };
    if (weatherSnapshot) {
      logEntry.weather = weatherSnapshot;
    }
    console.log('reverse-geocode: Attempting to append log entry:', logEntry);
    await appendLog(logEntry);
    console.log('reverse-geocode: Log entry appended successfully');
  } catch (logError) {
    console.error('reverse-geocode: log write failed (non-fatal)', logError);
  }

  res.status(200).json({
    lat,
    lon,
    results,
    metrics: {
      datasetFile: datasetInfo?.fileName || path.basename(DATA_PATH),
      datasetPath: datasetInfo?.filePath || DATA_PATH,
      datasetLoadMs: datasetInfo?.loadDurationMs ?? null,
      fileSizeBytes: datasetInfo?.fileSizeBytes ?? null,
      lookupMs: Number(lookupDurationMs.toFixed ? lookupDurationMs.toFixed(2) : lookupDurationMs),
      resultCount: results.length,
      timestamp: new Date().toISOString(),
      latitude: lat,
      longitude: lon
    }
  });
  } catch (error) {
    console.error('reverse-geocode: unhandled error', error);
    res.status(500).json({
      error: 'unexpected_error',
      message: error?.message || 'Unknown error',
      stack: error?.stack || null
    });
  }
}
