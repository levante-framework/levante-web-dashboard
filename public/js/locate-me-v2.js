/**
 * Locate Me (v2)
 *
 * What this module does:
 * - Powers the interactive "Locate Me" experience in the browser.
 * - Resolves a user's nearby location context (city + administrative boundaries),
 *   renders map overlays, and shows lightweight contextual metadata (weather + ISP hint).
 * - Supports a secondary "Where Am I" modal flow for guided country/state/city selection.
 *
 * How it works (high level):
 * 1) Browser geolocation obtains the device position.
 * 2) On-device datasets are loaded/cached (countries + cities), then nearest-city lookup runs locally.
 * 3) Country-specific ADM packs are loaded and point-in-polygon checks determine ADM2/local boundaries.
 * 4) Map layers are rendered with circles, markers, and selected boundary outlines.
 * 5) Coarse weather and network ISP metadata are fetched and shown in the legend/log UI.
 *
 * Privacy model:
 * - Core locate computations are on-device whenever possible.
 * - Weather requests intentionally use a coarse query point (rounded before network call).
 * - Location log writes explicitly reject raw coordinates.
 * - Some helper flows (for example reverse-geocode in the "Where Am I" modal) may call backend APIs.
 *
 * Network dependencies:
 * - Backend APIs under /api/* (geocoder metadata, reverse geocode, location log, ADM packs, ISP lookup).
 * - Open-Meteo for current weather.
 * - Leaflet + OSM tiles for map rendering.
 */
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
const WHERE_MAP_POPULATION_MIN_DEFAULT = 50000;
// Air quality (AQICN/WAQI) privacy-masking config.
// Faux-location shift mirrors the geo-strategy gallery; the area request is a
// 10km x 10km box so the precise GPS point is never the obvious center.
const AQI_SHIFT_KM = 1;
const AQI_BBOX_KM = 10;
const AQI_SHIFT_DIRECTIONS = [
  { id: 'N', dx: 0, dy: 1 },
  { id: 'NE', dx: 1, dy: 1 },
  { id: 'E', dx: 1, dy: 0 },
  { id: 'SE', dx: 1, dy: -1 },
  { id: 'S', dx: 0, dy: -1 },
  { id: 'SW', dx: -1, dy: -1 },
  { id: 'W', dx: -1, dy: 0 },
  { id: 'NW', dx: -1, dy: 1 }
];
const US_LOWER_48_BOUNDS = [[24.396308, -124.848974], [49.384358, -66.885444]];
const US_STATE_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC'
};

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
      autocompleteSuggestions: [],
      selectedAutocompleteSuggestion: null,
      autocompleteMenuOpen: false,
      autocompleteMeta: null,
      autocompleteMetaPromise: null,
      autocompleteIndexCache: {},
      autocompleteDbPromise: null,
      autocompleteLoading: false,
      autocompleteSourceLabel: '',
      postalExactMatch: null,
      sessionNetworkBytes: 0,
      whereResult: null,
      countryOptions: [],
      countriesLoading: false,
      statesLoading: false,
      citiesLoading: false,
      selectedCountry: '',
      showWhereMapPickerModal: false,
      whereMapPickerInstance: null,
      whereMapPickerMarker: null,
      whereMapPickerCountryLayer: null,
      whereMapPickerPlacesLayer: null,
      whereMapPickerStateLayer: null,
      whereMapPickerSelection: null,
      whereMapPickerLoading: false,
      whereMapPickerError: null,
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
      currentAirQuality: null,
      airQualityStatus: null,
      networkIsp: null,
      networkStatus: null,
      latestObfuscatedLocation: null,
      latestLocationDocId: null,
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
    latestAirQuality() {
      return this.logEntries.find((entry) => entry.airQuality) || null;
    },
    filteredCities() {
      if (this.autocompleteSuggestions && this.autocompleteSuggestions.length) {
        return this.autocompleteSuggestions.map((s) => s.label).slice(0, 10);
      }
      if (!this.whereCities || !this.whereCities.length) return [];
      const q = this.cityQuery.trim().toLowerCase();
      if (!q) return this.whereCities.slice(0, 10);
      return this.whereCities.filter((c) => c.toLowerCase().includes(q)).slice(0, 10);
    },
    selectedCityDetail() {
      const q = this.cityQuery.trim().toLowerCase();
      if (!q) return null;
      if (this.selectedAutocompleteSuggestion) {
        const picked = this.selectedAutocompleteSuggestion;
        const pickedLabel = String(picked.label || '').trim().toLowerCase();
        const pickedName = String(picked.name || '').trim().toLowerCase();
        if (q === pickedLabel || q === pickedName) {
          return picked;
        }
      }
      if (this.autocompleteSuggestions && this.autocompleteSuggestions.length) {
        const suggestionMatch = this.autocompleteSuggestions.find((s) => String(s.label || '').toLowerCase() === q);
        if (suggestionMatch) {
          return suggestionMatch;
        }
      }
      if (!this.whereCityRecords || !this.whereCityRecords.length) return null;
      const inState = this.whereCityRecords.filter(
        (r) => !this.selectedState || r.admin1 === this.selectedState
      );
      const exact = inState.find((r) => (r.name || '').toLowerCase() === q);
      if (exact) return exact;
      return inState.find((r) => (r.name || '').toLowerCase().includes(q)) || null;
    }
  },
  methods: {
    // ---- Shared localStorage helpers (small, defensive wrappers) ----
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
    normalizeAutocompleteText(value) {
      return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    },
    normalizeAutocompletePostal(value) {
      return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    },
    countryDisplayLabel(code) {
      const cc = String(code || '').trim().toUpperCase();
      if (!cc) return '';
      const names = {
        US: 'United States',
        DE: 'Germany',
        GB: 'United Kingdom',
        NL: 'Netherlands',
        CA: 'Canada',
        CO: 'Colombia',
        IN: 'India',
        AR: 'Argentina',
        GH: 'Ghana',
        CH: 'Switzerland'
      };
      const name = names[cc] || cc;
      return `${name} — ${cc}`;
    },
    isLikelyPostalQuery(value) {
      const q = this.normalizeAutocompletePostal(value);
      return q.length >= 2 && /[0-9]/.test(q);
    },
    async openAutocompleteDb() {
      if (this.autocompleteDbPromise) return this.autocompleteDbPromise;
      if (typeof indexedDB === 'undefined') return null;
      this.autocompleteDbPromise = new Promise((resolve) => {
        try {
          const request = indexedDB.open('levante-locate-autocomplete', 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('indexes')) {
              db.createObjectStore('indexes', { keyPath: 'key' });
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch (_err) {
          resolve(null);
        }
      });
      return this.autocompleteDbPromise;
    },
    async readAutocompleteIndexFromIdb(key) {
      const db = await this.openAutocompleteDb();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction('indexes', 'readonly');
          const store = tx.objectStore('indexes');
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result ? req.result.value : null);
          req.onerror = () => resolve(null);
        } catch (_err) {
          resolve(null);
        }
      });
    },
    async writeAutocompleteIndexToIdb(key, value) {
      const db = await this.openAutocompleteDb();
      if (!db) return;
      await new Promise((resolve) => {
        try {
          const tx = db.transaction('indexes', 'readwrite');
          const store = tx.objectStore('indexes');
          store.put({ key, value, updatedAt: Date.now() });
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch (_err) {
          resolve();
        }
      });
    },
    getAutocompleteCountryCode(country) {
      return String(country || '').trim().toUpperCase();
    },
    async loadAutocompleteMeta(force = false) {
      if (this.autocompleteMeta && !force) return this.autocompleteMeta;
      if (this.autocompleteMetaPromise && !force) return this.autocompleteMetaPromise;
      this.autocompleteMetaPromise = (async () => {
        try {
          const res = await fetch(`/geocoder-index/meta.json?ts=${Date.now()}`, { cache: 'no-store' });
          if (!res.ok) throw new Error(`meta fetch failed (${res.status})`);
          const buf = await res.arrayBuffer();
          this.trackNetworkBytes(buf.byteLength);
          const meta = JSON.parse(new TextDecoder('utf-8').decode(buf));
          this.autocompleteMeta = meta;
          return meta;
        } catch (err) {
          console.warn('Autocomplete metadata unavailable; falling back to legacy city list.', err?.message || err);
          this.autocompleteMeta = null;
          return null;
        } finally {
          this.autocompleteMetaPromise = null;
        }
      })();
      return this.autocompleteMetaPromise;
    },
    buildAutocompleteCacheKey(countryCode, tier, version, contentHash) {
      const hashPart = String(contentHash || '').slice(0, 16) || 'nohash';
      return `${String(version || 'v1')}::${countryCode}::${tier}::${hashPart}`;
    },
    async loadCountryAutocompleteIndex(country, tier = 'lite', options = {}) {
      const countryCode = this.getAutocompleteCountryCode(country);
      if (!countryCode) return null;
      const forceRefetch = Boolean(options && options.forceRefetch);
      const normalizedTier = tier === 'full' ? 'full' : 'lite';
      const memoryKey = `${countryCode}:${normalizedTier}`;
      if (!forceRefetch && this.autocompleteIndexCache[memoryKey]) {
        this.autocompleteSourceLabel = `${countryCode} ${normalizedTier} index (memory cache)`;
        return this.autocompleteIndexCache[memoryKey];
      }

      const meta = await this.loadAutocompleteMeta();
      const countryMeta = meta?.countries?.[countryCode];
      if (!countryMeta) return null;

      const version = meta?.version || 'v1';
      const contentHash = countryMeta?.files?.[normalizedTier]?.sha256 || '';
      const cacheKey = this.buildAutocompleteCacheKey(countryCode, normalizedTier, version, contentHash);
      const cached = forceRefetch ? null : await this.readAutocompleteIndexFromIdb(cacheKey);
      if (cached && Array.isArray(cached.entries)) {
        this.autocompleteIndexCache[memoryKey] = cached;
        this.autocompleteSourceLabel = `${countryCode} ${normalizedTier} index (IndexedDB cache)`;
        return cached;
      }

      const fileName = countryMeta?.files?.[normalizedTier]?.file;
      if (!fileName) return null;
      const hashSuffix = String(contentHash || '').slice(0, 16);
      const cacheBuster = forceRefetch ? `refresh_${Date.now()}` : `${version}_${hashSuffix}`;
      const data = await this.fetchGzJson(`/geocoder-index/${fileName}?v=${encodeURIComponent(cacheBuster)}`);
      if (!data || !Array.isArray(data.entries)) return null;
      this.autocompleteIndexCache[memoryKey] = data;
      this.autocompleteSourceLabel = `${countryCode} ${normalizedTier} index${forceRefetch ? ' (refreshed)' : ''}`;
      await this.writeAutocompleteIndexToIdb(cacheKey, data);
      return data;
    },
    directAutocompleteSearch(indexData, queryNorm, postalNorm, selectedStateNorm, limit = 10) {
      const entries = Array.isArray(indexData?.entries) ? indexData.entries : [];
      if (!entries.length) return [];
      const out = [];
      for (const entry of entries) {
        const nameNorm = String(entry?.[0] || '');
        const postal = String(entry?.[1] || '').toLowerCase();
        if (!nameNorm && !postal) continue;
        if (postalNorm) {
          if (!(postal === postalNorm || (postal && postal.startsWith(postalNorm)))) continue;
        } else if (queryNorm) {
          const noSpace = nameNorm.replace(/\s+/g, '');
          const qNoSpace = queryNorm.replace(/\s+/g, '');
          if (
            !nameNorm.includes(queryNorm) &&
            !(qNoSpace && noSpace.includes(qNoSpace))
          ) {
            continue;
          }
        }
        const score = this.scoreAutocompleteEntry(entry, queryNorm, postalNorm, selectedStateNorm);
        if (score <= 0) continue;
        out.push({ entry, score });
      }
      out.sort((a, b) => b.score - a.score);
      return out.slice(0, limit);
    },
    collectAutocompleteCandidateIds(indexData, queryNorm, postalNorm) {
      const ids = new Set();
      const prefixMap = indexData?.prefix || {};
      const prefixes = [];
      if (queryNorm.length >= 2) {
        const qNoSpace = queryNorm.replace(/\s+/g, '');
        prefixes.push(queryNorm.slice(0, Math.min(5, queryNorm.length)));
        if (qNoSpace && qNoSpace !== queryNorm) {
          prefixes.push(qNoSpace.slice(0, Math.min(5, qNoSpace.length)));
        }
        queryNorm.split(' ').forEach((token) => {
          if (token.length >= 2) prefixes.push(token.slice(0, Math.min(5, token.length)));
        });
      }
      if (postalNorm.length >= 2) {
        prefixes.push(postalNorm.slice(0, Math.min(5, postalNorm.length)));
      }
      prefixes.forEach((prefix) => {
        const bucket = prefixMap[prefix];
        if (!Array.isArray(bucket)) return;
        bucket.forEach((id) => ids.add(id));
      });
      return Array.from(ids);
    },
    scoreAutocompleteEntry(entry, queryNorm, postalNorm, selectedStateNorm) {
      const nameNorm = String(entry?.[0] || '');
      const postal = String(entry?.[1] || '').toLowerCase();
      const admin1Norm = this.normalizeAutocompleteText(entry?.[3] || '');
      const population = Number(entry?.[6]) || 0;
      let score = 0;

      if (queryNorm) {
        if (nameNorm === queryNorm) score += 120;
        if (nameNorm.startsWith(queryNorm)) score += 100;
        if (nameNorm.includes(queryNorm)) score += 50;
      }
      if (postalNorm) {
        if (postal === postalNorm) score += 140;
        else if (postal && postal.startsWith(postalNorm)) score += 90;
      }
      if (selectedStateNorm && admin1Norm && selectedStateNorm === admin1Norm) score += 40;
      score += Math.min(35, Math.log10(Math.max(1, population)) * 7);

      return score;
    },
    async updateAutocompleteSuggestions() {
      if (typeof this.cityQuery !== 'string') {
        this.cityQuery = '';
      }
      const queryRaw = this.cityQuery;
      const queryNorm = this.normalizeAutocompleteText(queryRaw);
      const postalNorm = this.normalizeAutocompletePostal(queryRaw);
      const selectedStateNorm = this.normalizeAutocompleteText(this.selectedState || '');
      if (!this.selectedCountry || (!queryNorm && !postalNorm)) {
        this.autocompleteSuggestions = [];
        this.postalExactMatch = null;
        this.autocompleteMenuOpen = false;
        return;
      }

      const runSearch = async (tier, options = {}) => {
        const indexData = await this.loadCountryAutocompleteIndex(this.selectedCountry, tier, options);
        if (!indexData) return [];
        const ids = this.collectAutocompleteCandidateIds(indexData, queryNorm, postalNorm);
        let ranked = ids.length
          ? ids
              .map((id) => {
                const entry = indexData.entries[id];
                if (!entry) return null;
                const score = this.scoreAutocompleteEntry(entry, queryNorm, postalNorm, selectedStateNorm);
                if (score <= 0) return null;
                return { entry, score };
              })
              .filter(Boolean)
              .sort((a, b) => b.score - a.score)
              .slice(0, 10)
          : [];

        // Fallback: direct scan when prefix map yields no candidates.
        if (!ranked.length) {
          ranked = this.directAutocompleteSearch(indexData, queryNorm, postalNorm, selectedStateNorm, 10);
        }

        // If query exactly matches a city name, append sibling localities in the same admin region.
        // This helps queries like "Bogota" surface district/locality options, not just the city centroid.
        let siblingContext = null;
        if (ranked.length && ranked.length < 10 && queryNorm) {
          const top = ranked[0]?.entry || null;
          const topNameNorm = this.normalizeAutocompleteText(top?.[2] || '');
          const topAdminNorm = this.normalizeAutocompleteText(top?.[3] || '');
          if (top && topAdminNorm && (topNameNorm === queryNorm || topNameNorm.startsWith(queryNorm))) {
            siblingContext = {
              topName: String(top?.[2] || '').trim(),
              topNameNorm,
              topAdminNorm
            };
            const seenNameNorm = new Set(ranked.map(({ entry }) => this.normalizeAutocompleteText(entry?.[2] || '')));
            const siblingsByName = new Map();
            for (const entry of indexData.entries || []) {
              const adminNorm = this.normalizeAutocompleteText(entry?.[3] || '');
              if (!adminNorm || adminNorm !== topAdminNorm) continue;
              const nameNorm = this.normalizeAutocompleteText(entry?.[2] || '');
              if (!nameNorm || seenNameNorm.has(nameNorm) || nameNorm === topNameNorm) continue;
              const existing = siblingsByName.get(nameNorm);
              // Prefer row that has postal code, then higher population.
              const hasPostal = String(entry?.[1] || '').length > 0 ? 1 : 0;
              const pop = Number(entry?.[6] || 0);
              if (!existing) {
                siblingsByName.set(nameNorm, entry);
                continue;
              }
              const existingHasPostal = String(existing?.[1] || '').length > 0 ? 1 : 0;
              const existingPop = Number(existing?.[6] || 0);
              if (hasPostal > existingHasPostal || (hasPostal === existingHasPostal && pop > existingPop)) {
                siblingsByName.set(nameNorm, entry);
              }
            }
            const siblingRows = Array.from(siblingsByName.values())
              .sort((a, b) => {
                const postalDiff = (String(b?.[1] || '').length > 0 ? 1 : 0) - (String(a?.[1] || '').length > 0 ? 1 : 0);
                if (postalDiff !== 0) return postalDiff;
                const popDiff = Number(b?.[6] || 0) - Number(a?.[6] || 0);
                if (popDiff !== 0) return popDiff;
                return String(a?.[2] || '').localeCompare(String(b?.[2] || ''));
              })
              .slice(0, 10 - ranked.length)
              .map((entry) => ({ entry, score: 15 }));
            ranked = ranked.concat(siblingRows);
          }
        }

        return ranked.map(({ entry }) => {
          const name = String(entry[2] || '');
          const admin1 = String(entry[3] || '');
          const postal = String(entry[1] || '').toUpperCase();
          const nameNorm = this.normalizeAutocompleteText(name);
          const adminNorm = this.normalizeAutocompleteText(admin1);
          const isSiblingOfContext = Boolean(
            siblingContext &&
            siblingContext.topName &&
            siblingContext.topNameNorm !== nameNorm &&
            siblingContext.topAdminNorm &&
            siblingContext.topAdminNorm === adminNorm
          );
          // Prefix sibling labels with the matched city so native datalist keeps them visible.
          const labelParts = isSiblingOfContext ? [siblingContext.topName, name] : [name];
          if (admin1) labelParts.push(admin1);
          if (postal) labelParts.push(postal);
          const label = labelParts.join(' · ');
          return {
            label,
            name,
            admin1,
            country: this.selectedCountry,
            lat: Number(entry[4]),
            lon: Number(entry[5]),
            population: Number(entry[6]) || 0,
            postal
          };
        });
      };

      let suggestions = await runSearch('lite');
      if ((queryNorm.length >= 3 || this.isLikelyPostalQuery(queryRaw)) && suggestions.length < 5) {
        const fullSuggestions = await runSearch('full');
        if (fullSuggestions.length) {
          suggestions = fullSuggestions;
        }
        // If postal query still has no results, force refresh from network once
        // to bust stale edge/browser caches.
        if (!suggestions.length && postalNorm.length >= 3) {
          const refreshed = await runSearch('full', { forceRefetch: true });
          if (refreshed.length) {
            suggestions = refreshed;
          }
        }
      }
      // If a locality query unexpectedly returns <=1 result, force-refresh full index once.
      // This resolves stale CO cache cases where "bog" only returns the legacy city centroid row.
      if (queryNorm.length >= 3 && !postalNorm && suggestions.length <= 1) {
        const refreshed = await runSearch('full', { forceRefetch: true });
        if (refreshed.length > suggestions.length) {
          suggestions = refreshed;
        }
      }

      if (selectedStateNorm) {
        suggestions = suggestions.sort((a, b) => {
          const aMatch = this.normalizeAutocompleteText(a.admin1) === selectedStateNorm ? 1 : 0;
          const bMatch = this.normalizeAutocompleteText(b.admin1) === selectedStateNorm ? 1 : 0;
          return bMatch - aMatch;
        });
      }

      this.autocompleteSuggestions = suggestions.slice(0, 10);
      if (postalNorm && postalNorm.length >= 3) {
        const exact = this.autocompleteSuggestions.find((s) => this.normalizeAutocompletePostal(s.postal) === postalNorm);
        this.postalExactMatch = exact
          ? {
              code: String(exact.postal || '').toUpperCase(),
              label: exact.label || exact.name || ''
            }
          : null;
      } else {
        this.postalExactMatch = null;
      }
    },
    async handleCityQueryInput() {
      try {
        if (typeof this.cityQuery !== 'string') {
          this.cityQuery = '';
        }
        // Defensive cleanup for occasional browser autofill oddities.
        if (this.cityQuery === 'undefined') {
          this.cityQuery = '';
        }
        this.selectedAutocompleteSuggestion = null;
        this.autocompleteMenuOpen = Boolean(String(this.cityQuery || '').trim());
        await this.updateAutocompleteSuggestions();
      } catch (err) {
        console.warn('Autocomplete query failed; falling back to local city list.', err?.message || err);
        this.autocompleteSuggestions = [];
        this.postalExactMatch = null;
      }
    },
    selectAutocompleteSuggestion(suggestion) {
      if (!suggestion) return;
      const label = String(suggestion.label || suggestion.name || '').trim();
      this.cityQuery = label;
      this.selectedAutocompleteSuggestion = { ...suggestion, label };
      if (suggestion.admin1) {
        this.selectedState = String(suggestion.admin1);
      }
      // Collapse menu after explicit pick.
      this.autocompleteSuggestions = [];
      this.autocompleteMenuOpen = false;
      if (suggestion.postal) {
        this.postalExactMatch = {
          code: String(suggestion.postal).toUpperCase(),
          label
        };
      }
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
      // v2: includes humidity / heat index / cloud cover from Open-Meteo `current=`
      return `wx:v2:${c}:${a1}:${roundedLat.toFixed(2)}:${roundedLon.toFixed(2)}`;
    },
    /**
     * NWS heat index (°C) from dry-bulb °C and relative humidity %.
     * Uses the Steadman approximation below 80°F, Rothfusz regression above.
     */
    computeHeatIndexC(tempC, relativeHumidity) {
      const T = Number(tempC);
      const RH = Number(relativeHumidity);
      if (!Number.isFinite(T) || !Number.isFinite(RH)) return null;
      if (RH < 0 || RH > 100) return null;

      const Tf = (T * 9) / 5 + 32;
      let HI = 0.5 * (Tf + 61.0 + (Tf - 68.0) * 1.2 + RH * 0.094);
      HI = (HI + Tf) / 2;

      if (HI >= 80) {
        HI =
          -42.379 +
          2.04901523 * Tf +
          10.14333127 * RH -
          0.22475541 * Tf * RH -
          0.00683783 * Tf * Tf -
          0.05481717 * RH * RH +
          0.00122874 * Tf * Tf * RH +
          0.00085282 * Tf * RH * RH -
          0.00000199 * Tf * Tf * RH * RH;

        if (RH < 13 && Tf >= 80 && Tf <= 112) {
          HI -= ((13 - RH) / 4) * Math.sqrt((17 - Math.abs(Tf - 95)) / 17);
        } else if (RH > 85 && Tf >= 80 && Tf <= 87) {
          HI += ((RH - 85) / 10) * ((87 - Tf) / 5);
        }
      }

      const hic = ((HI - 32) * 5) / 9;
      return Math.round(hic * 10) / 10;
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

      // `current=` supersedes legacy `current_weather=true` and can include humidity + cloud cover.
      const currentVars = [
        'temperature_2m',
        'relative_humidity_2m',
        'weather_code',
        'wind_speed_10m',
        'cloud_cover'
      ].join(',');
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(qLat)}&longitude=${encodeURIComponent(qLon)}&current=${encodeURIComponent(currentVars)}&timezone=auto`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`weather_fetch_failed_${res.status}`);
      const json = await res.json();
      const cw = json?.current || null;
      if (!cw) return null;

      const temperature = Number(cw.temperature_2m);
      const humidity = Number(cw.relative_humidity_2m);
      const weathercode = Number(cw.weather_code);
      const heatIndexC = this.computeHeatIndexC(temperature, humidity);
      const cloudCover = Number(cw.cloud_cover);

      const weather = {
        source: 'open-meteo',
        // keep shape compatible with the log modal in locate-me.html
        temperature,
        humidity: Number.isFinite(humidity) ? humidity : null,
        heatIndexC: Number.isFinite(heatIndexC) ? heatIndexC : null,
        cloudCover: Number.isFinite(cloudCover) ? cloudCover : null,
        windKph: Number(cw.wind_speed_10m),
        weathercode,
        description: this.weatherCodeDescription(weathercode),
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
    // ---- Air quality (AQICN / WAQI), privacy-masked ----
    hashStringToInt(str) {
      // Small deterministic FNV-1a hash; used only to pick a shift direction.
      let h = 0x811c9dc5;
      const s = String(str || '');
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return h >>> 0;
    },
    shiftLocationForPrivacy(lat, lon) {
      // Faux location: shift the raw GPS by a fixed distance in a direction that
      // is deterministic per coarse-region + day (stable, but not obvious).
      // Mirrors the geo-strategy gallery's faux-location approach.
      const dayKey = new Date().toISOString().slice(0, 10);
      const coarse = `${this.roundToStep(lat, 0.1).toFixed(1)},${this.roundToStep(lon, 0.1).toFixed(1)}`;
      const dir = AQI_SHIFT_DIRECTIONS[this.hashStringToInt(`${coarse}|${dayKey}`) % AQI_SHIFT_DIRECTIONS.length];
      const diag = AQI_SHIFT_KM / Math.sqrt(2);
      const dxKm = dir.dx !== 0 && dir.dy !== 0 ? dir.dx * diag : dir.dx * AQI_SHIFT_KM;
      const dyKm = dir.dx !== 0 && dir.dy !== 0 ? dir.dy * diag : dir.dy * AQI_SHIFT_KM;
      const cos = Math.cos((lat * Math.PI) / 180);
      const newLat = lat + dyKm / 111.0;
      const newLon = lon + (cos ? dxKm / (111.0 * cos) : 0);
      return { lat: newLat, lon: newLon, direction: dir.id, shiftKm: AQI_SHIFT_KM };
    },
    boundingBoxAround(lat, lon, sizeKm) {
      // Returns a sizeKm x sizeKm box as bottom-left (1) and top-right (2) corners.
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
    },
    airQualityCategory(aqi) {
      // US EPA AQI breakpoints (also used by AQICN for the overall index).
      const n = Number(aqi);
      if (!Number.isFinite(n)) return { label: 'Unknown', color: '#94a3b8' };
      if (n <= 50) return { label: 'Good', color: '#16a34a' };
      if (n <= 100) return { label: 'Moderate', color: '#ca8a04' };
      if (n <= 150) return { label: 'Unhealthy for sensitive groups', color: '#ea580c' };
      if (n <= 200) return { label: 'Unhealthy', color: '#dc2626' };
      if (n <= 300) return { label: 'Very unhealthy', color: '#9333ea' };
      return { label: 'Hazardous', color: '#7f1d1d' };
    },
    aqiCacheKey(fauxLat, fauxLon) {
      const lat = this.roundToStep(fauxLat, 0.05).toFixed(2);
      const lon = this.roundToStep(fauxLon, 0.05).toFixed(2);
      return `aqi:v1:${lat}:${lon}`;
    },
    async fetchAirQuality() {
      const gpsLat = Number(this.coordinates?.lat);
      const gpsLon = Number(this.coordinates?.lon);
      if (!Number.isFinite(gpsLat) || !Number.isFinite(gpsLon)) return null;

      // 1) Faux location (shifted) so the requested area's center is not the GPS.
      const faux = this.shiftLocationForPrivacy(gpsLat, gpsLon);

      const cacheKey = this.aqiCacheKey(faux.lat, faux.lon);
      const cached = this.readLocalJson(cacheKey);
      if (cached?.expiresAt && Date.now() < cached.expiresAt && cached?.airQuality) {
        return cached.airQuality;
      }

      // 2) Start with a 10km x 10km de-identified area around the faux center.
      //    In sparse/suburban areas no reporting station may fall inside that box,
      //    so progressively expand the requested area. A larger box is even more
      //    de-identified; we still pick the station closest to the raw GPS below.
      let stations = null;
      let usedAreaKm = AQI_BBOX_KM;
      for (const sizeKm of [AQI_BBOX_KM, 25, 50]) {
        const box = this.boundingBoxAround(faux.lat, faux.lon, sizeKm);
        const latlng = [box.lat1, box.lon1, box.lat2, box.lon2]
          .map((v) => Number(v).toFixed(5))
          .join(',');
        const res = await fetch(apiUrl(`/api/air-quality?latlng=${encodeURIComponent(latlng)}`), { cache: 'no-store' });
        const json = await res.json().catch(() => null);
        if (json && json.ok && Array.isArray(json.stations) && json.stations.length) {
          stations = json.stations;
          usedAreaKm = sizeKm;
          break;
        }
      }
      if (!stations) return null;

      // 3) On-device: pick the station closest to the RAW GPS. Raw GPS never
      //    leaves the device; it is only used here to rank returned stations.
      let nearest = null;
      let nearestDist = Infinity;
      for (const s of stations) {
        const d = this.approxDistanceKm(gpsLat, gpsLon, s.lat, s.lon);
        if (Number.isFinite(d) && d < nearestDist) {
          nearestDist = d;
          nearest = s;
        }
      }
      if (!nearest) return null;

      // 4) Enrich the chosen station via its public station id (no GPS involved).
      let aqi = nearest.aqi;
      let dominantPollutant = null;
      let pollutants = {};
      let observedAt = nearest.observedAt || null;
      try {
        if (nearest.uid != null) {
          const detailRes = await fetch(
            apiUrl(`/api/air-quality?uid=${encodeURIComponent(nearest.uid)}`),
            { cache: 'no-store' }
          );
          const detail = await detailRes.json().catch(() => null);
          if (detail?.ok && detail.station) {
            dominantPollutant = detail.station.dominantPollutant || null;
            pollutants = detail.station.pollutants || {};
            observedAt = detail.station.observedAt || observedAt;
            if (Number.isFinite(Number(detail.station.aqi))) {
              aqi = Number(detail.station.aqi);
            }
          }
        }
      } catch (_) {
        // Enrichment is best-effort; the bounds AQI value is sufficient.
      }

      const category = this.airQualityCategory(aqi);
      // Stored measurement: the closest station's reading. We intentionally omit
      // station coordinates (and raw GPS) to avoid re-identifying the location.
      const airQuality = {
        source: 'aqicn',
        aqi: Number(aqi),
        category: category.label,
        color: category.color,
        dominantPollutant,
        pollutants,
        stationName: nearest.name || null,
        distanceKm: Math.round(nearestDist * 10) / 10,
        observedAt,
        privacy: {
          shiftKm: faux.shiftKm,
          shiftDirection: faux.direction,
          requestedAreaKm: usedAreaKm,
          stationsConsidered: stations.length
        }
      };

      this.writeLocalJson(cacheKey, {
        expiresAt: Date.now() + 30 * 60 * 1000,
        fetchedAt: Date.now(),
        airQuality
      });
      return airQuality;
    },
    updateInlineLegend() {
      if (!this.inlineLegendControl) return;
      const best = this.results?.[0] || null;
      const country = (best?.country || '').toString().trim();
      const admin1 = (best?.admin1 || '').toString().trim();
      const localName = this.admPolygon?.local?.properties?.name || 'Local';
      const regionalName = this.admPolygon?.adm2?.properties?.name || 'Regional (ADM2)';
      const wx = this.currentWeather;
      let wxLine = this.weatherStatus ? `Weather: ${this.weatherStatus}` : 'Weather: —';
      if (wx) {
        const parts = [
          Number.isFinite(wx.temperature) ? `${Math.round(wx.temperature)}°C` : null,
          Number.isFinite(wx.heatIndexC) ? `HI ${Math.round(wx.heatIndexC)}°C` : null,
          wx.description || null,
          Number.isFinite(wx.humidity) ? `RH ${Math.round(wx.humidity)}%` : null,
          Number.isFinite(wx.cloudCover) ? `cloud ${Math.round(wx.cloudCover)}%` : null
        ].filter(Boolean);
        wxLine = `Weather: ${parts.join(' · ') || '—'}`;
      }
      const aq = this.currentAirQuality;
      const aqLine = aq && Number.isFinite(aq.aqi)
        ? `Air quality: <span style="color:${aq.color || '#0f172a'};font-weight:600;">${aq.aqi} ${aq.category || ''}</span>`
        : (this.airQualityStatus ? `Air quality: ${this.airQualityStatus}` : 'Air quality: —');
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
        <div class="locate-legend-row locate-legend-aqi">${aqLine}</div>
        <div class="locate-legend-row locate-legend-isp">${ispLine}</div>
        <div class="locate-legend-footnote">${country}${admin1 ? ' · ' + admin1 : ''} (coarse lookup)</div>
      `;
    },
    async fetchGzJson(url) {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`fetch failed (${res.status})`);
      const buf = await res.arrayBuffer();
      this.trackNetworkBytes(buf.byteLength);
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
      // Critical privacy rule: logs may include derived metadata, but never raw GPS.
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
    async buildAndPersistObfuscatedLocation(rawLat, rawLon) {
      try {
        const builder = window.buildObfuscatedLocationFromLatLon;
        if (typeof builder !== 'function') {
          console.warn('buildObfuscatedLocationFromLatLon is unavailable; skipping location object persistence');
          return null;
        }
        // Raw coordinates are used only transiently for H3 computation on-device.
        const built = await builder(rawLat, rawLon, {
          populationThreshold: 50000,
          baselineResolution: 5,
          maxResolution: 9,
          latLonSource: 'h3_center'
        });
        const location = built?.location || null;
        if (!location) return null;

        this.latestObfuscatedLocation = location;

        const response = await fetch(apiUrl('/api/location-upsert'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ location })
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`location-upsert failed (${response.status}) ${body || ''}`.trim());
        }
        const payload = await response.json().catch(() => ({}));
        this.latestLocationDocId = payload?.id || null;
        return payload;
      } catch (error) {
        console.warn('Failed to build/persist obfuscated location', error?.message || error);
        return null;
      }
    },
    formatBytes(bytes) {
      if (!bytes) return 'N/A';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },
    formatInteger(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '0';
      return Math.round(n).toLocaleString();
    },
    trackNetworkBytes(byteCount) {
      const n = Number(byteCount);
      if (!Number.isFinite(n) || n <= 0) return;
      this.sessionNetworkBytes += n;
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
      this.autocompleteSuggestions = [];
      this.selectedAutocompleteSuggestion = null;
      this.autocompleteMenuOpen = false;
      this.autocompleteSourceLabel = '';
      this.postalExactMatch = null;
      this.whereResult = null;
      this.whereMapPickerSelection = null;
      this.whereMapPickerError = null;
    },
    openWhereAmI() {
      console.log('[WhereAmI] open modal');
      this.resetWhereModalState();
      this.showWhereModal = true;
      this.whereLoading = true;
      this.loadCountries()
        .finally(() => {
          this.whereLoading = false;
        });
    },
    closeWhereModal() {
      this.showWhereModal = false;
      this.closeWhereMapPickerModal();
    },
    async openWhereMapPickerModal() {
      if (!this.selectedCountry) {
        this.whereError = 'Select a country before choosing from map.';
        return;
      }
      this.whereError = null;
      this.whereMapPickerError = null;
      this.whereMapPickerSelection = null;
      this.showWhereMapPickerModal = true;
      await nextTick();
      this.initWhereMapPicker();
    },
    closeWhereMapPickerModal() {
      this.showWhereMapPickerModal = false;
      if (this.whereMapPickerInstance) {
        try {
          this.whereMapPickerInstance.remove();
        } catch (_) {}
        this.whereMapPickerInstance = null;
      }
      this.whereMapPickerMarker = null;
      this.whereMapPickerCountryLayer = null;
      this.whereMapPickerPlacesLayer = null;
      this.whereMapPickerStateLayer = null;
      this.whereMapPickerSelection = null;
      this.whereMapPickerError = null;
      this.whereMapPickerLoading = false;
    },
    getCountryFeatureByIso2(countryCode) {
      const iso2 = String(countryCode || '').trim().toLowerCase();
      const fc = this.countriesDataset;
      if (!iso2 || !fc || !Array.isArray(fc.features)) return null;
      return fc.features.find((f) => String(f?.properties?.iso2 || '').trim().toLowerCase() === iso2) || null;
    },
    getGeometryBounds(geometry) {
      if (!geometry || !Array.isArray(geometry.coordinates)) return null;
      let minLon = Infinity;
      let minLat = Infinity;
      let maxLon = -Infinity;
      let maxLat = -Infinity;
      const visit = (node) => {
        if (!Array.isArray(node)) return;
        if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
          const lon = Number(node[0]);
          const lat = Number(node[1]);
          if (Number.isFinite(lon) && Number.isFinite(lat)) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
          return;
        }
        node.forEach(visit);
      };
      visit(geometry.coordinates);
      if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;
      return { minLon, minLat, maxLon, maxLat };
    },
    async initWhereMapPicker() {
      const ready = await this.ensureLeaflet();
      if (!ready) {
        this.whereMapPickerError = 'Map library failed to load. Please retry.';
        return;
      }
      const mapElement = document.getElementById('whereMapPicker');
      if (!mapElement) return;

      if (this.whereMapPickerInstance) {
        try {
          this.whereMapPickerInstance.remove();
        } catch (_) {}
      }
      this.whereMapPickerInstance = L.map(mapElement, {
        zoomControl: true,
        attributionControl: false
      });
      this.whereMapPickerInstance.zoomControl?.setPosition('topright');
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
      }).addTo(this.whereMapPickerInstance);

      await this.loadCountriesDataset().catch(() => null);
      const countryFeature = this.getCountryFeatureByIso2(this.selectedCountry);
      let fitBounds = null;
      const countryCode = this.getAutocompleteCountryCode(this.selectedCountry);
      if (countryFeature?.geometry) {
        this.whereMapPickerCountryLayer = L.geoJSON(countryFeature, {
          style: {
            color: '#2563eb',
            weight: 2,
            fillColor: '#2563eb',
            fillOpacity: 0.03
          }
        }).addTo(this.whereMapPickerInstance);
        const b = this.whereMapPickerCountryLayer.getBounds?.();
        if (b && b.isValid && b.isValid()) {
          fitBounds = b;
        }
      }
      if (!fitBounds) {
        const bounds = this.getGeometryBounds(countryFeature?.geometry || null);
        if (bounds) {
          fitBounds = L.latLngBounds([bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]);
        }
      }
      if (countryCode === 'US') {
        fitBounds = L.latLngBounds(US_LOWER_48_BOUNDS[0], US_LOWER_48_BOUNDS[1]);
      }
      if (fitBounds && fitBounds.isValid && fitBounds.isValid()) {
        this.whereMapPickerInstance.fitBounds(fitBounds.pad(0.03), { padding: [20, 20] });
        this.whereMapPickerInstance.setMaxBounds(fitBounds.pad(0.18));
      } else {
        this.whereMapPickerInstance.setView([20, 0], 2);
      }

      // Add lightweight place-name context markers so users can orient before clicking.
      const contextTier = countryCode === 'US' ? 'full' : 'lite';
      const countryIndex = await this.loadCountryAutocompleteIndex(this.selectedCountry, contextTier).catch(() => null);
      const entries = Array.isArray(countryIndex?.entries) ? countryIndex.entries : [];
      if (entries.length) {
        const unique = new Set();
        const topPlaces = entries
          .map((entry) => ({
            name: String(entry?.[2] || '').trim(),
            admin1: String(entry?.[3] || '').trim(),
            lat: Number(entry?.[4]),
            lon: Number(entry?.[5]),
            pop: Math.max(0, Number(entry?.[6]) || 0)
          }))
          .filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lon))
          .sort((a, b) => b.pop - a.pop)
          .filter((p) => {
            const key = `${p.name.toLowerCase()}|${p.admin1.toLowerCase()}`;
            if (unique.has(key)) return false;
            unique.add(key);
            return true;
          })
          .slice(0, countryCode === 'US' ? 320 : 120);
        this.whereMapPickerPlacesLayer = L.layerGroup().addTo(this.whereMapPickerInstance);

        const drawPlaceContextForZoom = () => {
          if (!this.whereMapPickerPlacesLayer) return;
          this.whereMapPickerPlacesLayer.clearLayers();
          if (this.whereMapPickerStateLayer) this.whereMapPickerStateLayer.clearLayers();
          const zoom = Number(this.whereMapPickerInstance?.getZoom?.() || 4);
          let cap = countryCode === 'US' ? 70 : 35;
          let popFloor = countryCode === 'US' ? 300000 : 120000;
          if (zoom >= 7) {
            cap = countryCode === 'US' ? 190 : 90;
            popFloor = countryCode === 'US' ? 50000 : 25000;
          } else if (zoom >= 6) {
            cap = countryCode === 'US' ? 130 : 65;
            popFloor = countryCode === 'US' ? 90000 : 50000;
          } else if (zoom >= 5) {
            cap = countryCode === 'US' ? 100 : 50;
            popFloor = countryCode === 'US' ? 180000 : 90000;
          }

          let rendered = 0;
          topPlaces.forEach((p) => {
            if (rendered >= cap) return;
            if (p.pop < popFloor) return;
            const marker = L.circleMarker([p.lat, p.lon], {
              radius: zoom >= 7 ? 3 : 2.5,
              color: '#1f2937',
              fillColor: '#ffffff',
              fillOpacity: 0.9,
              weight: 1
            }).addTo(this.whereMapPickerPlacesLayer);
            const label = p.admin1 ? `${p.name} (${p.admin1})` : p.name;
            marker.bindTooltip(label, {
              permanent: true,
              direction: 'right',
              offset: [4, 0],
              opacity: 0.9
            });
            marker.openTooltip();
            rendered += 1;
          });

          // US orientation anchors: state abbreviation labels at low/mid zoom.
          if (countryCode === 'US' && zoom <= 6) {
            if (!this.whereMapPickerStateLayer) {
              this.whereMapPickerStateLayer = L.layerGroup().addTo(this.whereMapPickerInstance);
            }
            const byState = new Map();
            topPlaces.forEach((p) => {
              const key = String(p.admin1 || '').trim().toLowerCase();
              if (!key || !US_STATE_ABBR[key]) return;
              const current = byState.get(key) || { latSum: 0, lonSum: 0, count: 0 };
              current.latSum += p.lat;
              current.lonSum += p.lon;
              current.count += 1;
              byState.set(key, current);
            });
            byState.forEach((v, key) => {
              if (!v.count) return;
              const abbr = US_STATE_ABBR[key];
              if (!abbr) return;
              const lat = v.latSum / v.count;
              const lon = v.lonSum / v.count;
              const marker = L.circleMarker([lat, lon], {
                radius: 1,
                color: '#334155',
                fillColor: '#334155',
                fillOpacity: 0.05,
                weight: 0.5
              }).addTo(this.whereMapPickerStateLayer);
              marker.bindTooltip(abbr, {
                permanent: true,
                direction: 'center',
                className: 'state-abbr-label',
                opacity: 0.9
              });
              marker.openTooltip();
            });
          }
        };

        drawPlaceContextForZoom();
        this.whereMapPickerInstance.on('zoomend', drawPlaceContextForZoom);
      }

      this.whereMapPickerInstance.on('click', (evt) => {
        const lat = Number(evt?.latlng?.lat);
        const lon = Number(evt?.latlng?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        this.whereMapPickerSelection = { lat, lon };
        if (this.whereMapPickerMarker) {
          this.whereMapPickerMarker.setLatLng([lat, lon]);
        } else {
          this.whereMapPickerMarker = L.marker([lat, lon], { title: 'Selected point' }).addTo(this.whereMapPickerInstance);
        }
      });

      setTimeout(() => {
        this.whereMapPickerInstance?.invalidateSize?.();
        if (fitBounds && fitBounds.isValid && fitBounds.isValid()) {
          this.whereMapPickerInstance.fitBounds(fitBounds.pad(0.03), { padding: [20, 20] });
        }
      }, 0);
    },
    async applyWhereMapSelection() {
      if (!this.selectedCountry) {
        this.whereMapPickerError = 'Select a country first.';
        return;
      }
      const selected = this.whereMapPickerSelection;
      if (!selected || !Number.isFinite(selected.lat) || !Number.isFinite(selected.lon)) {
        this.whereMapPickerError = 'Click a point on the map first.';
        return;
      }

      const minPopulation = WHERE_MAP_POPULATION_MIN_DEFAULT;
      this.whereMapPickerLoading = true;
      this.whereMapPickerError = null;
      try {
        const indexData = await this.loadCountryAutocompleteIndex(this.selectedCountry, 'full');
        const entries = Array.isArray(indexData?.entries) ? indexData.entries : [];
        if (!entries.length) throw new Error('Country index unavailable.');

        const rankNearest = (enforcePopulationFloor) => {
          let best = null;
          let bestDistance = Infinity;
          for (const entry of entries) {
            const lat = Number(entry?.[4]);
            const lon = Number(entry?.[5]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            const pop = Math.max(0, Number(entry?.[6]) || 0);
            if (enforcePopulationFloor && pop < minPopulation) continue;
            const d = this.approxDistanceKm(selected.lat, selected.lon, lat, lon);
            if (!Number.isFinite(d)) continue;
            if (d < bestDistance) {
              bestDistance = d;
              best = {
                name: String(entry?.[2] || '').trim(),
                admin1: String(entry?.[3] || '').trim(),
                postal: String(entry?.[1] || '').toUpperCase(),
                country: this.selectedCountry,
                lat,
                lon,
                population: pop,
                distanceKm: Math.round(d * 10) / 10
              };
            }
          }
          return best;
        };

        let best = rankNearest(true);
        let thresholdApplied = true;
        if (!best) {
          best = rankNearest(false);
          thresholdApplied = false;
        }
        if (!best || !best.name) throw new Error('No nearby locality found in this country index.');

        const labelParts = [best.name];
        if (best.admin1) labelParts.push(best.admin1);
        if (best.postal) labelParts.push(best.postal);
        const suggestion = {
          label: labelParts.join(' · '),
          name: best.name,
          admin1: best.admin1,
          country: best.country,
          lat: best.lat,
          lon: best.lon,
          population: best.population,
          postal: best.postal
        };
        this.selectAutocompleteSuggestion(suggestion);
        this.whereError = thresholdApplied
          ? null
          : `No match met population floor (${this.formatInteger(minPopulation)}); using nearest available locality instead.`;
        this.closeWhereMapPickerModal();
      } catch (err) {
        this.whereMapPickerError = err?.message || 'Failed to resolve map selection.';
      } finally {
        this.whereMapPickerLoading = false;
      }
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
      const buf = await res.arrayBuffer();
      this.trackNetworkBytes(buf.byteLength);
      return JSON.parse(new TextDecoder('utf-8').decode(buf));
    },
    async loadCountries(force = false) {
      if (this.countryOptions.length && !force) return this.countryOptions;
      this.countriesLoading = true;
      try {
        let countries = [];

        // Preferred: shipped autocomplete metadata (fully client-side, no API dependency).
        const meta = await this.loadAutocompleteMeta().catch(() => null);
        if (meta && Array.isArray(meta.supportedCountries) && meta.supportedCountries.length) {
          countries = meta.supportedCountries.map((c) => String(c || '').trim().toUpperCase()).filter(Boolean);
        }

        // Fallback: server metadata API if available.
        if (!countries.length) {
          const data = await this.fetchGeoMetadata();
          countries = Array.isArray(data?.countries) ? data.countries : [];
        }

        // Final fallback: local ADM0 countries pack.
        if (!countries.length) {
          await this.loadCountriesDataset();
          const features = this.countriesDataset?.features || [];
          const isoSet = new Set();
          features.forEach((f) => {
            const iso2 = String(f?.properties?.iso2 || '').trim().toUpperCase();
            if (iso2) isoSet.add(iso2);
          });
          countries = Array.from(isoSet);
        }

        this.countryOptions = countries.sort((a, b) => String(a).localeCompare(String(b)));
      } catch (err) {
        console.warn('Failed to load countries', err);
        this.countryOptions = [];
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
      this.autocompleteSuggestions = [];
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
      this.whereCountry = this.selectedCountry || null;
      this.selectedState = '';
      // Keep this path fully client-side; no server-side state/city dependency required.
      this.whereStates = [];
      this.setCitiesFromRecords([]);
      this.autocompleteSourceLabel = '';
      if (this.selectedCountry) {
        // Warm lite index so first autocomplete query is instant.
        this.autocompleteLoading = true;
        try {
          await this.loadCountryAutocompleteIndex(this.selectedCountry, 'lite');
        } catch (_err) {
          // Non-fatal: query-time load will still retry as needed.
        } finally {
          this.autocompleteLoading = false;
        }
      }
      this.cityQuery = '';
      this.autocompleteSuggestions = [];
      this.selectedAutocompleteSuggestion = null;
      this.autocompleteMenuOpen = false;
      this.postalExactMatch = null;
    },
    async handleStateChange() {
      await this.loadCities(this.selectedCountry, this.selectedState);
      this.cityQuery = '';
      this.autocompleteSuggestions = [];
      this.selectedAutocompleteSuggestion = null;
      this.autocompleteMenuOpen = false;
      this.postalExactMatch = null;
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
            // "Where Am I" uses server reverse-geocoding for a guided picker workflow.
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
            await this.updateAutocompleteSuggestions();

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
      // Primary Locate flow: do nearest-city + boundary selection on-device first,
      // then fetch only coarse weather/ISP metadata for display.
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

            // Build and persist a de-identified location object.
            // This never sends/stores the raw GPS coordinates; lat/lon are from H3 cell center.
            const locationPersistResult = await this.buildAndPersistObfuscatedLocation(latitude, longitude);
            
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

            // Air quality (privacy-masked): request a shifted 10km x 10km area,
            // then pick the station closest to the raw GPS on-device. Raw GPS is
            // never sent; only the de-identified bounding box leaves the device.
            this.airQualityStatus = 'Loading…';
            this.currentAirQuality = null;
            const airQualityPromise = this.fetchAirQuality()
              .then((aq) => {
                this.currentAirQuality = aq || null;
                this.airQualityStatus = aq ? null : 'Unavailable';
                return aq || null;
              })
              .catch((e) => {
                console.warn('air quality fetch failed', e);
                this.airQualityStatus = 'Unavailable';
                this.currentAirQuality = null;
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
              airQuality: await Promise.race([
                airQualityPromise,
                new Promise((resolve) => setTimeout(() => resolve(null), 2500))
              ]),
              network: await Promise.race([
                ispPromise,
                new Promise((resolve) => setTimeout(() => resolve(null), 1500))
              ]),
              locationDocId: locationPersistResult?.id || this.latestLocationDocId || null,
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
    this.loadAutocompleteMeta();
    this.refreshMetrics();
    this.fetchLogEntries();
  }
}).mount('#locateMeApp');

