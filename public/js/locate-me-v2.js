const { createApp, nextTick } = Vue;
const LEAFLET_SOURCES = [
  '/vendor/leaflet/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js'
];

createApp({
  data() {
    return {
      status: 'Click Locate Me to begin',
      results: [],
      coordinates: null,
      latestMetrics: null,
      loading: false,
      error: null,
      showRawLogModal: false,
      showViewLogModal: false,
      showMapModal: false,
      logFileContent: '',
      logEntries: [],
      mapInstance: null,
      mapError: null,
      leafletPromise: null,
      inlineMapInstance: null,
      inlineMapLayers: null,
      gadmPolygonCache: {}
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
    }
  },
  methods: {
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
    normalizeGadmKey(name, admin1, country) {
      return [name, admin1, country]
        .map((part) => (part || '').toString().trim().toLowerCase())
        .join('|');
    },
    async fetchGadmPolygon(result) {
      if (!result || !result.country || !result.lat || !result.lon) {
        return null;
      }
      const cacheKey = this.normalizeGadmKey(result.name, result.admin1, result.country);
      if (this.gadmPolygonCache[cacheKey]) {
        return this.gadmPolygonCache[cacheKey];
      }
      const params = new URLSearchParams({
        name: result.name || '',
        admin1: result.admin1 || '',
        country: result.country,
        lat: result.lat,
        lon: result.lon
      });
      try {
        const response = await fetch(`/api/gadm-polygon?${params.toString()}`);
        if (!response.ok) {
          return null;
        }
        const payload = await response.json();
        if (payload?.feature) {
          this.gadmPolygonCache[cacheKey] = payload.feature;
          return payload.feature;
        }
      } catch (error) {
        console.warn('Failed to load GADM polygon', error);
      }
      return null;
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

      this.loading = true;
      this.error = null;
      this.status = 'Requesting device location…';

      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords;
          this.status = 'Resolving nearest city…';
          try {
            const query = new URLSearchParams({
              lat: latitude.toString(),
              lon: longitude.toString(),
              limit: '2',
              maxDistanceKm: '150'
            });
            const response = await fetch(`/api/reverse-geocode?${query.toString()}`);
            if (!response.ok) {
              const errorPayload = await response.json().catch(() => ({ error: 'Unknown error' }));
              throw new Error(errorPayload?.message || errorPayload?.error || 'Unknown error');
            }
            const payload = await response.json();

            // Store results for display
            this.results = payload.results || [];
            this.coordinates = { lat: payload.lat, lon: payload.lon };
            
            // Use metrics from API response directly
            if (payload.metrics) {
              this.latestMetrics = payload.metrics;
            } else {
              this.refreshMetrics(true);
            }
            
            if (this.results.length > 0) {
              const best = this.results[0];
              const parts = [best.name, best.admin1, best.country].filter(Boolean);
              this.status = `Found: ${parts.join(', ')}`;
            } else {
              this.status = 'No city found';
            }

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
        const res = await fetch('/api/location-log');
        if (!res.ok) {
          console.warn('Location log API returned:', res.status);
          this.logEntries = [];
          return [];
        }
        const data = await res.json();
        const entries = Array.isArray(data) ? data : [];
        this.logEntries = entries.map((entry) => ({
          ...entry,
          latitude: entry.latitude != null ? Number(entry.latitude) : null,
          longitude: entry.longitude != null ? Number(entry.longitude) : null
        }));
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
          const circle = L.circle([gpsLat, gpsLon], {
            radius: 1609, // 1 mile
            color: '#1d4ed8',
            weight: 2,
            fillOpacity: 0.05
          }).addTo(this.inlineMapLayers);
          coords.push([gpsLat, gpsLon]);
        }

        await this.drawRegionPolygons(this.results);

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
      this.initMap();
    },
    closeMapModal() {
      this.showMapModal = false;
      if (this.mapInstance) {
        this.mapInstance.remove();
        this.mapInstance = null;
      }
    },
    initMap() {
      console.log('initMap called. entries:', this.logEntries.length, 'modal:', this.showMapModal, 'L:', !!window.L);
      if (!this.logEntries.length || !this.showMapModal || !window.L) return;
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
        if (entry.latitude && entry.longitude) {
          coords.push([entry.latitude, entry.longitude]);
          const marker = L.marker([entry.latitude, entry.longitude]).addTo(this.mapInstance);
          const popup = `
            <strong>${entry.cityName || 'Unknown city'}</strong><br>
            ${entry.country || ''} · ${entry.distanceKm ? entry.distanceKm + ' km' : 'distance unknown'}<br>
            ${this.formatDateTime(entry.timestamp)}
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
    this.refreshMetrics();
    this.fetchLogEntries();
  }
}).mount('#locateMeApp');

