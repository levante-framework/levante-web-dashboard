# Location + Firestore Integration

This project includes a cloud-friendly helper at `api/lib/location-store.js` that stores/retrieves `Location` documents validated by `@levante-framework/levante-zod`.

## Prerequisites

- `@levante-framework/levante-zod` version that exports:
  - `LocationSchema`
  - `locationDocId`
- Service account JSON in one of:
  - `GCP_SERVICE_ACCOUNT_JSON`
  - `GOOGLE_APPLICATION_CREDENTIALS_JSON`

## Cloud usage (Vercel API / Node runtime)

```js
const { saveLocation, getLocation } = require('./lib/location-store');

const location = {
  schemaVersion: 'location_v1',
  h3: {
    scheme: 'h3_v1',
    baseline: { cellId: '85283083fffffff', resolution: 5 },
    effective: { cellId: '87283082bffffff', resolution: 7 },
    populationThreshold: 50000,
  },
  latLon: {
    lat: 37.7793,
    lon: -122.4192,
    source: 'approximate',
    blurRadiusMeters: 500,
  },
};

const saved = await saveLocation({
  projectId: 'hs-levante-admin-prod',
  location,
  collection: 'locations',
});

const loaded = await getLocation({
  projectId: 'hs-levante-admin-prod',
  docId: saved.id,
  collection: 'locations',
});
```

## API endpoint wrapper

The repo also includes `api/location-upsert.js`:

- `POST /api/location-upsert` to validate + upsert a location document
- `GET /api/location-upsert?docId=...` to fetch and validate a location document

### POST example

```bash
curl -X POST "https://<your-host>/api/location-upsert" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "hs-levante-admin-prod",
    "collection": "locations",
    "location": {
      "schemaVersion": "location_v1",
      "h3": {
        "scheme": "h3_v1",
        "baseline": { "cellId": "85283083fffffff", "resolution": 5 },
        "effective": { "cellId": "87283082bffffff", "resolution": 7 },
        "populationThreshold": 50000
      },
      "latLon": {
        "lat": 37.7793,
        "lon": -122.4192,
        "source": "approximate",
        "blurRadiusMeters": 500
      }
    }
  }'
```

### GET example

```bash
curl "https://<your-host>/api/location-upsert?projectId=hs-levante-admin-prod&collection=locations&docId=h3:87283082bffffff:t:50000:v1"
```

## Notes

- Document IDs are deterministic via `locationDocId(location)`, so writes are naturally idempotent for the same effective cell + threshold + schema version.
- Runtime validation happens both on save and read through `LocationSchema`.
- If `@levante-framework/levante-zod` is missing or outdated, helper methods throw a clear error.

## On-device obfuscation first (no raw lat/lon persistence)

Use `buildObfuscatedLocationFromLatLon` from `public/ts/location-obfuscation.ts` and only send/store the returned `location` object.

- Raw `lat/lon` is used only transiently to compute H3 cells.
- Returned `location.latLon` is derived from the **effective H3 cell center**, not the raw input.
- If no population estimate is available for selecting effective resolution, baseline (r5 by default) is used as fallback.

Example:

```js
const result = await window.buildObfuscatedLocationFromLatLon(rawLat, rawLon, {
  populationThreshold: 50000,
  baselineResolution: 5,
  maxResolution: 9,
  // Either provide populationByResolution OR estimatePopulationForCell callback
  populationByResolution: {
    "9": 12000,
    "8": 29000,
    "7": 61000
  },
  latLonSource: "h3_center"
});

// Safe to persist: result.location
// Do not persist rawLat/rawLon
```

### Geostrategy-style effective selection (with population source)

Use the population-source variant when you want effective H3 to match geostrategy semantics:
- scan from baseline upward to finer resolutions
- keep promoting effective while `population >= populationThreshold`
- stop scanning after the first threshold failure once a valid effective cell exists (privacy-first)
- fallback to baseline if no candidate meets threshold

```js
const konturSource = window.createKonturPopulationSource({
  // resolution -> { cellId -> population }
  "6": {
    "862a1072fffffff": 45000,
    "862a10727ffffff": 18000
  },
  "7": {
    "872a1072bffffff": 52000
  }
});

const result = await window.buildObfuscatedLocationFromLatLonWithPopulationSource(
  rawLat,
  rawLon,
  konturSource,
  {
    populationThreshold: 50000,
    baselineResolution: 5,
    maxResolution: 9,
    latLonSource: "h3_center"
  }
);
```

### Compare Kontur vs WorldPop outcomes

```js
const konturSource = window.createKonturPopulationSource(konturCacheByResolution);
const worldpopSource = window.createWorldpopPopulationSource(worldpopCacheByResolution);

const comparison = await window.compareKonturAndWorldpopLocationBuild(
  rawLat,
  rawLon,
  konturSource,
  worldpopSource,
  {
    populationThreshold: 50000,
    baselineResolution: 5,
    maxResolution: 9,
    latLonSource: "h3_center"
  }
);

console.log(comparison.comparison);
// {
//   sameEffectiveCell: true|false,
//   sameEffectiveResolution: true|false,
//   konturEffective: { ... },
//   worldpopEffective: { ... }
// }
```
