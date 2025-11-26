# GADM-driven Locate Me flow

## Data sources

- **Raw boundaries**: We keep GADM shapefiles zipped under `gs://levante-assets-dev/maps`. Each country is mapped in `config/gadm-bucket-files.json` (example: `"US": "maps/gadm41_USA_shp.zip"`).
- **Country list**: `config/gadm-countries.json` lists the ten countries whose polygons we currently care about.
- **City lookup**: The offline geocoder (`data/geocoder/cities.min.json(.gz)`) supplies the top two nearest `name/admin1/country` tuples that drive which polygons we request.

## API behavior (`api/gadm-polygon.js`)

1. **Download + cache** – On the first request for a country, the function downloads the zipped shapefile from GCS, unzips it into a temporary directory, picks the highest-level shapefile (preferring `_3`/`_2`), reads every feature via `shapefile`, and caches both the raw features (`bucketCache`) and a snippet index keyed by `name|admin1|country` (`snippetCache`).
2. **Exact-match snippet first** – Before doing any point-in-polygon math, the handler tries to match the incoming `name`, `ascii`, and `admin1` against the pre-built snippet index. Matching keys are normalized the same way `public/js/locate-me-v2.js` builds `normalizeGadmKey`.
3. **Fallback scan** – If there is no snippet match (e.g., the town does not appear in that shapefile), it iterates the cached features and tests each polygon with `@turf/boolean-point-in-polygon`. The same helper logic still prefers the most specific polygon (highest `GID` level, smallest area).
4. **Response payload** – Every response includes the selected GeoJSON feature, `adminLevel`, `candidates`, and a `source` flag (`"snippet"` or `"scan"`) for debugging/logging.
5. **Caching** – Both downloads and snippet indexes persist for the process lifetime. Future requests for the same country reuse the in-memory data.

## Snippet generation (`scripts/build-gadm-snippets.js`)

This helper can be used if you prefer to precompute the town polygons rather than rebuilding them at runtime:

```bash
node scripts/build-gadm-snippets.js \
  --input /path/to/gadm41_USA.geojson \
  --output public/data/gadm/snippets.json \
  --config config/gadm-countries.json
```

- The script normalizes `name`, `admin1`, and `country`, grouping any matching features into a `FeatureCollection` that you can upload somewhere faster than the original 100+ MB shapefiles.
- The output is not currently used by the API, but the same normalization rules are reused: `name|admin1|country` with everything trimmed and lowercased.
- Run the script after you download updated GADM extracts for any of the countries in `config/gadm-countries.json`.

## Frontend usage (`public/js/locate-me-v2.js`)

- When the Locate Me cards render, the map `drawRegionPolygons` function requests `/api/gadm-polygon` with `name`, `admin1`, `country`, `lat`, and `lon`.
- `fetchGadmPolygon` caches responses using the same normalized key, so repeated renders do not hit the server.
- After you deploy a change that bumps `package.json`, the `scripts/apply-version.js` helper rewrites the footer and asset query strings so browsers load the fresh bundle.

## Looking ahead

- If you need to add or remove countries, update both `config/gadm-countries.json` and `config/gadm-bucket-files.json`, then re-run `scripts/build-gadm-snippets.js` (or clear the runtime caches if you prefer on-demand loading).
- To debug a new region, look at the Vercel logs. The API logs whether it returned a snippet match (with the normalized key) before doing a `boolean-point-in-polygon` scan.
- When asking for further tweaks, mention whether you are talking about the geocoder (`api/reverse-geocode.js`), the map polygons (`api/gadm-polygon.js` / `scripts/build-gadm-snippets.js`), or just the frontend component.

