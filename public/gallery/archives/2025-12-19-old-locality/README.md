# Locate Me Gallery Archive – 2025-12-19 (old locality logic)

This folder preserves the gallery outputs generated **before** the new coarse-index + per-country locality logic. Use this if we need to reference or revert to the previous algorithm.

- **Source branch/tag:** (to be tagged after commit) `gallery-old-locality-2025-12-19`
- **Scripts used:**
  - `node scripts/generate-locate-me-gallery.js` (uses reverse-geocode and polygons; no coarse index / per-country slice optimization)
  - `MAPBOX_ACCESS_TOKEN=... node scripts/generate-gallery-images.js`
- **Base URL:** default `BASE_URL` env in script (`https://levante-audio-dashboard.vercel.app` at generation time)
- **Date generated:** 2025-12-19
- **Contents:**
  - `gallery-data.json`
  - `images/*.webp` (35 images)

## How to regenerate this archived set
1) Ensure the *old* `scripts/generate-locate-me-gallery.js` (pre coarse-index changes) is checked out.
2) Run `node scripts/generate-locate-me-gallery.js` to refresh `public/gallery/locate-me/gallery-data.json`.
3) Export Mapbox token and run `MAPBOX_ACCESS_TOKEN=... node scripts/generate-gallery-images.js`.
4) Copy `gallery-data.json` and `images/*.webp` into this archive folder.

## Tagging
After committing this archive, create/push tag:
```
git tag -a gallery-old-locality-2025-12-19 -m "Archive old gallery locality logic"
```
Then push: `git push origin gallery-old-locality-2025-12-19`.
