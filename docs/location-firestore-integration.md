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
