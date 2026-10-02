#!/usr/bin/env node
/**
 * Build Ghana H3 resolution-5 cells with WorldPop estimates.
 *
 *   node scripts/generate-ghana-h3-r5-map.js [resolution]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const h3 = require('h3-js');

const ROOT = path.join(__dirname, '..');
const RESOLUTION = Number(process.argv[2] || 5);
if (!Number.isInteger(RESOLUTION) || RESOLUTION < 0 || RESOLUTION > 15) {
  throw new Error('resolution must be an integer 0-15');
}
const OUT_DIR = path.join(ROOT, 'public', 'gallery', `ghana-h3-r${RESOLUTION}`);
const ADM0_PATH = path.join(ROOT, 'public', 'adm0', 'countries.min.json.gz');
const CITIES_PATH = path.join(ROOT, 'data', 'geocoder', 'cities.min.json');
const RASTER_CANDIDATES = [
  { path: path.join(ROOT, 'data', 'population', 'worldpop', 'GHA_2020_100m_UNadj.tif'), year: 2020, resolution: '100m' },
  { path: path.join(ROOT, 'data', 'population', 'worldpop', 'GHA_2020_100m.tif'), year: 2020, resolution: '100m' },
  { path: path.join(ROOT, 'data', 'population', 'worldpop', 'GHA_2022_1km.tif'), year: 2022, resolution: '1km' },
  { path: path.join(ROOT, 'data', 'population', 'worldpop', 'GHA_2020_1km.tif'), year: 2020, resolution: '1km' },
];
const PYTHON = path.join(ROOT, 'venv', 'bin', 'python');
const ESTIMATOR = path.join(__dirname, 'estimate-h3-worldpop.py');

function loadGhanaPolygon() {
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(ADM0_PATH)).toString('utf8'));
  const feature = (data.features || []).find((entry) => entry.properties?.iso2 === 'GH');
  if (!feature?.geometry) {
    throw new Error('Ghana polygon not found in ADM0 pack');
  }
  return feature.geometry;
}

function cellIdsForGhana(geometry) {
  const rings = (geometry.coordinates || []).map((ring) =>
    ring.map(([lng, lat]) => [lat, lng])
  );
  return h3.polygonToCells(rings, RESOLUTION);
}

function ringToLngLat(cellId) {
  return h3.cellToBoundary(cellId).map(([lat, lng]) => [lng, lat]);
}

function main() {
  const raster = RASTER_CANDIDATES.find((candidate) => fs.existsSync(candidate.path));
  if (!raster) {
    throw new Error('Missing Ghana WorldPop raster (expected 100m or 1km under data/population/worldpop/)');
  }
  console.log(`H3 r${RESOLUTION}; using ${path.relative(ROOT, raster.path)} (${raster.resolution}, ${raster.year})`);
  if (!fs.existsSync(PYTHON)) {
    throw new Error(`Missing venv python with rasterio: ${PYTHON}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const ghana = loadGhanaPolygon();
  const cellIds = cellIdsForGhana(ghana);
  const cities = JSON.parse(fs.readFileSync(CITIES_PATH, 'utf8')).filter(
    (city) => String(city.country || '').toUpperCase() === 'GH'
  );
  const townsByCell = new Map();
  for (const city of cities) {
    const cellId = h3.latLngToCell(Number(city.lat), Number(city.lon), RESOLUTION);
    if (!townsByCell.has(cellId)) townsByCell.set(cellId, []);
    townsByCell.get(cellId).push({
      name: city.name,
      population: Number(city.population) || 0,
    });
  }

  const features = cellIds.map((cellId) => {
    const ring = ringToLngLat(cellId);
    ring.push(ring[0]);
    const towns = townsByCell.get(cellId) || [];
    return {
      type: 'Feature',
      properties: {
        cellId,
        resolution: RESOLUTION,
        townCount: towns.length,
        townPopSum: towns.reduce((sum, town) => sum + town.population, 0),
        towns: towns
          .slice()
          .sort((a, b) => b.population - a.population)
          .slice(0, 5),
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    };
  });

  const tempCells = path.join(OUT_DIR, '_cells-tmp.geojson');
  const tempPops = path.join(OUT_DIR, '_pops-tmp.json');
  fs.writeFileSync(tempCells, JSON.stringify({ type: 'FeatureCollection', features }));

  const estimate = spawnSync(
    PYTHON,
    [ESTIMATOR, raster.path, tempCells, tempPops],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  if (estimate.status !== 0) {
    throw new Error(estimate.stderr || estimate.stdout || 'WorldPop estimate failed');
  }
  process.stdout.write(estimate.stdout);

  const pops = JSON.parse(fs.readFileSync(tempPops, 'utf8'));
  for (const feature of features) {
    const population = pops[feature.properties.cellId];
    feature.properties.population = typeof population === 'number' ? population : null;
    feature.properties.populationSource = 'worldpop';
  }

  const populations = features
    .map((feature) => feature.properties.population)
    .filter((value) => typeof value === 'number');
  populations.sort((a, b) => a - b);

  const payload = {
    generatedAt: new Date().toISOString(),
    country: { name: 'Ghana', iso2: 'GH', iso3: 'GHA' },
    h3: { scheme: 'h3_v1', resolution: RESOLUTION },
    populationSource: 'worldpop',
    populationYear: raster.year,
    rasterResolution: raster.resolution,
    rasterFile: path.relative(ROOT, raster.path),
    cellCount: features.length,
    stats: {
      min: populations[0] ?? null,
      p25: populations[Math.floor((populations.length - 1) * 0.25)] ?? null,
      p50: populations[Math.floor((populations.length - 1) * 0.5)] ?? null,
      p75: populations[Math.floor((populations.length - 1) * 0.75)] ?? null,
      max: populations[populations.length - 1] ?? null,
      under20k: populations.filter((value) => value < 20000).length,
      total: populations.reduce((sum, value) => sum + value, 0),
    },
    features,
  };

  fs.writeFileSync(path.join(OUT_DIR, 'cells.json'), JSON.stringify(payload));
  fs.unlinkSync(tempCells);
  fs.unlinkSync(tempPops);
  console.log(`wrote ${features.length} cells to ${path.relative(ROOT, path.join(OUT_DIR, 'cells.json'))}`);
  console.log('stats', payload.stats);
}

main();
