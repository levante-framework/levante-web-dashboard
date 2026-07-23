# Locate Me — Third-Party API Terms & Attributions

**Audience:** Release / compliance  
**Scope:** Interactive Locate Me (`public/locate-me.html`, `public/js/locate-me-v2.js`) and related air-quality proxy (`api/air-quality.js`)  
**Date:** 2026-07-23  

This is a summary of published provider terms for release review. It is **not legal advice**. Confirm final language with counsel before production distribution outside approved research use.

**Out of scope:** `ipwho.is` / ISP lookup is **not** part of the Locate Me release surface and should not be treated as a dependency.

---

## Dependency summary

| Provider | Purpose | Called from | Attribution required? |
|---|---|---|---|
| [Open-Meteo](https://open-meteo.com/) | Current weather (temp, humidity, heat index inputs, wind, cloud cover, weather code) | Browser → `api.open-meteo.com` | Yes (CC BY 4.0) |
| [WAQI / AQICN](https://waqi.info/) | Air quality index & station pollutants | Browser → `/api/air-quality` → `api.waqi.info` | Yes (WAQI + originating EPA) |
| [CARTO Basemaps](https://carto.com/) + [OpenStreetMap](https://www.openstreetmap.org/) | Interactive map tiles | Browser → `basemaps.cartocdn.com` | Yes (OSM + CARTO) |

On-device datasets (city index, ADM packs) are local assets, not these network APIs. OSM-derived boundary packs remain subject to the [Open Database Licence (ODbL)](https://opendatacommons.org/licenses/odbl/).

---

## 1. Open-Meteo (weather)

### Links
- Product / docs: https://open-meteo.com/en/docs  
- Terms & privacy: https://open-meteo.com/en/terms  
- Licence (CC BY 4.0 data): https://open-meteo.com/en/licence  
- Pricing (commercial / higher quota): https://open-meteo.com/en/pricing  
- Creative Commons NonCommercial interpretation: https://wiki.creativecommons.org/wiki/NonCommercial_interpretation  
- CC BY 4.0 deed: https://creativecommons.org/licenses/by/4.0/

### Key terms (free API)
- Free API is for **non-commercial** use only.
- Free rate limits: **&lt; 10,000 calls/day**, **5,000/hour**, **600/minute**.
- Public research at public institutions is listed by Open-Meteo as an example of non-commercial use; commercial products, ads, or subscriptions generally require a paid plan.
- API data is offered under **CC BY 4.0**.
- Service is provided without warranty; Open-Meteo may block misuse.

### Required attribution
Display credit next to weather UI, for example:

```html
<a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a>
```

---

## 2. WAQI / AQICN (air quality)

### Links
- API overview & usage policy: https://aqicn.org/api/  
- Token / data platform: https://aqicn.org/data-platform/token/  
- Project site: https://waqi.info/  
- JSON API docs: https://aqicn.org/json-api/doc/

### Key terms
- API token required for all access.
- Data **may not** be sold or included in sold packages.
- Data **may not** be used in paid applications or services.
- Data **may not** be redistributed as cached or archived data.
- **Attribution** to the World Air Quality Index Project **and** the originating EPA is mandatory.
- Public use by **for-profit** corporations requires **explicit agreement** with the WAQI team.
- Public use by **non-profit** organizations requires **prior notification** (email) to the WAQI team.
- Terms may change without prior notice; no warranty on accuracy.

### Required attribution
Credit in AQI UI / about copy, for example:

- Air quality data from the [World Air Quality Index Project](https://waqi.info/)
- Plus originating EPA / agency name when available from the station feed (`dominantPollutant` / station metadata)

**Release action:** Confirm whether Levante’s intended distribution is covered under non-profit notification or needs a written for-profit agreement / commercial arrangement with WAQI.

---

## 3. CARTO Basemaps + OpenStreetMap (map)

### Links
- OpenStreetMap copyright: https://www.openstreetmap.org/copyright  
- OSM Foundation licence FAQ: https://wiki.osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ  
- OSM attribution guidelines: https://wiki.osmfoundation.org/wiki/Licence/Attribution_Guidelines  
- ODbL 1.0: https://opendatacommons.org/licenses/odbl/  
- CARTO legal hub: https://carto.com/legal/  
- CARTO Basemaps Terms of Service: https://carto.com/legal/bmap/

### Key terms
- OSM geodata is under **ODbL**; use for any purpose is allowed, but **attribution is required**.
- Locate Me renders tiles from CARTO’s basemap CDN (`basemaps.cartocdn.com`), which also carries OSM-derived content; follow **CARTO Basemaps ToS** in addition to OSM attribution rules.
- Current in-app attribution string:

```text
© OpenStreetMap contributors © CARTO
```

### Required attribution
Keep visible map attribution (or equivalent “About / Data sources” credit) for:
- © OpenStreetMap contributors — https://www.openstreetmap.org/copyright  
- © CARTO — https://carto.com/

---

## Suggested UI / release copy block

Use or adapt this on Locate Me (legend footer, about panel, or release notes):

> **Data sources**  
> Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0).  
> Air quality data from the [World Air Quality Index Project](https://waqi.info/) and originating environmental agencies.  
> Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, © [CARTO](https://carto.com/).

---

## Release checklist

- [ ] Open-Meteo attribution visible wherever weather is shown  
- [ ] Confirm free Open-Meteo use matches non-commercial / research posture, **or** purchase a commercial plan  
- [ ] WAQI attribution (project + EPA) visible wherever AQI is shown  
- [ ] WAQI: send non-profit notification **or** obtain for-profit agreement, as applicable  
- [ ] Confirm AQI is not redistributed as a sold/cached data product outside policy  
- [ ] OSM + CARTO attribution visible on the map  
- [ ] Confirm ISP / `ipwho.is` is disabled or removed from the shipped build  
- [ ] Legal sign-off on commercial vs research distribution model  

---

## Code pointers

| Concern | Location |
|---|---|
| Weather fetch (Open-Meteo) | `public/js/locate-me-v2.js` → `fetchCoarseWeather()` |
| Air quality client | `public/js/locate-me-v2.js` → `fetchAirQuality()` |
| WAQI proxy | `api/air-quality.js` |
| Map tiles + attribution | `public/js/locate-me-v2.js` (Leaflet `L.tileLayer`, attribution string) |
