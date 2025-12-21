This folder holds static ADM2/ADM3 boundary packs by country code (e.g., co.json, de.json, us.json).

How to build:
1) Run one of the scripts:
   - npm run adm:build:co
   - npm run adm:build:de
   - npm run adm:build:us
   - npm run adm:build           # builds the default list (CO, DE, US)
2) Output is saved as public/adm-packs/<country>.json (GeoJSON FeatureCollection).

Privacy note: raw GPS never leaves the device. Packs are fetched by country code only.

