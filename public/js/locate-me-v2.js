const { createApp, nextTick } = Vue;
const LEAFLET_SOURCES = [
  '/vendor/leaflet/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js'
];

// When running static on localhost, use the deployed API; otherwise use relative.
const API_BASE = (typeof window !== 'undefined' && window.location && window.location.hostname === 'localhost')
  ? 'https://levante-web-dashboard.vercel.app'
  : '';

function apiUrl(path) {
  return `${API_BASE}${path}`;
}


createApp({
  data() {
    return {
      status: 'Click Locate Me to begin',
      results: [],
      coordinates: null,
      latestMetrics: null,
      citiesDataset: null,
      citiesDatasetInfo: null,
      citiesDatasetPromise: null,
      countriesDataset: null,
      countriesDatasetInfo: null,
      countriesDatasetPromise: null,
      loading: false,
      error: null,
      showRawLogModal: false,
      showViewLogModal: false,
      showMapModal: false,
      showWhereModal: false,
      whereLoading: false,
      whereError: null,
      whereCountry: null,
      whereStates: [],
      whereCities: [],
      whereCityRecords: [],
      whereCoordinates: null,
      whereResults: [],
      selectedState: '',
      cityQuery: '',
      whereResult: null,
      countryOptions: [],
      countriesLoading: false,
      statesLoading: false,
      citiesLoading: false,
      selectedCountry: '',
      logFileContent: '',
      logEntries: [],
      mapInstance: null,
      mapError: null,
      leafletPromise: null,
      inlineMapInstance: null,
      inlineMapLayers: null,
      gadmPolygonCache: {},
      admPackCache: {},
      admPolygon: null,
      inlineLegendControl: null,
      currentWeather: null,
      weatherStatus: null,
      networkIsp: null,
      networkStatus: null,
      showGeoPermissionModal: false,
      geoPermissionMode: 'preprompt', // 'preprompt' | 'denied'
      logCityCoordCache: {},
    };
  },
  computed: {
    logStats() {
      if (!this.logEntries.length) return null;
      const total = this.logEntries.length;
      const uniqueCities = new Set(this.logEntries.map((entry) => `${entry.cityName || 'unknown'}|${entry.country || ''}`)).size;
      const uniqueCountries = new Set(this.logEntries.map((entry) => entry.country).filter(Boolean)).size;
      const avgLookupMs = (
        this.logEntries.reduce((sum, entry) => sum + (entry.lookupMs || 0), 0) / total || 0
      ).toFixed(1);
      const latest = this.logEntries[0];
      return { total, uniqueCities, uniqueCountries, avgLookupMs, latest };
    },
    topCities() {
      if (!this.logEntries.length) return [];
      const counts = new Map();
      this.logEntries.forEach((entry) => {
        const key = entry.cityName || 'Unknown city';
        counts.set(key, (counts.get(key) || 0) + 1);
      });
      return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => ({ name, count }));
    },
    topCountries() {
      if (!this.logEntries.length) return [];
      const counts = new Map();
      this.logEntries.forEach((entry) => {
        const key = entry.country || 'Unknown';
        counts.set(key, (counts.get(key) || 0) + 1);
      });
      return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => ({ name, count }));
    },
    latestWeather() {
      return this.logEntries.find((entry) => entry.weather) || null;
    },
    filteredCities() {
      if (!this.whereCities || !this.whereCities.length) return [];
      const q = this.cityQuery.trim().toLowerCase();
      if (!q) return this.whereCities.slice(0, 10);
      return this.whereCities.filter((c) => c.toLowerCase().includes(q)).slice(0, 10);
    },
    selectedCityDetail() {
      if (!this.whereCityRecords || !this.whereCityRecords.length) return null;
      const q = this.cityQuery.trim().toLowerCase();
      if (!q) return null;
      const inState = this.whereCityRecords.filter(
        (r) => !this.selectedState || r.admin1 === this.selectedState
      );
      const exact = inState.find((r) => (r.name || '').toLowerCase() === q);
      if (exact) return exact;
      return inState.find((r) => (r.name || '').toLowerCase().includes(q)) || null;
    }
  },
  methods: {
    readLocalJson(key) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (_) {
        return null;
      }
    },
    writeLocalJson(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (_) {}
    },
    async fetchNetworkIsp() {
      // Off-device lookup (request IP -> ISP). Cached to avoid repeated calls.
      const cacheKey = 'isp:v1';
      const cached = this.readLocalJson(cacheKey);
      if (cached?.expiresAt && Date.now() < cached.expiresAt && cached?.data) {
        return cached.data;
      }

      const res = await fetch(apiUrl('/api/network-isp'), { cache: 'no-store' });
      const json = await res.json().catch(() => null);
      const data = json && typeof json === 'object' ? json : null;
      this.writeLocalJson(cacheKey, {
        expiresAt: Date.now() + 6 * 60 * 60 * 1000,
        data
      });
      return data;
    },
    async getGeolocationPermissionState() {
      // Returns: 'granted' | 'prompt' | 'denied' | 'unknown'
      try {
        if (!navigator?.permissions?.query) return 'unknown';
        const res = await navigator.permissions.query({ name: 'geolocation' });
        const s = (res && res.state) ? String(res.state) : 'unknown';
        if (s === 'granted' || s === 'prompt' || s === 'denied') return s;
        return 'unknown';
      } catch (_) {
        return 'unknown';
      }
    },
    openGeoPermissionModal(mode = 'preprompt') {
      this.geoPermissionMode = mode === 'denied' ? 'denied' : 'preprompt';
      this.showGeoPermissionModal = true;
    },
    closeGeoPermissionModal() {
      this.showGeoPermissionModal = false;
    },
    async confirmEnableGeolocation() {
      this.closeGeoPermissionModal();
      await this.runLocateWithGeolocation();
    },
    useWhereInstead() {
      this.closeGeoPermissionModal();
      this.openWhereAmI();
    },
    roundToStep(value, step) {
      const n = Number(value);
      const s = Number(step);
      if (!Number.isFinite(n) || !Number.isFinite(s) || s <= 0) return n;
      return Math.round(n / s) * s;
    },
    bboxFromGeoJSON(obj) {
      // Returns { minLon, minLat, maxLon, maxLat } or null
      const geom = obj?.type === 'Feature' ? obj.geometry : obj;
      const coords = geom?.coordinates;
      if (!geom || !coords) return null;
      let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
      const walk = (c) => {
        if (!c) return;
        if (typeof c[0] === 'number' && typeof c[1] === 'number') {
          const lon = Number(c[0]);
          const lat = Number(c[1]);
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
          minLon = Math.min(minLon, lon);
          maxLon = Math.max(maxLon, lon);
          minLat = Math.min(minLat, lat);
          maxLat = Math.max(maxLat, lat);
          return;
        }
        if (Array.isArray(c)) c.forEach(walk);
      };
      walk(coords);
      if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) return null;
      return { minLon, minLat, maxLon, maxLat };
    },
    pickCoarseWeatherQueryPoint() {
      // Prefer ADM2 bbox center (regional, coarse). Fall back to nearest-city center.
      const adm2 = this.admPolygon?.adm2 || null;
      const bbox = adm2 ? this.bboxFromGeoJSON(adm2) : null;
      if (bbox) {
        return {
          lat: (bbox.minLat + bbox.maxLat) / 2,
          lon: (bbox.minLon + bbox.maxLon) / 2,
          basis: 'adm2_bbox_center'
        };
      }
      const best = this.results?.[0] || null;
      const lat = Number(best?.lat);
      const lon = Number(best?.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return { lat, lon, basis: 'nearest_city_center' };
      }
      // Last resort: do not use precise GPS; round it aggressively if present.
      const gpsLat = Number(this.coordinates?.lat);
      const gpsLon = Number(this.coordinates?.lon);
      if (Number.isFinite(gpsLat) && Number.isFinite(gpsLon)) {
        return { lat: this.roundToStep(gpsLat, 1.0), lon: this.roundToStep(gpsLon, 1.0), basis: 'gps_rounded_1deg' };
      }
      return null;
    },
    weatherCodeDescription(code) {
      // Open-Meteo WMO weather interpretation codes
      const c = Number(code);
      if (!Number.isFinite(c)) return 'Unknown';
      const map = {
        0: 'Clear',
        1: 'Mostly clear',
        2: 'Partly cloudy',
        3: 'Overcast',
        45: 'Fog',
        48: 'Rime fog',
        51: 'Light drizzle',
        53: 'Drizzle',
        55: 'Heavy drizzle',
        56: 'Freezing drizzle',
        57: 'Heavy freezing drizzle',
        61: 'Light rain',
        63: 'Rain',
        65: 'Heavy rain',
        66: 'Freezing rain',
        67: 'Heavy freezing rain',
        71: 'Light snow',
        73: 'Snow',
        75: 'Heavy snow',
        77: 'Snow grains',
        80: 'Light showers',
        81: 'Showers',
        82: 'Heavy showers',
        85: 'Snow showers',
        86: 'Heavy snow showers',
        95: 'Thunderstorm',
        96: 'Thunderstorm (hail)',
        99: 'Thunderstorm (heavy hail)'
      };
      return map[c] || 'Unknown';
    },
    weatherCacheKey(country, admin1, roundedLat, roundedLon) {
      const c = (country || '').toString().trim().toUpperCase() || 'XX';
      const a1 = (admin1 || '').toString().trim().toUpperCase() || 'NA';
      return `wx:v1:${c}:${a1}:${roundedLat.toFixed(2)}:${roundedLon.toFixed(2)}`;
    },
    readWeatherCache(key) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const exp = Number(parsed.expiresAt || 0);
        if (exp && Date.now() > exp) return null;
        return parsed;
      } catch (_) {
        return null;
      }
    },
    writeWeatherCache(key, payload) {
      try {
        localStorage.setItem(key, JSON.stringify(payload));
      } catch (_) {}
    },
    async fetchCoarseWeather() {
      const best = this.results?.[0] || null;
      const country = (best?.country || this.latestMetrics?.seedCountry || '').toString().trim().toUpperCase();
      const admin1 = (best?.admin1 || '').toString().trim();
      const qp = this.pickCoarseWeatherQueryPoint();
      if (!qp) return null;

      // Round query point to reduce precision before network call (privacy).
      const step = 0.25; // ~25km at equator; coarser at higher latitudes
      const qLat = this.roundToStep(qp.lat, step);
      const qLon = this.roundToStep(qp.lon, step);
      const cacheKey = this.weatherCacheKey(country, admin1, qLat, qLon);
      const cached = this.readWeatherCache(cacheKey);
      if (cached?.weather) {
        return cached.weather;
      }

      const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(qLat)}&longitude=${encodeURIComponent(qLon)}&current_weather=true&timezone=auto`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`weather_fetch_failed_${res.status}`);
      const json = await res.json();
      const cw = json?.current_weather || null;
      if (!cw) return null;

      const weather = {
        source: 'open-meteo',
        // keep shape compatible with the log modal in locate-me.html
        temperature: Number(cw.temperature),
        windKph: Number(cw.windspeed),
        weathercode: Number(cw.weathercode),
        description: this.weatherCodeDescription(cw.weathercode),
        observedAt: cw.time || null,
        coarse: {
          basis: qp.basis,
          roundingDeg: step,
          queryLat: qLat,
          queryLon: qLon,
          country: country || null,
          admin1: admin1 || null
        }
      };

      this.writeWeatherCache(cacheKey, {
        expiresAt: Date.now() + 45 * 60 * 1000,
        fetchedAt: Date.now(),
        weather
      });
      return weather;
    },
    updateInlineLegend() {
      if (!this.inlineLegendControl) return;
      const best = this.results?.[0] || null;
      const country = (best?.country || '').toString().trim();
      const admin1 = (best?.admin1 || '').toString().trim();
      const localName = this.admPolygon?.local?.properties?.name || 'Local';
      const regionalName = this.admPolygon?.adm2?.properties?.name || 'Regional (ADM2)';
      const wx = this.currentWeather;
      const wxLine = wx
        ? `Weather: ${Number.isFinite(wx.temperature) ? Math.round(wx.temperature) + '°C' : '—'} · ${wx.description || '—'}`
        : (this.weatherStatus ? `Weather: ${this.weatherStatus}` : 'Weather: —');
      const isp = this.networkIsp;
      const ispLabel = isp?.isStarlinkLikely ? 'Starlink (likely)' : (isp?.isp || isp?.org || null);
      const ispLine = ispLabel
        ? `ISP: ${ispLabel}`
        : (this.networkStatus ? `ISP: ${this.networkStatus}` : 'ISP: —');

      const div = this.inlineLegendControl.getContainer();
      div.innerHTML = `
        <div class="locate-legend-title">Legend</div>
        <div class="locate-legend-row"><span class="swatch swatch-gps"></span> GPS point</div>
        <div class="locate-legend-row"><span class="swatch swatch-circle"></span> 1 &amp; 5-mile radius circles</div>
        <div class="locate-legend-row"><span class="swatch swatch-red"></span> Red: ${localName}</div>
        <div class="locate-legend-row"><span class="swatch swatch-blue"></span> Blue: ${regionalName}</div>
        <div class="locate-legend-divider"></div>
        <div class="locate-legend-row locate-legend-weather">${wxLine}</div>
        <div class="locate-legend-row locate-legend-isp">${ispLine}</div>
        <div class="locate-legend-footnote">${country}${admin1 ? ' · ' + admin1 : ''} (coarse lookup)</div>
      `;
    },
    async fetchGzJson(url) {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`fetch failed (${res.status})`);
      const buf = await res.arrayBuffer();
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('DecompressionStream not supported in this browser');
      }
      const ds = new DecompressionStream('gzip');
      const stream = new Response(new Blob([buf]).stream().pipeThrough(ds));
      return stream.json();
    },
    async loadCitiesDataset() {
      if (this.citiesDataset && this.citiesDatasetInfo) return this.citiesDatasetInfo;
      if (this.citiesDatasetPromise) return this.citiesDatasetPromise;

      const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      this.citiesDatasetPromise = (async () => {
        const fileName = 'cities.min.json.gz';
        const cities = await this.fetchGzJson('/geocoder/cities.min.json.gz');
        if (!Array.isArray(cities)) {
          throw new Error('cities dataset malformed');
        }
        const endedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const loadDurationMs = Math.round(endedAt - startedAt);
        this.citiesDataset = cities;
        this.citiesDatasetInfo = {
          datasetFile: fileName,
          totalPoints: cities.length,
          datasetLoadMs: loadDurationMs,
          loadedAt: new Date().toISOString(),
          source: 'client'
        };
        return this.citiesDatasetInfo;
      })();

      try {
        return await this.citiesDatasetPromise;
      } finally {
        this.citiesDatasetPromise = null;
      }
    },
    async loadCountriesDataset() {
      if (this.countriesDataset && this.countriesDatasetInfo) return this.countriesDatasetInfo;
      if (this.countriesDatasetPromise) return this.countriesDatasetPromise;

      const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      this.countriesDatasetPromise = (async () => {
        const fileName = 'countries.min.json.gz';
        const fc = await this.fetchGzJson('/adm0/countries.min.json.gz');
        if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
          throw new Error('countries dataset malformed');
        }
        const endedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const loadDurationMs = Math.round(endedAt - startedAt);
        this.countriesDataset = fc;
        this.countriesDatasetInfo = {
          datasetFile: fileName,
          totalFeatures: fc.features.length,
          datasetLoadMs: loadDurationMs,
          loadedAt: new Date().toISOString(),
          source: 'client'
        };
        return this.countriesDatasetInfo;
      })();

      try {
        return await this.countriesDatasetPromise;
      } finally {
        this.countriesDatasetPromise = null;
      }
    },
    lookupCountryIso2(lat, lon) {
      const fc = this.countriesDataset;
      if (!fc || !Array.isArray(fc.features)) return null;
      const pt = [lon, lat];
      let best = null;
      let bestArea = Infinity;
      for (const feature of fc.features) {
        if (!feature?.geometry) continue;
        if (!this.pointInPolygon(pt, feature.geometry)) continue;
        const area = this.polygonArea(feature.geometry);
        if (area < bestArea) {
          bestArea = area;
          best = feature;
        }
      }
      const iso2 = best?.properties?.iso2;
      return iso2 ? String(iso2).trim().toLowerCase() : null;
    },
    approxDistanceKm(lat1, lon1, lat2, lon2) {
      // Fast equirectangular approximation; good enough for nearest-city lookup on cities5000.
      const toRad = (d) => (d * Math.PI) / 180;
      const R = 6371;
      const x = toRad(lon2 - lon1) * Math.cos(toRad((lat1 + lat2) / 2));
      const y = toRad(lat2 - lat1);
      return R * Math.sqrt(x * x + y * y);
    },
    findNearestCities(lat, lon, limit = 2, maxDistanceKm = 150, countryIso2 = null) {
      const cities = this.citiesDataset || [];
      const best = [];
      for (const c of cities) {
        if (!c) continue;
        if (countryIso2 && String(c.country || '').toLowerCase() !== countryIso2) continue;
        const d = this.approxDistanceKm(lat, lon, Number(c.lat), Number(c.lon));
        if (!Number.isFinite(d) || d > maxDistanceKm) continue;
        best.push({ ...c, distanceKm: Math.round(d * 10) / 10 });
      }
      best.sort((a, b) => (a.distanceKm || 1e9) - (b.distanceKm || 1e9));
      return best.slice(0, limit);
    },
    async appendClientLog(entry) {
      // Critical privacy rule: do not send raw GPS coords off-device.
      if (entry && (entry.latitude != null || entry.longitude != null || entry.lat != null || entry.lon != null)) {
        throw new Error('Refusing to log raw coordinates');
      }
      try {
        await fetch(apiUrl('/api/location-log'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry || {})
        });
      } catch (err) {
        // Logging should never break locating.
        console.warn('client log append failed', err?.message || err);
      }
    },
    formatBytes(bytes) {
      if (!bytes) return 'N/A';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },
    formatDateTime(isoString) {
      if (!isoString) return 'N/A';
      try {
        const date = new Date(isoString);
        return date.toLocaleString();
      } catch {
        return isoString;
      }
    },
    resetWhereModalState() {
      this.whereLoading = false;
      this.whereError = null;
      this.whereCountry = null;
      this.selectedCountry = '';
      this.whereStates = [];
      this.whereCities = [];
      this.whereCityRecords = [];
      this.whereCoordinates = null;
      this.whereResults = [];
      this.selectedState = '';
      this.cityQuery = '';
      this.whereResult = null;
    },
    openWhereAmI() {
      console.log('[WhereAmI] open modal');
      this.resetWhereModalState();
      this.showWhereModal = true;
      this.whereLoading = true;
      this.detectWhereAmI();
    },
    closeWhereModal() {
      this.showWhereModal = false;
    },
    setCitiesFromRecords(records = []) {
      this.whereCityRecords = records || [];
      this.whereCities = this.whereCityRecords.map((r) => r.name).filter(Boolean);
    },
    async fetchGeoMetadata(params = {}) {
      const query = new URLSearchParams(params);
      const res = await fetch(apiUrl(`/api/geocoder-metadata?${query.toString()}`));
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.message || payload?.error || 'Metadata fetch failed');
      }
      return res.json();
    },
    async loadCountries(force = false) {
      if (this.countryOptions.length && !force) return this.countryOptions;
      this.countriesLoading = true;
      try {
        const data = await this.fetchGeoMetadata();
        this.countryOptions = data.countries || [];
      } catch (err) {
        console.warn('Failed to load countries', err);
      } finally {
        this.countriesLoading = false;
      }
      return this.countryOptions;
    },
    async loadStates(country) {
      this.whereStates = [];
      this.statesLoading = true;
      try {
        if (!country) return [];
        const data = await this.fetchGeoMetadata({ country });
        this.whereStates = data.states || [];
        return this.whereStates;
      } catch (err) {
        console.warn('Failed to load states', err);
        return [];
      } finally {
        this.statesLoading = false;
      }
    },
    async loadCities(country, admin1) {
      this.setCitiesFromRecords([]);
      this.citiesLoading = true;
      try {
        if (!country) return [];
        const data = await this.fetchGeoMetadata({ country, admin1: admin1 || '' });
        const cities = data.cities || [];
        this.setCitiesFromRecords(cities);
        return cities;
      } catch (err) {
        console.warn('Failed to load cities', err);
        return [];
      } finally {
        this.citiesLoading = false;
      }
    },
    async handleCountryChange() {
      await this.loadStates(this.selectedCountry);
      this.selectedState = this.whereStates[0] || '';
      await this.loadCities(this.selectedCountry, this.selectedState);
      this.cityQuery = '';
    },
    async handleStateChange() {
      await this.loadCities(this.selectedCountry, this.selectedState);
      this.cityQuery = '';
    },
    updateCitiesForState() {
      if (!this.whereCityRecords.length) {
        this.whereCities = [];
        return;
      }
      if (!this.selectedState) {
        this.whereCities = this.whereCityRecords.map((r) => r.name).filter(Boolean);
        return;
      }
      this.whereCities = this.whereCityRecords
        .filter((r) => r.admin1 === this.selectedState)
        .map((r) => r.name)
        .filter(Boolean);
    },
    async detectWhereAmI() {
      console.log('[WhereAmI] detectWhereAmI start');
      if (!navigator.geolocation) {
        this.whereError = 'Geolocation is not supported by this browser.';
        this.whereLoading = false;
        return;
      }

      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords;
          console.log('[WhereAmI] coords acquired', { latitude, longitude });
          this.whereCoordinates = { lat: latitude, lon: longitude };
          try {
            const query = new URLSearchParams({
              lat: latitude.toString(),
              lon: longitude.toString(),
              limit: '2',
              maxDistanceKm: '150'
            });
            const response = await fetch(apiUrl(`/api/reverse-geocode?${query.toString()}`));
            if (!response.ok) {
              const errPayload = await response.json().catch(() => ({}));
              throw new Error(errPayload?.message || errPayload?.error || 'Reverse geocode failed');
            }
            const payload = await response.json();
            console.log('[WhereAmI] reverse-geocode results', (payload?.results || []).length, payload?.results?.[0]);
            const best = (payload.results && payload.results[0]) || null;
            if (!best) {
              throw new Error('No nearby location found.');
            }
            await this.loadCountries();
            this.selectedCountry = best.country || '';
            await this.loadStates(this.selectedCountry);
            if (best.admin1 && this.whereStates.includes(best.admin1)) {
              this.selectedState = best.admin1;
            } else if (this.whereStates.length) {
              this.selectedState = this.whereStates[0];
            } else {
              this.selectedState = '';
            }
            await this.loadCities(this.selectedCountry, this.selectedState);
            this.cityQuery = best.name || '';
            this.updateCitiesForState();

            this.whereCountry = best.country || 'Unknown';
            this.whereResult = best;
            this.whereResults = payload.results || [];
          } catch (err) {
            console.error('[WhereAmI] lookup failed', err);
            this.whereError = err.message;
          } finally {
            this.whereLoading = false;
          }
        },
        (geoError) => {
          this.whereLoading = false;
          console.warn('[WhereAmI] geolocation error', geoError);
          this.whereError =
            geoError.code === geoError.PERMISSION_DENIED
              ? 'Location permission denied.'
              : geoError.code === geoError.POSITION_UNAVAILABLE
              ? 'Position unavailable.'
              : geoError.code === geoError.TIMEOUT
              ? 'Location request timed out.'
              : 'Location request failed.';
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    },
    normalizeGadmKey(name, admin1, country) {
      return [name, admin1, country]
        .map((part) => (part || '').toString().trim().toLowerCase())
        .join('|');
    },
    async loadAdmPack(country) {
      const code = (country || '').trim().toLowerCase();
      if (!code) return null;
      if (this.admPackCache[code] !== undefined) return this.admPackCache[code];
      try {
        const fetchPack = async (fileName) => {
          // Try API endpoint first (loads from GCS)
          try {
            const res = await fetch(`${apiUrl('/api/adm-pack')}?country=${encodeURIComponent(code)}&file=${encodeURIComponent(fileName)}`, { cache: 'force-cache' });
            if (res.ok) {
              return await res.json();
            }
          } catch (e) {
            // Fall back to direct file access
          }
          
          // Fallback to direct file access (for non-geofabrik files)
          const res = await fetch(`/adm-packs/${code}/${fileName}`, { cache: 'force-cache' });
          if (!res.ok) throw new Error(`pack missing (${res.status})`);
          const buf = await res.arrayBuffer();
          if (typeof DecompressionStream === 'undefined') {
            throw new Error('DecompressionStream not supported in this browser');
          }
          const ds = new DecompressionStream('gzip');
          const stream = new Response(new Blob([buf]).stream().pipeThrough(ds));
          return stream.json();
        };

        const adm2 = await fetchPack('adm2.json.gz');
        // ADM3 is optional; for US we use per-state tract packs (downloaded on demand).
        const adm3 = code === 'us' ? null : await fetchPack('adm3.json.gz').catch(() => null);

        const bundle = { adm2, adm3 };
        this.admPackCache[code] = bundle;
        return bundle;
      } catch (err) {
        console.warn('ADM pack load failed', code, err.message);
        this.admPackCache[code] = null;
        return null;
      }
    },
    async loadUsAdm3Pack(stateAbbr) {
      const st = (stateAbbr || '').toString().trim().toLowerCase();
      if (!st) return null;
      const key = `us:adm3:${st}`;
      if (this.admPackCache[key] !== undefined) return this.admPackCache[key];
      try {
        // Try API endpoint first (loads from GCS)
        try {
          const res = await fetch(`${apiUrl('/api/adm-pack')}?country=us&file=adm3/${st}.json.gz`, { cache: 'force-cache' });
          if (res.ok) {
            const json = await res.json();
            this.admPackCache[key] = json;
            return json;
          }
        } catch (e) {
          // Fall back to direct file access
        }
        
        // Fallback to direct file access
        const json = await this.fetchGzJson(`/adm-packs/us/adm3/${st}.json.gz`);
        this.admPackCache[key] = json;
        return json;
      } catch (err) {
        this.admPackCache[key] = null;
        return null;
      }
    },
    async loadUsPlacePack(stateAbbr) {
      const st = (stateAbbr || '').toString().trim().toLowerCase();
      if (!st) return null;
      const key = `us:adm3-place:${st}`;
      if (this.admPackCache[key] !== undefined) return this.admPackCache[key];
      try {
        // Try API endpoint first (loads from GCS)
        try {
          const res = await fetch(`${apiUrl('/api/adm-pack')}?country=us&file=adm3-place/${st}.json.gz`, { cache: 'force-cache' });
          if (res.ok) {
            const json = await res.json();
            this.admPackCache[key] = json;
            return json;
          }
        } catch (e) {
          // Fall back to direct file access
        }
        
        // Fallback to direct file access
        const json = await this.fetchGzJson(`/adm-packs/us/adm3-place/${st}.json.gz`);
        this.admPackCache[key] = json;
        return json;
      } catch (err) {
        this.admPackCache[key] = null;
        return null;
      }
    },
    pointInRing(pt, ring) {
      const [px, py] = pt;
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const intersect = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi;
        if (intersect) inside = !inside;
      }
      return inside;
    },
    pointInPolygon(pt, geom) {
      if (!geom) return false;
      const type = geom.type;
      const polygons =
        type === 'Polygon'
          ? [geom.coordinates]
          : type === 'MultiPolygon'
          ? geom.coordinates
          : [];
      if (!polygons.length) return false;
      for (const poly of polygons) {
        if (!poly || !poly.length) continue;
        const [outer, ...holes] = poly;
        if (!outer || !outer.length) continue;
        if (!this.pointInRing(pt, outer)) continue;
        let inHole = false;
        for (const hole of holes) {
          if (hole && hole.length && this.pointInRing(pt, hole)) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return true;
      }
      return false;
    },
    polygonArea(geom) {
      const ringArea = (ring = []) => {
        let sum = 0;
        for (let i = 0, len = ring.length; i < len; i++) {
          const [x1, y1] = ring[i];
          const [x2, y2] = ring[(i + 1) % len];
          sum += x1 * y2 - x2 * y1;
        }
        return Math.abs(sum / 2);
      };
      if (!geom) return Infinity;
      const type = geom.type;
      const polys =
        type === 'Polygon'
          ? [geom.coordinates]
          : type === 'MultiPolygon'
          ? geom.coordinates
          : [];
      let total = 0;
      for (const poly of polys) {
        if (!poly || !poly.length) continue;
        const [outer, ...holes] = poly;
        total += ringArea(outer || []);
        for (const hole of holes) {
          total -= ringArea(hole || []);
        }
      }
      return total || Infinity;
    },
    async fetchAdmPolygonFromPack(country, level, lat, lon) {
      const packBundle = await this.loadAdmPack(country);
      const pack =
        packBundle && level === 'adm2'
          ? packBundle.adm2
          : packBundle && level === 'adm3'
          ? packBundle.adm3
          : null;
      if (!pack || !pack.features) return null;
      const pt = [lon, lat];
      let best = null;
      let bestArea = Infinity;
      for (const feature of pack.features) {
        if (!feature?.geometry) continue;
        if (this.pointInPolygon(pt, feature.geometry)) {
          const area = this.polygonArea(feature.geometry);
          if (area < bestArea) {
            bestArea = area;
            best = feature;
          }
        }
      }
      return best;
    },
    async fetchUsAdm3Polygon(stateAbbr, lat, lon) {
      const pack = await this.loadUsAdm3Pack(stateAbbr);
      if (!pack || !pack.features) return null;
      const pt = [lon, lat];
      let best = null;
      let bestArea = Infinity;
      for (const feature of pack.features) {
        if (!feature?.geometry) continue;
        if (this.pointInPolygon(pt, feature.geometry)) {
          const area = this.polygonArea(feature.geometry);
          if (area < bestArea) {
            bestArea = area;
            best = feature;
          }
        }
      }
      return best;
    },
    async fetchUsPlacePolygon(stateAbbr, lat, lon) {
      const pack = await this.loadUsPlacePack(stateAbbr);
      if (!pack || !pack.features) return null;
      const pt = [lon, lat];
      let best = null;
      let bestArea = Infinity;
      for (const feature of pack.features) {
        if (!feature?.geometry) continue;
        if (this.pointInPolygon(pt, feature.geometry)) {
          const area = this.polygonArea(feature.geometry);
          if (area < bestArea) {
            bestArea = area;
            best = feature;
          }
        }
      }
      return best;
    },
    async fetchGadmPolygon(result) {
      if (!result || !result.country || !result.lat || !result.lon) {
        return null;
      }
      const cacheKey = this.normalizeGadmKey('adm2', result.admin1, result.country);
      if (this.gadmPolygonCache[cacheKey] !== undefined) {
        return this.gadmPolygonCache[cacheKey];
      }
      const feature = await this.fetchAdmPolygonFromPack(result.country, 'adm2', result.lat, result.lon);
      this.gadmPolygonCache[cacheKey] = feature || null;
      return feature || null;
    },
    async drawRegionPolygons(results = []) {
      if (!results.length || !this.inlineMapLayers) {
        return;
      }
      const colors = ['#ea580c', '#2563eb'];
      await Promise.all(
        results.slice(0, 2).map(async (result, index) => {
          const feature = await this.fetchGadmPolygon(result);
          if (!feature) return;
          L.geoJSON(feature, {
            style: {
              color: colors[index % colors.length],
              weight: 3,
              dashArray: '6,4',
              fillOpacity: 0.04
            }
          }).addTo(this.inlineMapLayers);
        })
      );
    },
    async locate() {
      if (!navigator.geolocation) {
        this.error = 'Geolocation is not supported by this browser.';
        this.status = 'Geolocation unavailable';
        return;
      }

      // Friendly UX: show our own explanation before triggering the browser prompt.
      const state = await this.getGeolocationPermissionState();
      if (state === 'denied') {
        this.openGeoPermissionModal('denied');
        return;
      }
      if (state === 'prompt' || state === 'unknown') {
        this.openGeoPermissionModal('preprompt');
        return;
      }

      await this.runLocateWithGeolocation();
    },
    async runLocateWithGeolocation() {
      if (!navigator.geolocation) {
        this.error = 'Geolocation is not supported by this browser.';
        this.status = 'Geolocation unavailable';
        return;
      }

      this.loading = true;
      this.error = null;
      this.status = 'Requesting device location…';

      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords;
          this.status = 'Determining country (on-device)…';
          try {
            // Seed country from ADM0 polygons (no network call with coords).
            await this.loadCountriesDataset();
            const seedCountry = this.lookupCountryIso2(latitude, longitude);

            if (seedCountry) {
              this.status = `Country: ${seedCountry.toUpperCase()} (loading admin packs)…`;
              // Kick off country pack download early (cached on device).
              this.loadAdmPack(seedCountry).catch(() => null);
            } else {
              this.status = 'Country not found (fallback to city dataset)…';
            }

            this.status = 'Resolving nearest city (on-device)…';
            const datasetInfo = await this.loadCitiesDataset();
            const lookupStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const results = this.findNearestCities(latitude, longitude, 2, 150, seedCountry);
            const lookupEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const lookupMs = Math.round(lookupEnd - lookupStart);

            // Store results for display
            this.results = results;
            this.coordinates = { lat: latitude, lon: longitude };

            // Local metrics (no server call)
            this.latestMetrics = {
              datasetFile: datasetInfo?.datasetFile || 'cities.min.json.gz',
              datasetLoadMs: datasetInfo?.datasetLoadMs ?? null,
              lookupMs,
              totalPoints: datasetInfo?.totalPoints ?? null,
              loadedAt: datasetInfo?.loadedAt ?? null,
              seedCountry: seedCountry ? seedCountry.toUpperCase() : null,
              seedMethod: seedCountry ? 'adm0' : 'none',
              source: 'client'
            };
            
            if (this.results.length > 0) {
              const best = this.results[0];
              const parts = [best.name, best.admin1, best.country].filter(Boolean);
              this.status = `Found: ${parts.join(', ')}`;
              // Local ADM2/3 lookup from on-device pack; raw GPS stays local
              try {
                const countryForAdm = (seedCountry || best.country || '').toString().trim().toLowerCase();
                const adm2 = countryForAdm
                  ? await this.fetchAdmPolygonFromPack(countryForAdm, 'adm2', latitude, longitude)
                  : null;
                let local = null;
                if (countryForAdm === 'us') {
                  // Prefer an in-between "place/city" boundary when available (e.g., Chicago city),
                  // falling back to tract-level (very small) if no place boundary contains the point.
                  const place = await this.fetchUsPlacePolygon(best.admin1, latitude, longitude).catch(() => null);
                  const tract = place ? null : await this.fetchUsAdm3Polygon(best.admin1, latitude, longitude).catch(() => null);
                  local = place || tract;
                } else if (countryForAdm) {
                  local = await this.fetchAdmPolygonFromPack(countryForAdm, 'adm3', latitude, longitude);
                }
                // Local fallback: if no finer local polygon exists, use ADM2 so user can still compare outlines.
                this.admPolygon = countryForAdm ? { adm2, local: local || adm2 } : null;
              } catch (admErr) {
                console.warn('ADM pack lookup failed', admErr);
                this.admPolygon = null;
              }
            } else {
              this.status = 'No city found';
              this.admPolygon = null;
            }

            // Weather (privacy-preserving): fetch using a coarse query point (ADM2 bbox center / nearest city),
            // rounded before the network call. Never send raw GPS coordinates.
            this.weatherStatus = 'Loading…';
            this.currentWeather = null;
            const weatherPromise = this.fetchCoarseWeather()
              .then((wx) => {
                this.currentWeather = wx || null;
                this.weatherStatus = wx ? null : 'Unavailable';
                return wx || null;
              })
              .catch((e) => {
                console.warn('weather fetch failed', e);
                this.weatherStatus = 'Unavailable';
                this.currentWeather = null;
                return null;
              })
              .finally(() => this.updateInlineLegend());

            // ISP hint (off-device): request IP -> ISP via server lookup.
            this.networkStatus = 'Loading…';
            this.networkIsp = null;
            const ispPromise = this.fetchNetworkIsp()
              .then((info) => {
                this.networkIsp = info && info.ok ? info : null;
                this.networkStatus = (info && info.ok) ? null : 'Unavailable';
                return this.networkIsp;
              })
              .catch((e) => {
                console.warn('network isp fetch failed', e);
                this.networkStatus = 'Unavailable';
                this.networkIsp = null;
                return null;
              })
              .finally(() => this.updateInlineLegend());

            // Append derived log entry (no coordinates)
            await this.appendClientLog({
              timestamp: new Date().toISOString(),
              datasetFile: this.latestMetrics?.datasetFile || null,
              datasetLoadMs: this.latestMetrics?.datasetLoadMs ?? null,
              lookupMs: this.latestMetrics?.lookupMs ?? null,
              seedCountry: this.latestMetrics?.seedCountry || null,
              seedMethod: this.latestMetrics?.seedMethod || null,
              resultCount: this.results.length,
              cityName: this.results[0]?.name || null,
              country: this.results[0]?.country || null,
              admin1: this.results[0]?.admin1 || null,
              admin2: this.results[0]?.admin2 || null,
              weather: await Promise.race([
                weatherPromise,
                new Promise((resolve) => setTimeout(() => resolve(null), 1500))
              ]),
              network: await Promise.race([
                ispPromise,
                new Promise((resolve) => setTimeout(() => resolve(null), 1500))
              ]),
              source: 'client'
            });

            // Refresh logs so modals show the most recent entry
            await this.fetchLogEntries(true);
            await nextTick();
            await this.renderInlineMap();
          } catch (fetchError) {
            console.error('Locate Me failed', fetchError);
            this.error = fetchError.message;
            this.status = 'Lookup failed';
          } finally {
            this.loading = false;
          }
        },
        (geoError) => {
          this.loading = false;
          this.status = 'Location request denied';
          switch (geoError.code) {
            case geoError.PERMISSION_DENIED:
              this.error = 'Location permission denied.';
              // Show a friendly instruction modal after denial.
              this.openGeoPermissionModal('denied');
              break;
            case geoError.POSITION_UNAVAILABLE:
              this.error = 'Position unavailable.';
              break;
            case geoError.TIMEOUT:
              this.error = 'Location request timed out.';
              break;
            default:
              this.error = 'Location request failed.';
          }
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    },
    async fetchLogEntries(force = false) {
      if (!force && this.logEntries.length) {
        return this.logEntries;
      }
      try {
        const res = await fetch(apiUrl('/api/location-log'));
        if (!res.ok) {
          console.warn('Location log API returned:', res.status);
          this.logEntries = [];
          return [];
        }
        const data = await res.json();
        const entries = Array.isArray(data) ? data : [];
        this.logEntries = entries.map((entry) => {
          const { latitude, longitude, lat, lon, ...rest } = entry || {};
          return rest;
        });
        return this.logEntries;
      } catch (error) {
        console.error('Failed to fetch location log', error);
        this.logEntries = [];
        return [];
      }
    },
    async refreshMetrics(force = false) {
      if (!force && this.latestMetrics && Object.keys(this.latestMetrics).length > 0) {
        return;
      }
      const entries = await this.fetchLogEntries(force);
      if (entries.length) {
        this.latestMetrics = entries[0];
      }
    },
    async showLogFile() {
      this.showRawLogModal = true;
      this.logFileContent = 'Loading...';
      try {
        const entries = await this.fetchLogEntries(true);
        if (!entries.length) {
          this.logFileContent = `[]\n\nNote: Log file is empty. Logs are stored in Google Cloud Storage bucket (gs://levante-assets-dev/logs/locations.json) and persist across invocations and sessions. If you see this message, it means no logs have been written yet. Try clicking "Locate Me" first to create log entries.`;
        } else {
          this.logFileContent = JSON.stringify(entries, null, 2);
        }
      } catch (error) {
        this.logFileContent = `Error: ${error.message}\n\nUnable to load logs.`;
      }
    },
    closeRawLogModal() {
      this.showRawLogModal = false;
    },
    async openViewLogModal() {
      await this.fetchLogEntries();
      this.showViewLogModal = true;
    },
    closeViewLogModal() {
      this.showViewLogModal = false;
    },
    destroyInlineMap() {
      if (this.inlineMapInstance) {
        this.inlineMapInstance.remove();
        this.inlineMapInstance = null;
      }
      if (this.inlineMapLayers) {
        this.inlineMapLayers.clearLayers();
        this.inlineMapLayers = null;
      }
      if (this.inlineLegendControl) {
        try { this.inlineLegendControl.remove(); } catch (_) {}
      }
      this.inlineLegendControl = null;
    },
    async renderInlineMap() {
      try {
        if (!this.coordinates || !this.results.length) {
          this.destroyInlineMap();
          return;
        }
        const ready = await this.ensureLeaflet();
        if (!ready) return;
        const mapElement = document.getElementById('resultMap');
        if (!mapElement) return;
        if (this.inlineMapInstance) {
          this.inlineMapInstance.remove();
        }
        this.inlineMapInstance = L.map(mapElement, {
          zoomControl: true,
          attributionControl: false
        });
        this.inlineMapInstance.zoomControl?.setPosition('topright');
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(this.inlineMapInstance);

        // Inline legend (top-left)
        if (this.inlineLegendControl) {
          try { this.inlineLegendControl.remove(); } catch (_) {}
          this.inlineLegendControl = null;
        }
        this.inlineLegendControl = L.control({ position: 'topleft' });
        this.inlineLegendControl.onAdd = () => {
          const div = L.DomUtil.create('div', 'locate-legend leaflet-bar');
          // allow interacting without dragging map
          L.DomEvent.disableClickPropagation(div);
          return div;
        };
        this.inlineLegendControl.addTo(this.inlineMapInstance);

        // Add scale control
        L.control.scale({
          metric: true,
          imperial: false,
          position: 'bottomleft',
          maxWidth: 200
        }).addTo(this.inlineMapInstance);

        this.inlineMapLayers = L.layerGroup().addTo(this.inlineMapInstance);

        const coords = [];
        this.results.forEach((result) => {
          const lat = Number(result.lat);
          const lon = Number(result.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
          coords.push([lat, lon]);
          const marker = L.circleMarker([lat, lon], {
            color: '#da3d16',
            fillColor: '#ffffff',
            fillOpacity: 1,
            radius: 7,
            weight: 2
          }).addTo(this.inlineMapLayers);
          const popup = `
            <strong>${result.name || 'Location'}</strong><br>
            ${result.country || ''} · ${result.distanceKm ? result.distanceKm + ' km' : 'Distance unknown'}
          `;
          marker.bindPopup(popup);
        });

        const gpsLat = Number(this.coordinates.lat);
        const gpsLon = Number(this.coordinates.lon);
        if (Number.isFinite(gpsLat) && Number.isFinite(gpsLon)) {
          L.marker([gpsLat, gpsLon], {
            title: 'Device GPS location'
          }).addTo(this.inlineMapLayers);
          // 1-mile and 5-mile circles
          L.circle([gpsLat, gpsLon], {
            radius: 1609, // 1 mile
            color: '#22c55e',
            weight: 2,
            fillOpacity: 0.05
          }).addTo(this.inlineMapLayers);
          L.circle([gpsLat, gpsLon], {
            radius: 8047, // 5 miles
            color: '#16a34a',
            weight: 2,
            fillOpacity: 0.03
          }).addTo(this.inlineMapLayers);
          coords.push([gpsLat, gpsLon]);
        }

        // Draw boundaries based on local packs:
        // - Blue: Regional (ADM2)
        // - Red:  Local (ADM3 if available, otherwise ADM2 fallback)
        if (Number.isFinite(gpsLat) && Number.isFinite(gpsLon) && this.admPolygon) {
          // Blue = Regional (ADM2)
          const adm2 = this.admPolygon.adm2 || null;
          if (adm2) {
            const layer = L.geoJSON(adm2, {
              style: {
                color: '#2563eb',
                weight: 3,
                opacity: 1.0,
                fillColor: '#2563eb',
                fillOpacity: 0.10
              }
            }).addTo(this.inlineMapLayers);
            const name = adm2.properties?.name || 'ADM2';
            layer.bindPopup(`<strong>${name}</strong><br>Regional (ADM2)`);
            const b = layer.getBounds();
            if (b.isValid()) {
              coords.push([b.getSouth(), b.getWest()]);
              coords.push([b.getNorth(), b.getEast()]);
            }
          }

          // Red = Local (ADM3 if available, otherwise ADM2 fallback)
          // Draw after blue so it can't be visually hidden when boundaries overlap.
          const local = this.admPolygon.local || null;
          if (local) {
            const isFallback = !!(this.admPolygon.adm2 && local === this.admPolygon.adm2);
            const layer = L.geoJSON(local, {
              style: {
                color: '#dc2626',
                weight: isFallback ? 6 : 4,
                opacity: isFallback ? 0.55 : 0.9,
                fillColor: '#dc2626',
                fillOpacity: 0.08
              }
            }).addTo(this.inlineMapLayers);
            const name = local.properties?.name || 'Local';
            layer.bindPopup(`<strong>${name}</strong><br>Local boundary`);
            const b = layer.getBounds();
            if (b.isValid()) {
              coords.push([b.getSouth(), b.getWest()]);
              coords.push([b.getNorth(), b.getEast()]);
            }
          }
        }

        // Refresh legend text after layers are present
        this.updateInlineLegend();

        if (coords.length > 1) {
          this.inlineMapInstance.fitBounds(coords, { padding: [32, 32] });
        } else if (coords.length === 1) {
          this.inlineMapInstance.setView(coords[0], 12);
        } else if (Number.isFinite(gpsLat) && Number.isFinite(gpsLon)) {
          this.inlineMapInstance.setView([gpsLat, gpsLon], 12);
        }

        setTimeout(() => this.inlineMapInstance.invalidateSize(), 0);
      } catch (inlineError) {
        console.warn('inline map render failed', inlineError);
        this.destroyInlineMap();
      }
    },
    async openMapModal() {
      console.log('openMapModal called');
      await this.fetchLogEntries();
      console.log('Logs fetched, entries:', this.logEntries.length);
      this.showMapModal = true;
      await nextTick();
      console.log('Modal opened, checking Leaflet...');
      const ready = await this.ensureLeaflet();
      console.log('Leaflet ready:', ready);
      if (!ready) {
        this.mapError = 'Map library failed to load. Please allow CDN access and try again.';
        return;
      }
      this.mapError = null;
      await this.initMap();
    },
    closeMapModal() {
      this.showMapModal = false;
      if (this.mapInstance) {
        this.mapInstance.remove();
        this.mapInstance = null;
      }
    },
    findCityCenterForLogEntry(entry) {
      const name = (entry?.cityName || '').toString().trim();
      const country = (entry?.country || '').toString().trim().toUpperCase();
      const admin1 = (entry?.admin1 || '').toString().trim();
      if (!name || !country) return null;

      const key = `${country}|${admin1}|${name}`.toLowerCase();
      if (this.logCityCoordCache[key]) return this.logCityCoordCache[key];

      const rows = Array.isArray(this.citiesDataset) ? this.citiesDataset : [];
      const nm = name.toLowerCase();
      let best = null;
      for (const r of rows) {
        if (!r) continue;
        if ((r.country || '').toString().toUpperCase() !== country) continue;
        if (admin1 && (r.admin1 || '').toString().trim() !== admin1) continue;
        const rName = (r.name || '').toString().toLowerCase();
        const rAscii = (r.ascii || '').toString().toLowerCase();
        if (rName !== nm && rAscii !== nm) continue;
        if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
        const pop = Number(r.population || 0) || 0;
        if (!best || pop > (best.pop || 0)) {
          best = { lat: r.lat, lon: r.lon, pop };
        }
      }
      if (best) {
        this.logCityCoordCache[key] = best;
        return best;
      }
      return null;
    },
    async initMap() {
      console.log('initMap called. entries:', this.logEntries.length, 'modal:', this.showMapModal, 'L:', !!window.L);
      if (!this.logEntries.length || !this.showMapModal || !window.L) return;
      // We no longer store raw GPS in logs, so we plot approximate city centers (privacy).
      await this.loadCitiesDataset().catch(() => null);
      const mapElement = document.getElementById('logMap');
      console.log('Map element found:', !!mapElement);
      if (!mapElement) return;
      if (this.mapInstance) {
        this.mapInstance.remove();
      }
      this.mapInstance = L.map('logMap');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(this.mapInstance);

      const coords = [];
      this.logEntries.forEach((entry) => {
        // Backwards-compatible: if older logs had coordinates, use them.
        const lat = Number(entry.latitude ?? entry.lat);
        const lon = Number(entry.longitude ?? entry.lon);
        let point = null;
        let note = '';
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          point = { lat, lon };
          note = 'GPS (legacy)';
        } else {
          const center = this.findCityCenterForLogEntry(entry);
          if (center && Number.isFinite(center.lat) && Number.isFinite(center.lon)) {
            point = { lat: center.lat, lon: center.lon };
            note = 'City center (approx)';
          }
        }
        if (point) {
          coords.push([point.lat, point.lon]);
          const marker = L.circleMarker([point.lat, point.lon], {
            radius: 6,
            weight: 2,
            color: '#0f172a',
            fillColor: '#da3d16',
            fillOpacity: 0.9
          }).addTo(this.mapInstance);
          const popup = `
            <strong>${entry.cityName || 'Unknown city'}</strong><br>
            ${entry.country || ''} · ${entry.distanceKm ? entry.distanceKm + ' km' : 'distance unknown'}<br>
            ${this.formatDateTime(entry.timestamp)}<br>
            <span style="color:#64748b;font-size:12px;">${note}</span>
          `;
          marker.bindPopup(popup);
        }
      });
      if (coords.length > 1) {
        this.mapInstance.fitBounds(coords, { padding: [32, 32] });
      } else if (coords.length === 1) {
        this.mapInstance.setView(coords[0], 10);
      } else {
        this.mapInstance.setView([20, 0], 2);
      }
      setTimeout(() => this.mapInstance.invalidateSize(), 0);
    },
    loadScript(src) {
      return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-dynamic='leaflet'][src='${src}']`);
        if (existing) {
          if (existing.dataset.loaded === 'true') {
            resolve();
            return;
          }
          existing.addEventListener('load', () => resolve());
          existing.addEventListener('error', reject);
          return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.defer = true;
        script.dataset.dynamic = 'leaflet';
        script.onload = () => {
          script.dataset.loaded = 'true';
          resolve();
        };
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
      });
    },
    async ensureLeaflet() {
      if (typeof window === 'undefined') return false;
      if (window.L) return true;
      if (this.leafletPromise) return this.leafletPromise;
      this.leafletPromise = (async () => {
        for (const src of LEAFLET_SOURCES) {
          try {
            await this.loadScript(src);
            if (window.L) return true;
          } catch (error) {
            console.warn('Leaflet load failed', src, error.message);
          }
        }
        return false;
      })();
      return this.leafletPromise;
    }
  },
  mounted() {
    this.loadCountries();
    this.refreshMetrics();
    this.fetchLogEntries();
  }
}).mount('#locateMeApp');

