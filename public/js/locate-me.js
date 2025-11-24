const { createApp, nextTick } = Vue;

const WEATHER_DESCRIPTIONS = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Rime fog',
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
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Rain showers',
  81: 'Heavy rain showers',
  82: 'Violent rain showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Severe thunderstorm with hail'
};

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
      weather: null,
      weatherStatus: ''
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
    describeWeather(code) {
      return WEATHER_DESCRIPTIONS[code] || 'Weather data unavailable';
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
            this.fetchWeather(latitude, longitude);
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
    async fetchWeather(lat, lon) {
      try {
        this.weatherStatus = 'Loading weather…';
        const params = new URLSearchParams({
          latitude: lat.toString(),
          longitude: lon.toString(),
          current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code',
          temperature_unit: 'fahrenheit',
          wind_speed_unit: 'mph',
          timezone: 'auto'
        });
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
        if (!res.ok) {
          throw new Error(`Weather request failed (${res.status})`);
        }
        const data = await res.json();
        const current = data.current;
        if (!current) {
          throw new Error('Weather data unavailable');
        }
        this.weather = {
          temperature: Math.round(current.temperature_2m),
          apparent: Math.round(current.apparent_temperature),
          humidity: current.relative_humidity_2m,
          wind: Math.round(current.wind_speed_10m),
          windUnit: data.current_units?.wind_speed_10m || 'mph',
          description: this.describeWeather(current.weather_code),
          updatedAt: current.time,
          unit: data.current_units?.temperature_2m || 'F'
        };
        this.weatherStatus = '';
      } catch (error) {
        console.warn('Failed to load weather', error);
        this.weatherStatus = 'Weather data unavailable (open-meteo)';
        this.weather = null;
      }
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
      if (!entries.length) {
        this.logFileContent = `[]\n\nNote: Log file is empty. Logs are stored in Google Cloud Storage bucket (gs://levante-assets-dev/logs/locations.json) and persist across sessions.`;
      } else {
        this.logFileContent = JSON.stringify(entries, null, 2);
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
    async openMapModal() {
      await this.fetchLogEntries();
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
      this.mapInstance = L.map('logMap').setView([20, 0], 2);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(this.mapInstance);

      this.logEntries.forEach((entry) => {
        if (entry.latitude && entry.longitude) {
          const marker = L.marker([entry.latitude, entry.longitude]).addTo(this.mapInstance);
          const popup = `
            <strong>${entry.cityName || 'Unknown city'}</strong><br>
            ${entry.country || ''} · ${entry.distanceKm ? entry.distanceKm + ' km' : 'distance unknown'}<br>
            ${this.formatDateTime(entry.timestamp)}
          `;
          marker.bindPopup(popup);
        }
      });
    }
  },
  mounted() {
    this.refreshMetrics();
    this.fetchLogEntries();
  }
}).mount('#locateMeApp');
