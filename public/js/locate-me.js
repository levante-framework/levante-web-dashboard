const { createApp } = Vue;

createApp({
  data() {
    return {
      status: 'Click Locate Me to begin',
      resultText: '',
      latestMetrics: null,
      loading: false,
      error: null
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
              limit: '3',
              maxDistanceKm: '150'
            });
            const response = await fetch(`/api/reverse-geocode?${query.toString()}`);
            if (!response.ok) {
              const errorPayload = await response.json().catch(() => ({ error: 'Unknown error' }));
              throw new Error(errorPayload?.message || errorPayload?.error || 'Unknown error');
            }
            const payload = await response.json();

            // Parse and display the results nicely
            if (payload.results && payload.results.length > 0) {
              const best = payload.results[0];
              const parts = [best.name, best.admin1, best.country].filter(Boolean);
              const locationLine = parts.join(', ');
              this.resultText = `${locationLine}\n\nApproximately ${best.distanceKm} km away\n\nCoordinates: ${payload.lat.toFixed(4)}, ${payload.lon.toFixed(4)}\n\nFull results:\n${JSON.stringify(payload, null, 2)}`;
              this.status = `Found: ${locationLine}`;
            } else {
              this.resultText = 'No nearby populated place found within 150 km.';
              this.status = 'No city found';
            }
            await this.refreshMetrics();
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
      try {
        const res = await fetch('/api/location-log');
        if (!res.ok) return;
        const data = await res.json();
        this.latestMetrics = data[0] || null;
      } catch (error) {
        console.error('Failed to load metrics', error);
      }
    }
  },
  mounted() {
    this.refreshMetrics();
  }
}).mount('#locateMeApp');

