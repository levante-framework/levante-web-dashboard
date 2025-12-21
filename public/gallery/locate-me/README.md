# Locate Me Gallery

This gallery showcases visual results from processing curated GPS points through the Locate‑Me workflow.

The gallery is served from:
- `public/gallery/locate-me/index.html`
- Data: `public/gallery/locate-me/gallery-data.json`
- Images: `public/gallery/locate-me/images/*.webp`

Seed points are maintained in:
- `public/gallery/locate-me/seed-points.json`

## How to Generate

1. **Install dependencies**:

```bash
npm install
```

2. **Generate/refresh gallery data** (nearest city + admin polygons):

```bash
node scripts/generate-locate-me-gallery.js
```

This reads `seed-points.json` and writes `gallery-data.json`.

Notes:
- Default nearest-city filter is `MAX_DISTANCE_KM = 20` in `scripts/generate-locate-me-gallery.js`
- For remote points, set `allowFar: true` in `seed-points.json` (e.g., Terlingua)

3. **Generate images** (Mapbox Static Images + Sharp overlays):

```bash
node scripts/generate-gallery-images.js
```

Requirements:
- `MAPBOX_ACCESS_TOKEN` in `.env` with access to Mapbox Static Images API

Selective image regeneration:

```bash
node scripts/generate-gallery-images.js --only=US-chicago
```

4. **View locally**:

```bash
python3 -m http.server 8005 --bind 127.0.0.1
```

Then open:
- `http://127.0.0.1:8005/public/gallery/locate-me/`

## What Each Image Shows

Each gallery image includes:
- **Map** (Mapbox basemap) + GeoJSON overlays:
  - GPS point marker
  - 2 & 10-mile circles
  - Blue regional boundary (ADM2)
  - Red local boundary (ADM3/ADM4; US prefers “place/city” when available)
- **Legend** (SVG overlay composited via Sharp):
  - Boundary names
  - Population estimates (sum of GeoNames cities inside polygon; approximate)
  - “Polygons downloaded” (estimated ADM pack bytes)
  - **Weather snapshot** (Open‑Meteo current weather)

Weather notes:
- Gallery generation caches Open‑Meteo responses in `data/gallery/weather-cache.json` (ignored by git).

## Related docs

See the canonical engineering writeup:
- `docs/locate-me/README.md`

