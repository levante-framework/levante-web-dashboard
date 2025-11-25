const { createApp, nextTick } = Vue;

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
      mapInstance: null
    };
  },
  computed: {
    logStats() {
      if (!this.logEntries.length) return null;
      const total = this.logEntries.length;
      const uniqueCities = new Set(this.logEntries.map((entry) => `${entry.cityName || 'unknown'}|${entry.country || ''}`)).size;
      const uniqueCountries = new Set(this.logEntries.map((entry) => entry.country).filter(Boolean)).size;
      const avgLookupMs = (this.logEntries.reduce((sum, entry) => sum + (entry.lookupMs || 0), 0) / total || 0).toFixed(1);
      const latest = this.logEntries[0];
      return { total, uniqueCities, uniqueCountries, avgLookupMs, latest };
    }
  },
  methods: {
    formatBytes(bytes) {
      if (!bytes) return 'N/A';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    },
    formatDateTime(isoString) {
      if (!isoString) return 'N/A';
      try {
        const date = new Date(isoString);
        return date.toLocaleString();
      } catch (error) {
        return isoString;
      }
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

            this.results = payload.results || [];
            this.coordinates = { lat: payload.lat, lon: payload.lon };

            if (payload.metrics) {
              this.latestMetrics = payload.metrics;
            } else {
              await this.refreshMetrics(true);
            }

            if (this.results.length > 0) {
              const best = this.results[0];
              const parts = [best.name, best.admin1, best.country].filter(Boolean);
              this.status = `Found: ${parts.join(', ')}`;
            } else {
              this.status = 'No city found';
            }

            await this.fetchLogEntries(true);
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
        this.logEntries = Array.isArray(data) ? data : [];
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
      const entries = await this.fetchLogEntries(true);
      this.logFileContent = entries.length
        ? JSON.stringify(entries, null, 2)
        : `[]\n\nNote: Log file is empty. Logs are stored in Google Cloud Storage bucket (gs://levante-assets-dev/logs/locations.json).`;
    },
    closeRawLogModal() {
      this.showRawLogModal = false;
    },
    async openViewLogModal() {
      await this.fetchLogEntries(true);
      this.showViewLogModal = true;
    },
    closeViewLogModal() {
      this.showViewLogModal = false;
    },
    async openMapModal() {
      await this.fetchLogEntries(true);
      this.showMapModal = true;
      await nextTick();
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
      if (!this.logEntries.length || !this.showMapModal) return;
      const mapElement = document.getElementById('logMap');
      if (!mapElement) return;
      if (this.mapInstance) {
        this.mapInstance.remove();
      }
      this.mapInstance = L.map('logMap');
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors'
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
        this.mapInstance.fitBounds(coords, { padding: [20, 20] });
      } else if (coords.length === 1) {
        this.mapInstance.setView(coords[0], 9);
      } else {
        this.mapInstance.setView([20, 0], 2);
      }
      setTimeout(() => this.mapInstance.invalidateSize(), 0);
    }
  },
  mounted() {
    this.refreshMetrics();
    this.fetchLogEntries();
  }
}).mount('#locateMeApp');
