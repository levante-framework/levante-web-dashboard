# How Levante Protects Participant Location Data

**For research sites and institutional review**  
**Product scope:** shipping Locate Me / on-device location pipeline  
**Audience:** site PIs, research coordinators, IRB / privacy offices  

This document explains, in plain language, how Levante handles geographic location so that **precise GPS coordinates are not sent to Levante servers or third-party services**. Location is processed **on the participant’s device** using published, repeatable algorithms designed to keep useful research context while reducing re-identification risk.

---

## The short version

1. The device reads the participant’s GPS **locally** (with their permission).
2. Almost all geographic work—finding the nearest city, matching administrative boundaries, choosing a privacy-safe area—runs **on the device** using datasets that travel with the app.
3. **Raw latitude and longitude never leave the device.**
4. If the app needs an outside weather or air-quality service, it sends only a **deliberately imprecise** query (shifted and/or rounded), never the true GPS point.
5. Anything kept for research is a **de-identified location record** (for example an H3 hex cell large enough to include tens of thousands of people)—not a pin on the participant’s home or school.

---

## Why this design

Research often needs *context* (region, environment, air quality) without needing *identity-grade precision*. Precise GPS can reveal homes, clinics, or schools. Levante therefore separates:

| Kept on device (precise) | Allowed off device (de-identified) |
|---|---|
| Raw GPS fix | Coarse / shifted query points |
| Point-in-polygon boundary matching | Weather for a large area |
| Choosing the nearest air-quality station | Air-quality *readings* (without station coordinates) |
| Building the privacy-safe research location | H3 cell IDs, region names, environmental summaries |

---

## What happens on the device

### 1. GPS stays local
When the participant uses Locate Me, the browser or app obtains a GPS fix on the device. That raw point is used only in local memory for the steps below. It is **not** uploaded as part of the location pipeline.

### 2. Places and boundaries are resolved offline
After the page/app assets load, reverse geocoding and boundary lookup do **not** require sending GPS to a Levante or map server:

- **Nearest city / place** — looked up against a compact on-device city dataset (GeoNames-derived).
- **Administrative areas** — matched with pre-built boundary packs (regional and local polygons) using point-in-polygon logic **on the device**.

So “where am I administratively?” can be answered without a live geocoding API that would receive exact coordinates.

### 3. A privacy-safe research area is chosen with H3
For stored research location, Levante uses the [H3](https://h3geo.org/) hexagonal grid—a standard way to represent areas at multiple sizes (resolutions).

**Algorithm (simplified):**

1. Start from a **base** hex cell around a de-identified position.
2. Consider **finer** (smaller) cells up to a configured maximum resolution.
3. Select the **smallest cell whose estimated population is still at least ~20,000** (default threshold).
4. If no finer cell meets the threshold, keep a coarser (larger) cell.

**Why a population threshold?**  
A tiny cell in a dense city may still contain many people; the same-sized cell in a rural area might contain very few. By requiring roughly **20,000 people** in the chosen cell, the system prefers areas that are large enough, in population terms, to reduce the chance that a stored cell points uniquely at one household or school.

The coordinates that may be associated with a saved location are the **center of that chosen H3 cell**, not the participant’s raw GPS.

### 4. “Faux location” for any remote lookup that needs a point
When a network service must be asked something location-related, Levante first creates a **faux location**:

- Shift the true GPS by about **1 km**
- In one of **eight compass directions** (N, NE, E, SE, S, SW, W, NW)
- Direction is chosen **deterministically** for a given coarse context and day (not random each tap), so the true point is not the obvious center of the request

Remote calls use this shifted point (or further coarsened coordinates)—**never the raw GPS**.

---

## Optional environmental lookups (still privacy-masked)

These enrich the session with context. They are **not** required to resolve city or boundaries, and they never receive exact GPS.

### Weather
Weather is fetched from a public weather API using a **coarse query point**:

1. Prefer the center of the local regional (ADM2) area, or else the nearest-city center, or else heavily rounded GPS.
2. Round again to about **0.25°** (~25 km at the equator) before the network request.

Only that coarse position is sent. Temperature, humidity, heat index, cloud cover, and similar fields come back for display/research context—not a trail to the participant’s exact spot.

### Air quality
Air quality uses a privacy-masked flow:

1. Build a faux location (~1 km shift), as above.
2. Request stations inside a **~10 km × 10 km** box around that faux center (not around the true GPS).
3. On the device, rank returned stations using the **local** raw GPS (still never uploaded) to pick the nearest station.
4. Fetch pollutant details using the station’s **public station ID** only.
5. Store AQI category and readings **without** saving station coordinates or raw GPS.

The server proxy holds the air-quality API token and does not need the participant’s true coordinates.

---

## What institutions can expect to see in research data

A de-identified location record may include things like:

- An **H3 cell identifier** and resolution (the privacy-safe area)
- Optional cell-center coordinates **derived from that cell**, not from GPS
- **Environmental summaries** (e.g., weather, AQI category)—without precise query coordinates or station lat/lon

---

## What never leaves the device (location pipeline)

- Raw GPS latitude / longitude  
- Exact home, school, or clinic pin as a transmitted coordinate  
- Use of raw GPS as the center of third-party weather or air-quality requests  

Map tiles shown on screen are ordinary basemap imagery; they do not require uploading the participant’s GPS to Levante to draw the local UI. Precise matching for cities and boundaries remains local.

---

## Design principles (checklist for reviewers)

| Principle | How Levante applies it |
|---|---|
| Minimize collection of precise location | Raw GPS is ephemeral and on-device only |
| Process locally first | City + admin boundary matching on device |
| De-identify before share/store | H3 cell with ~50k population threshold; cell center, not GPS |
| Mask remote queries | 1 km faux shift; weather rounding; AQI area box around faux center |
| Prefer area over point | Hex cells and admin regions instead of street-level pins |
| Repeatable algorithm | Documented thresholds (shift distance, population floor, H3 resolutions) |

---

## Plain-language analogy

Think of GPS as a street address written on a sticky note that **never leaves the room**. The device uses that note to look things up in a **local atlas** (cities and boundaries). When it must phone an outside weather or air-quality service, it only describes a **wide neighborhood** (shifted and rounded)—not the sticky note. What research keeps is closer to “this hex-shaped district of ~50,000+ people,” not “this doorstep.”

---

*This document describes product behavior as implemented for Levante’s on-device location pipeline. Institutional policies, consent language, and IRB determinations remain the responsibility of each research site.*
