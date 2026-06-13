const SITE_CONFIG_SOURCE = './data/aqi-sites.json';
const BOUNDING_BOX_SIZES_KM = [10, 25, 50];
const A_MAX = 350;
const PM25_MAX = 300;

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

function normalizeSiteKeyPart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function canonicalCountryCode(value) {
  const v = normalizeSiteKeyPart(value).replace(/[^a-z]/g, '');
  const map = {
    us: 'US',
    usa: 'US',
    unitedstates: 'US',
    uk: 'GB',
    gb: 'GB',
    greatbritain: 'GB',
    unitedkingdom: 'GB',
    de: 'DE',
    germany: 'DE',
    co: 'CO',
    colombia: 'CO',
    ca: 'CA',
    canada: 'CA',
    ch: 'CH',
    switzerland: 'CH',
    nl: 'NL',
    netherlands: 'NL',
    tw: 'TW',
    taiwan: 'TW'
  };
  if (map[v]) return map[v];
  return String(value || '').trim().toUpperCase();
}

function hasDiacritics(value) {
  const s = String(value || '');
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') !== s;
}

function choosePreferredLabel(currentLabel, nextLabel) {
  const a = String(currentLabel || '').trim();
  const b = String(nextLabel || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (hasDiacritics(b) && !hasDiacritics(a)) return b;
  if (hasDiacritics(a) && !hasDiacritics(b)) return a;
  if (b.length > a.length) return b;
  return a;
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

function rankStationsByDistance(stations, site) {
  return (stations || [])
    .map((station) => {
      const distanceKm = approxDistanceKm(site.lat, site.lon, station.lat, station.lon);
      return {
        station,
        distanceKm: Number.isFinite(distanceKm) ? Math.round(distanceKm * 10) / 10 : null,
        rawDistanceKm: distanceKm
      };
    })
    .filter((entry) => Number.isFinite(entry.rawDistanceKm))
    .sort((a, b) => a.rawDistanceKm - b.rawDistanceKm);
}

function isTrustworthyReading({ aqi, pm25, observedAt }) {
  const hasPositiveAqi = Number.isFinite(aqi) && aqi > 0;
  const hasPm25 = Number.isFinite(pm25);
  const hasObservedAt = Boolean(observedAt);
  return hasPositiveAqi && (hasPm25 || hasObservedAt);
}

function median(numbers) {
  const vals = (numbers || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

function stationSourceScore(name) {
  const text = String(name || '').trim();
  if (!text) return 0;
  const trustedSignals = /(university|ucsf|epa|environment|ministry|department|monitor|station|airport|city|county|state|national|institute|government|municipal|observatory|meteo|aqms)/i;
  const suspiciousSignals = /(purpleair|sensor|private|test|home|house|apartment|residence|villa|emperor)/i;

  let score = 0;
  if (trustedSignals.test(text)) score += 2;
  if (text.includes(',')) score += 0.8;
  if (/^[A-Z]{2,}\b/.test(text)) score += 0.7; // Acronym-led names are often institutional.
  if (suspiciousSignals.test(text)) score -= 2;

  // Penalize generic person-like two-word names without trust signals.
  if (!trustedSignals.test(text) && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(text)) {
    score -= 1.5;
  }
  return score;
}

function selectBestReading(candidates) {
  const rows = (candidates || []).filter((row) => Number.isFinite(row?.aqi));
  if (!rows.length) return null;
  const aqiMedian = median(rows.map((row) => row.aqi));

  let best = rows[0];
  let bestScore = -Infinity;
  for (const row of rows) {
    const distance = Number.isFinite(row.distanceKm) ? row.distanceKm : 999;
    const hasObservedAt = row.observedAt ? 1 : 0;
    const hasPm25 = Number.isFinite(row.pm25) ? 1 : 0;
    const sourceScore = stationSourceScore(row.stationName || row?.station?.name || '');
    const outlierPenalty = (Number.isFinite(aqiMedian) && Math.abs(row.aqi - aqiMedian) > 30) ? 2.2 : 0;
    const score =
      (hasObservedAt * 2.0) +
      (hasPm25 * 1.6) +
      sourceScore -
      (distance * 0.22) -
      outlierPenalty;

    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
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

function pm25Category(pm25) {
  const n = Number(pm25);
  if (!Number.isFinite(n)) return { label: 'Unknown', color: '#64748b' };
  if (n <= 12.0) return { label: 'Good', color: '#16a34a' };
  if (n <= 35.4) return { label: 'Moderate', color: '#ca8a04' };
  if (n <= 55.4) return { label: 'Unhealthy for sensitive groups', color: '#ea580c' };
  if (n <= 150.4) return { label: 'Unhealthy', color: '#dc2626' };
  if (n <= 250.4) return { label: 'Very unhealthy', color: '#9333ea' };
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
  const ranked = rankStationsByDistance(stations, site);
  if (!ranked.length) {
    return {
      ...site,
      ok: false,
      error: 'Could not determine nearest station.'
    };
  }
  const candidateLimit = Math.min(ranked.length, 8);
  const trustedCandidates = [];
  const fallbackCandidates = [];

  for (let i = 0; i < candidateLimit; i += 1) {
    const candidate = ranked[i];
    const station = candidate.station;
    const mapAqi = toNumber(station?.aqi);
    if (Number.isFinite(mapAqi) && mapAqi <= 0) {
      continue;
    }
    const enriched = await enrichStation(station);
    const resolvedAqi = toNumber(enriched.aqi) ?? mapAqi;
    const pm25 = toNumber(enriched.pollutants?.pm25);
    const observedAt = enriched.observedAt || station?.observedAt || null;
    const stationName = enriched.stationName || station?.name || null;
    const candidateReading = {
      station,
      distanceKm: candidate.distanceKm,
      aqi: resolvedAqi,
      pm25,
      observedAt,
      stationName,
      dominantPollutant: enriched.dominantPollutant || null
    };

    if (Number.isFinite(resolvedAqi)) {
      fallbackCandidates.push(candidateReading);
    }
    if (isTrustworthyReading(candidateReading)) {
      trustedCandidates.push(candidateReading);
    }
  }

  let finalReading = selectBestReading(trustedCandidates) || selectBestReading(fallbackCandidates);
  if (!finalReading) {
    const { station, distanceKm } = ranked[0];
    const mapAqi = toNumber(station?.aqi);
    finalReading = {
      station,
      distanceKm,
      aqi: mapAqi,
      pm25: null,
      observedAt: station?.observedAt || null,
      stationName: station?.name || null,
      dominantPollutant: null
    };
  }

  const aqi = toNumber(finalReading.aqi);
  const pm25 = toNumber(finalReading.pm25);
  const category = airQualityCategory(aqi);
  return {
    ...site,
    ok: true,
    aqi,
    pm25,
    category,
    dominantPollutant: finalReading.dominantPollutant,
    observedAt: finalReading.observedAt,
    stationName: finalReading.stationName,
    distanceKm: finalReading.distanceKm,
    requestedAreaKm,
    elapsedMs: Math.round(performance.now() - start)
  };
}

function createSiteCard(result) {
  if (!result.ok) {
    return `
      <article class="site-card site-card-error">
        <div class="site-meta">
          <header class="site-header">
            <h3>${result.label}</h3>
            <span class="site-country">${result.country}</span>
          </header>
        </div>
        <p class="site-error">${result.error}</p>
      </article>
    `;
  }

  const aqi = Number.isFinite(result.aqi) ? result.aqi : null;
  const pm25 = Number.isFinite(result.pm25) ? result.pm25 : null;
  const aqiPct = aqi == null ? 0 : clamp((aqi / A_MAX) * 100, 0, 100);
  const pmPct = pm25 == null ? 0 : clamp((pm25 / PM25_MAX) * 100, 0, 100);
  const pmCategoryInfo = pm25Category(pm25);
  const aqiLabel = result.category.label;
  const pmLabel = pmCategoryInfo.label;
  const aqiValueText = aqi == null ? 'N/A' : String(Math.round(aqi));
  const pmValueText = pm25 == null ? 'N/A' : String(Math.round(pm25 * 10) / 10);
  const aqiTicks = [50, 100, 150, 200, 300]
    .map((value) => `<span class="metric-tick" style="left:${clamp((value / A_MAX) * 100, 0, 100)}%;"></span>`)
    .join('');
  const pmTicks = [12, 35.4, 55.4, 150.4, 250.4]
    .map((value) => `<span class="metric-tick" style="left:${clamp((value / PM25_MAX) * 100, 0, 100)}%;"></span>`)
    .join('');

  return `
    <article class="site-card">
      <div class="site-meta">
        <header class="site-header">
          <h3>${result.label}</h3>
          <span class="site-country">${result.country}</span>
        </header>
        ${result.variants > 1 ? `<div class="site-meta-detail">Merged ${result.variants} nearby entries</div>` : ''}
      </div>
      <div class="site-metrics">
        <div class="metric-row metric-row-bar">
          <div class="metric-left">
            <div class="metric-label">AQI</div>
            <div class="metric-category">${aqiLabel}</div>
          </div>
          <div class="metric-bar-wrap">
            <div class="metric-bar metric-bar-track">
              <span class="metric-bar-fill" style="width:${aqiPct}%; background:${result.category.color};"></span>
              ${aqiTicks}
            </div>
          </div>
          <div class="metric-value">
            <div class="metric-value-main">${aqiValueText}</div>
            <div class="metric-value-sub">/ ${A_MAX}</div>
          </div>
        </div>
        <div class="metric-row metric-row-bar">
          <div class="metric-left">
            <div class="metric-label">PM2.5</div>
            <div class="metric-category">${pmLabel}</div>
          </div>
          <div class="metric-bar-wrap">
            <div class="metric-bar metric-bar-track">
              <span class="metric-bar-fill" style="width:${pmPct}%; background:${pmCategoryInfo.color};"></span>
              ${pmTicks}
            </div>
          </div>
          <div class="metric-value">
            <div class="metric-value-main">${pm25 == null ? 'N/A' : pmValueText}</div>
            <div class="metric-value-sub">/ ${PM25_MAX} ug/m3</div>
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

function hasReading(result) {
  if (!result || result.ok !== true) return false;
  return Number.isFinite(Number(result.aqi)) || Number.isFinite(Number(result.pm25));
}

async function loadLevanteSites() {
  const payload = await fetchJson(SITE_CONFIG_SOURCE);
  const points = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.sites) ? payload.sites : []);
  const grouped = new Map();

  for (const point of points) {
    const lat = Number(point.lat);
    const lon = Number(point.lon ?? point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const label = String(point.city || point.label || point.id || 'Unknown site').trim();
    const country = canonicalCountryCode(point.country || '');
    const key = `${normalizeSiteKeyPart(label)}|${normalizeSiteKeyPart(country)}`;
    const sourceCount = Number(point.count || 0);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        id: String(point.id || `${label}-${country || 'xx'}`),
        label,
        country,
        lat,
        lon,
        sourceCount,
        variants: 1,
        siteType: String(point.siteType || point.type || '').trim() || 'unspecified'
      });
      continue;
    }
    existing.variants += 1;
    existing.label = choosePreferredLabel(existing.label, label);
    if (!existing.siteType || existing.siteType === 'unspecified') {
      const incomingType = String(point.siteType || point.type || '').trim();
      if (incomingType) existing.siteType = incomingType;
    }
    if (sourceCount > existing.sourceCount) {
      existing.lat = lat;
      existing.lon = lon;
      existing.sourceCount = sourceCount;
    }
  }

  // Preserve source order from public/data/aqi-sites.json so manual ordering
  // edits in that file are reflected exactly in the UI.
  const sites = Array.from(grouped.values());

  if (!sites.length) {
    throw new Error(`No sites found in ${SITE_CONFIG_SOURCE}.`);
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
    const visibleResults = results.filter((row) => hasReading(row));
    summaryContainer.innerHTML = renderSummary(visibleResults);
    sitesContainer.innerHTML = visibleResults.map(createSiteCard).join('');
    setUpdatedAt(new Date().toISOString());
    setStatus(`Loaded live AQI and PM2.5 for ${visibleResults.length}/${sites.length} sites.`, 'success');
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
