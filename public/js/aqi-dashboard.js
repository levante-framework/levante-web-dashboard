const SITE_SOURCE = './gallery/locate-me/seed-points.json';
const BOUNDING_BOX_SIZES_KM = [10, 25, 50];
const A_MAX = 350;
const PM25_MAX = 150;

function apiUrl(path) {
  return path;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function approxDistanceKm(lat1, lon1, lat2, lon2) {
  const latA = Number(lat1);
  const lonA = Number(lon1);
  const latB = Number(lat2);
  const lonB = Number(lon2);
  if (![latA, lonA, latB, lonB].every(Number.isFinite)) return Infinity;
  const meanLatRad = ((latA + latB) / 2) * (Math.PI / 180);
  const dLat = (latB - latA) * 111.32;
  const dLon = (lonB - lonA) * 111.32 * Math.cos(meanLatRad);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

function boundingBoxAround(lat, lon, sizeKm) {
  const halfKm = sizeKm / 2;
  const dLat = halfKm / 111.0;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLon = cos ? halfKm / (111.0 * cos) : 0;
  return {
    lat1: lat - dLat,
    lon1: lon - dLon,
    lat2: lat + dLat,
    lon2: lon + dLon
  };
}

function airQualityCategory(aqi) {
  const n = Number(aqi);
  if (!Number.isFinite(n)) return { label: 'Unknown', color: '#64748b' };
  if (n <= 50) return { label: 'Good', color: '#16a34a' };
  if (n <= 100) return { label: 'Moderate', color: '#ca8a04' };
  if (n <= 150) return { label: 'Unhealthy for sensitive groups', color: '#ea580c' };
  if (n <= 200) return { label: 'Unhealthy', color: '#dc2626' };
  if (n <= 300) return { label: 'Very unhealthy', color: '#9333ea' };
  return { label: 'Hazardous', color: '#7f1d1d' };
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data?.reason || data?.error || `HTTP ${response.status}`;
    throw new Error(reason);
  }
  return data;
}

async function fetchStationsForSite(site) {
  for (const sizeKm of BOUNDING_BOX_SIZES_KM) {
    const box = boundingBoxAround(site.lat, site.lon, sizeKm);
    const latlng = [box.lat1, box.lon1, box.lat2, box.lon2].map((v) => v.toFixed(5)).join(',');
    const data = await fetchJson(apiUrl(`/api/air-quality?latlng=${encodeURIComponent(latlng)}`));
    if (data?.ok && Array.isArray(data.stations) && data.stations.length > 0) {
      return { stations: data.stations, requestedAreaKm: sizeKm };
    }
  }
  return { stations: [], requestedAreaKm: null };
}

function pickNearestStation(stations, site) {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const station of stations) {
    const d = approxDistanceKm(site.lat, site.lon, station.lat, station.lon);
    if (Number.isFinite(d) && d < nearestDistance) {
      nearest = station;
      nearestDistance = d;
    }
  }
  return {
    station: nearest,
    distanceKm: Number.isFinite(nearestDistance) ? Math.round(nearestDistance * 10) / 10 : null
  };
}

async function enrichStation(station) {
  if (!station || station.uid == null) {
    return {
      aqi: toNumber(station?.aqi),
      dominantPollutant: null,
      pollutants: {},
      observedAt: station?.observedAt || null
    };
  }
  const details = await fetchJson(apiUrl(`/api/air-quality?uid=${encodeURIComponent(station.uid)}`));
  if (!details?.ok || !details.station) {
    return {
      aqi: toNumber(station?.aqi),
      dominantPollutant: null,
      pollutants: {},
      observedAt: station?.observedAt || null
    };
  }
  return {
    aqi: toNumber(details.station.aqi) ?? toNumber(station?.aqi),
    dominantPollutant: details.station.dominantPollutant || null,
    pollutants: details.station.pollutants || {},
    observedAt: details.station.observedAt || station?.observedAt || null,
    stationName: details.station.name || station?.name || null
  };
}

async function fetchSiteAirQuality(site) {
  const start = performance.now();
  const { stations, requestedAreaKm } = await fetchStationsForSite(site);
  if (!stations.length) {
    return {
      ...site,
      ok: false,
      error: 'No reporting station found in bounds lookup.'
    };
  }
  const { station, distanceKm } = pickNearestStation(stations, site);
  if (!station) {
    return {
      ...site,
      ok: false,
      error: 'Could not determine nearest station.'
    };
  }
  const enriched = await enrichStation(station);
  const aqi = toNumber(enriched.aqi);
  const pm25 = toNumber(enriched.pollutants?.pm25);
  const category = airQualityCategory(aqi);
  return {
    ...site,
    ok: true,
    aqi,
    pm25,
    category,
    dominantPollutant: enriched.dominantPollutant,
    observedAt: enriched.observedAt,
    stationName: enriched.stationName || station.name || null,
    distanceKm,
    requestedAreaKm,
    elapsedMs: Math.round(performance.now() - start)
  };
}

