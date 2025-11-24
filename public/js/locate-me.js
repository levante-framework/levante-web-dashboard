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
            const payload = await response.json();
            if (!response.ok) {
              throw new Error(payload?.message || payload?.error || 'Unknown error');
            }

            this.resultText = JSON.stringify(payload, null, 2);
            this.status = 'Nearest city resolved';
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

