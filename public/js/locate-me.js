const { createApp } = Vue;

createApp({
  data() {
    return {
      status: 'Click Locate Me to begin',
      results: [],
      coordinates: null,
      latestMetrics: null,
      loading: false,
      error: null,
      showLog: false,
      logFileContent: ''
    };
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
            console.log('API Response:', payload);
            if (payload.metrics) {
              this.latestMetrics = payload.metrics;
              console.log('Metrics set from API:', this.latestMetrics);
            } else {
              console.warn('No metrics in API response. Payload keys:', Object.keys(payload));
              // Try to refresh from log file as fallback
              this.refreshMetrics();
            }
            
            if (this.results.length > 0) {
              const best = this.results[0];
              const parts = [best.name, best.admin1, best.country].filter(Boolean);
              this.status = `Found: ${parts.join(', ')}`;
            } else {
              this.status = 'No city found';
            }
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
    async refreshMetrics() {
      // Only refresh from log file if we don't already have metrics
      if (this.latestMetrics && Object.keys(this.latestMetrics).length > 0) {
        console.log('Skipping refreshMetrics - already have metrics:', this.latestMetrics);
        return;
      }
      
      try {
        const res = await fetch('/api/location-log');
        if (!res.ok) {
          console.warn('Location log API returned:', res.status);
          return;
        }
        const data = await res.json();
        console.log('Location log data:', data);
        if (Array.isArray(data) && data.length > 0) {
          this.latestMetrics = data[0];
          console.log('Set latestMetrics from log:', this.latestMetrics);
        } else if (data && typeof data === 'object' && !Array.isArray(data)) {
          // Handle case where API returns object instead of array
          this.latestMetrics = data;
        } else {
          console.warn('Location log returned empty or invalid data:', data);
        }
      } catch (error) {
        console.error('Failed to load metrics', error);
      }
    },
    async showLogFile() {
      this.showLog = true;
      this.logFileContent = 'Loading...';
      try {
        const res = await fetch('/api/location-log');
        if (!res.ok) {
          this.logFileContent = `Error: HTTP ${res.status}\n\nNote: In Vercel, logs are stored in memory and reset between function invocations.`;
          return;
        }
        const data = await res.json();
        if (Array.isArray(data) && data.length === 0) {
          this.logFileContent = `[]\n\nNote: Log file is empty. Logs are stored in Google Cloud Storage bucket (gs://levante-assets-dev/logs/locations.json) and persist across invocations and sessions. If you see this message, it means no logs have been written yet. Try clicking "Locate Me" first to create log entries.`;
        } else {
          this.logFileContent = JSON.stringify(data, null, 2);
        }
      } catch (error) {
        this.logFileContent = `Error: ${error.message}\n\nNote: In Vercel, logs are stored in memory and reset between function invocations.`;
      }
    }
  },
  mounted() {
    this.refreshMetrics();
  }
}).mount('#locateMeApp');