function createSiteCard(result) {
  if (!result.ok) {
    return `
      <article class="site-card site-card-error">
        <header class="site-header">
          <h3>${result.label}</h3>
          <span class="site-country">${result.country}</span>
        </header>
        <p class="site-error">${result.error}</p>
      </article>
    `;
  }

  const aqi = Number.isFinite(result.aqi) ? result.aqi : null;
  const pm25 = Number.isFinite(result.pm25) ? result.pm25 : null;
  const aqiPct = aqi == null ? 0 : clamp((aqi / A_MAX) * 100, 0, 100);
  const pmPct = pm25 == null ? 0 : clamp((pm25 / PM25_MAX) * 100, 0, 100);
  const pmColor = pm25 == null ? 'var(--text-muted)' : airQualityCategory(pm25 * 2).color;

  return `
    <article class="site-card">
      <header class="site-header">
        <h3>${result.label}</h3>
        <span class="site-country">${result.country}</span>
      </header>
      <div class="metric-row">
        <div>
          <div class="metric-label">AQI</div>
          <div class="metric-value" style="color:${result.category.color};">${aqi == null ? 'N/A' : aqi}</div>
          <div class="metric-subtext">${result.category.label}</div>
        </div>
        <div class="metric-bar-wrap">
          <div class="metric-bar">
            <span class="metric-bar-fill" style="width:${aqiPct}%; background:${result.category.color};"></span>
          </div>
        </div>
      </div>
      <div class="metric-row">
        <div>
          <div class="metric-label">PM2.5 (ug/m3)</div>
          <div class="metric-value">${pm25 == null ? 'N/A' : pm25}</div>
          <div class="metric-subtext">Primary particulate</div>
        </div>
        <div class="metric-bar-wrap">
          <div class="metric-bar">
            <span class="metric-bar-fill" style="width:${pmPct}%; background:${pmColor};"></span>
          </div>
        </div>
      </div>
      <footer class="site-footer">
        <span>${result.stationName || 'Station unknown'}</span>
        <span>${result.distanceKm == null ? 'distance N/A' : `${result.distanceKm} km`}</span>
      </footer>
    </article>
  `;
}

function renderSummary(results) {
  const okRows = results.filter((r) => r.ok);
  const counts = {
    total: results.length,
    ok: okRows.length,
    highAqi: okRows.filter((r) => Number.isFinite(r.aqi) && r.aqi > 100).length,
    highPm: okRows.filter((r) => Number.isFinite(r.pm25) && r.pm25 > 35).length
  };
  const avgAqi = okRows.length
    ? Math.round(okRows.reduce((sum, r) => sum + (Number.isFinite(r.aqi) ? r.aqi : 0), 0) / okRows.length)
    : null;
  const avgPm = okRows.length
    ? (okRows.reduce((sum, r) => sum + (Number.isFinite(r.pm25) ? r.pm25 : 0), 0) / okRows.length).toFixed(1)
    : null;

  return `
    <div class="summary-card">
      <div class="summary-label">Sites with live readings</div>
      <div class="summary-value">${counts.ok}/${counts.total}</div>
      <div class="summary-detail">${counts.highAqi} sites AQI &gt; 100</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Average AQI</div>
      <div class="summary-value">${avgAqi == null ? 'N/A' : avgAqi}</div>
      <div class="summary-detail">${counts.highPm} sites PM2.5 &gt; 35 ug/m3</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Average PM2.5</div>
      <div class="summary-value">${avgPm == null ? 'N/A' : avgPm}</div>
      <div class="summary-detail">Using nearest WAQI station per site</div>
    </div>
  `;
}

async function loadLevanteSites() {
  const data = await fetchJson(SITE_SOURCE);
  const points = Array.isArray(data?.points) ? data.points : [];
  const seen = new Set();
  const sites = points
    .filter((point) => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)))
    .map((point) => ({
      id: String(point.id || `${point.label}-${point.lat}-${point.lon}`),
      label: String(point.label || point.id || 'Unknown site'),
      country: String(point.country || '').toUpperCase(),
      lat: Number(point.lat),
      lon: Number(point.lon)
    }))
    .filter((site) => {
      if (seen.has(site.id)) return false;
      seen.add(site.id);
      return true;
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  if (!sites.length) {
    throw new Error('No Levante sites found in seed-points source.');
  }
  return sites;
}

async function mapWithConcurrency(items, worker, concurrency = 6) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      try {
        results[current] = await worker(items[current], current);
      } catch (error) {
        results[current] = {
          ...items[current],
          ok: false,
          error: error?.message || 'Unknown error'
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function setStatus(message, kind = 'info') {
  const el = document.getElementById('statusText');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
}

function setUpdatedAt(timestamp) {
  const el = document.getElementById('updatedAt');
  if (!el) return;
  if (!timestamp) {
    el.textContent = 'Not loaded yet';
    return;
  }
  const d = new Date(timestamp);
  el.textContent = Number.isNaN(d.getTime()) ? 'Unknown' : d.toLocaleString();
}

async function refreshDashboard() {
  const refreshButton = document.getElementById('refreshAqiBtn');
  const sitesContainer = document.getElementById('siteGrid');
  const summaryContainer = document.getElementById('summaryGrid');

  if (!refreshButton || !sitesContainer || !summaryContainer) return;

  refreshButton.disabled = true;
  refreshButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Refreshing...';
  setStatus('Loading Levante site list...', 'loading');

  try {
    const sites = await loadLevanteSites();
    setStatus(`Refreshing live air quality for ${sites.length} Levante sites...`, 'loading');
    const results = await mapWithConcurrency(sites, fetchSiteAirQuality, 6);
    summaryContainer.innerHTML = renderSummary(results);
    sitesContainer.innerHTML = results.map(createSiteCard).join('');
    setUpdatedAt(new Date().toISOString());
    const okCount = results.filter((r) => r.ok).length;
    setStatus(`Loaded live AQI and PM2.5 for ${okCount}/${results.length} sites.`, 'success');
  } catch (error) {
    console.error('AQI dashboard refresh failed', error);
    setStatus(`Failed to load AQI data: ${error?.message || 'Unknown error'}`, 'error');
  } finally {
    refreshButton.disabled = false;
    refreshButton.innerHTML = '<i class="fas fa-rotate"></i> Refresh Data';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const refreshButton = document.getElementById('refreshAqiBtn');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      refreshDashboard();
    });
  }
  refreshDashboard();
});
