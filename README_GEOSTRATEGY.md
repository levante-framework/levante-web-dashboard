# Geo Strategy (Hex/H3 De-Identification)

This document defines the current geo-strategy used by the gallery generator to turn a GPS fix into a de-identified geographic area plus metadata (weather, altitude, school proximity, population density). The primary privacy shape is now **H3 hex cells**, with 1 km tile summaries retained as supporting diagnostics.

## Goals

- **Never transmit raw GPS coordinates** off the device.
- Preserve **useful geographic context** for analysis and gallery display.
- Provide a **repeatable de-identification algorithm** with tunable thresholds.
- Capture **additional derived data** while the GPS fix is available (weather, altitude, local school, population density).

## Core Strategy

### 1) On-device GPS fix
- The device obtains the raw GPS location (`lat`, `lon`) locally.
- This **raw point never leaves the device**.

### 2) Create a faux location (de-identified)
- Shift the raw GPS by **1 km** in one of **8 compass directions** (N, NE, E, SE, S, SW, W, NW).
- Direction selection should be deterministic per device/session (e.g., hash of device id + day).
- The shifted point becomes the **faux location** used for all remote lookups.

### 3) H3 hex cell selection (primary de-identified area)
- Compute a **base H3 cell** at `H3_BASE_RES` around the faux location.
- Evaluate finer cells up to `H3_EFFECTIVE_MAX_RES`.
- Select the **highest resolution (smallest) H3 cell** whose estimated population is at least `POP_THRESHOLD` (default **50,000**).
- Store:
  - base cell id/resolution/population
  - effective cell id/resolution/population
  - outlines and selection candidates

### 4) WorldPop 1km tile grid (supporting metrics)
- Build a 7x7 grid of 1 km tiles around the faux location.
- Compute totals for 7x7, 5x5, 3x3, and 1x1 and keep the smallest selection that meets threshold.
- These values are retained for comparability/diagnostics; they are not the primary privacy geometry.

### 5) ADM2/ADM3 boundaries (de-identified)
- From the faux location, compute **ADM2** and **ADM3** names.
- Estimate population for each ADM polygon using WorldPop.
- **Discard** any ADM2/ADM3 results below `POP_THRESHOLD`.

### 6) Weather (original GPS, on-device only)
- Weather uses the **original GPS location**, but must be computed **entirely on-device**.
- If a network call is required:
  - **never send raw GPS**
  - use **rounded or faux coordinates** instead
  - log the rounding policy

### 7) Population density (original GPS, on-device)
- Use the **1 km tile** containing the original GPS point.
- Density = population per **1 km^2** tile.

### 8) Altitude (on-device preferred)
- Altitude should be derived from **local data** if available (SRTM/DEM).
- If remote fallback is required, **never use raw GPS**; use faux or rounded coordinates.

### 9) Local school (on-device preferred)
- Use an **on-device POI dataset** (e.g., OSM schools) with a small radius lookup.
- If remote fallback is required, **only query using faux coordinates**.

## Stored Output (De-identified Record)

Example schema (JSON):

```json
{
  "fauxLocation": { "lat": 37.7808, "lon": -122.4112, "direction": "NE" },
  "h3": {
    "scheme": "h3_v1",
    "base": { "cellId": "85283083fffffff", "resolution": 5, "population": 211245 },
    "effective": { "cellId": "892830828c7ffff", "resolution": 9, "population": 51208 }
  },
  "tileGrid": { "size": 3, "population": 86542, "areaKm2": 9 },
  "adm2": { "name": "San Francisco County", "population": 873965 },
  "adm3": { "name": "San Francisco", "population": 873965 },
  "weather": {
    "temperatureC": 16,
    "humidity": 72,
    "heatIndexC": 16.1,
    "cloudCover": 40,
    "windKph": 12.5,
    "description": "Partly cloudy"
  },
  "altitudeM": 23,
  "populationDensityPerKm2": 7542,
  "nearestSchool": { "name": "Example School", "distanceKm": 1.2 }
}
```

## Tunable Flags

- `POP_THRESHOLD` (default **50,000**): minimum population for effective H3 selection and ADM filtering.
- `SHIFT_KM` (default **1**): distance for faux location shift.
- `WEATHER_ROUNDING_DEG`: optional rounding for any remote weather queries.
- `GEO_H3_BASE_RES` (default **5**): base H3 resolution.
- `GEO_H3_EFFECTIVE_MAX_RES` (default **9**): max H3 resolution checked for effective cell selection.
- `GEO_H3_POPULATION_SOURCE` (default **kontur**): H3 population estimate source.

## Implementation Notes

- **All raw GPS usage remains on device.**
- **Only de-identified** or **rounded** coordinates are allowed off-device.
- H3 is the primary de-identification geometry for geo-strategy output.
- WorldPop tiles are still computed for density/supporting diagnostics.
- If any step requires network access, **document the de-identification applied** to the query point.

## Gallery / Demo

The gallery at `public/gallery/geo-strategy/` demonstrates this strategy for the **46 demo sites** using the same algorithm and thresholds. The generation script is:

```
node scripts/generate-geo-strategy-gallery.js
```

It uses the seed points from `public/gallery/locate-me/seed-points.json`.

