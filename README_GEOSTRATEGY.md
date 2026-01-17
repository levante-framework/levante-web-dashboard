# Geo Strategy (On-Device De-Identification)

This document defines the **on-device strategy** for turning a raw GPS fix into a **de-identified geographic area** plus associated metadata (weather, altitude, school proximity, population density). It is the source of truth for how we **compute and store** privacy-preserving location summaries.

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

### 3) WorldPop 1km tile grid
- Build a **7x7 grid** of WorldPop **1 km tiles** centered on the faux location.
- Compute population totals for **7x7**, **5x5**, **3x3**, and **1x1** (centered).
- Choose the **smallest grid** whose population exceeds `POP_THRESHOLD` (default **50,000**).
- Store:
  - selected grid size (1, 3, 5, or 7)
  - population total
  - total area (km^2)

### 4) ADM2/ADM3 boundaries (de-identified)
- From the faux location, compute **ADM2** and **ADM3** names.
- Estimate population for each ADM polygon using WorldPop.
- **Discard** any ADM2/ADM3 results below `POP_THRESHOLD`.

### 5) Weather (original GPS, on-device only)
- Weather uses the **original GPS location**, but must be computed **entirely on-device**.
- If a network call is required:
  - **never send raw GPS**
  - use **rounded or faux coordinates** instead
  - log the rounding policy

### 6) Population density (original GPS, on-device)
- Use the **1 km tile** containing the original GPS point.
- Density = population per **1 km^2** tile.

### 7) Altitude (on-device preferred)
- Altitude should be derived from **local data** if available (SRTM/DEM).
- If remote fallback is required, **never use raw GPS**; use faux or rounded coordinates.

### 8) Local school (on-device preferred)
- Use an **on-device POI dataset** (e.g., OSM schools) with a small radius lookup.
- If remote fallback is required, **only query using faux coordinates**.

## Stored Output (De-identified Record)

Example schema (JSON):

```json
{
  "fauxLocation": { "lat": 37.7808, "lon": -122.4112, "direction": "NE" },
  "tileGrid": { "size": 3, "population": 86542, "areaKm2": 9 },
  "adm2": { "name": "San Francisco County", "population": 873965 },
  "adm3": { "name": "San Francisco", "population": 873965 },
  "weather": { "temperatureC": 16, "description": "Partly cloudy" },
  "altitudeM": 23,
  "populationDensityPerKm2": 7542,
  "nearestSchool": { "name": "Example School", "distanceKm": 1.2 }
}
```

## Tunable Flags

- `POP_THRESHOLD` (default **50,000**): minimum population for ADM2/ADM3 and tile selection.
- `SHIFT_KM` (default **1**): distance for faux location shift.
- `WEATHER_ROUNDING_DEG`: optional rounding for any remote weather queries.

## Implementation Notes

- **All raw GPS usage remains on device.**
- **Only de-identified** or **rounded** coordinates are allowed off-device.
- WorldPop tiles should be preloaded locally whenever possible to enable fully offline computation.
- If any step requires network access, **document the de-identification applied** to the query point.

## Gallery / Demo

The gallery at `public/gallery/geo-strategy/` demonstrates this strategy for the **46 demo sites** using the same algorithm and thresholds. The generation script is:

```
node scripts/generate-geo-strategy-gallery.js
```

It uses the seed points from `public/gallery/locate-me/seed-points.json`.

