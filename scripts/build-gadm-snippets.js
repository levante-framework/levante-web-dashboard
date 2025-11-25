#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const shapefile = require('shapefile');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    description: 'Path to the GADM GeoJSON or shapefile (`.geojson`, `.json`, `.shp` + `.dbf` are supported)',
    type: 'string',
    demandOption: true
  })
  .option('output', {
    alias: 'o',
    description: 'Output path for the snippets JSON file',
    type: 'string',
    default: 'public/data/gadm/snippets.json'
  })
  .option('config', {
    alias: 'c',
    description: 'Config file that lists the countries to include',
    type: 'string',
    default: 'config/gadm-countries.json'
  })
  .help()
  .alias('help', 'h')
  .argv;

const countriesConfigPath = path.resolve(argv.config);
if (!fs.existsSync(countriesConfigPath)) {
  console.error(`Config file not found: ${countriesConfigPath}`);
  process.exit(1);
}
const { countries } = JSON.parse(fs.readFileSync(countriesConfigPath, 'utf8'));
const countryFilter = new Set((countries || []).map((name) => name.trim().toLowerCase()));

function normalizeKey(name, admin1, country) {
  const parts = [name, admin1, country].map((part) => (part || '').trim().toLowerCase());
  return parts.join('|');
}

function buildFeature(feature) {
  const { type, geometry, properties } = feature;
  return {
    type: type || 'Feature',
    geometry,
    properties: properties || {}
  };
}

async function readFeaturesFromShapefile(shpPath) {
  const features = [];
  try {
    const source = await shapefile.open(shpPath);
    while (true) {
      const result = await source.read();
      if (result.done) break;
      features.push(buildFeature(result.value));
    }
  } catch (error) {
    throw new Error(`Failed to read shapefile ${shpPath}: ${error.message}`);
  }
  return features;
}

async function readFeatures(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.geojson' || ext === '.json') {
    const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    if (raw.type === 'FeatureCollection' && Array.isArray(raw.features)) {
      return raw.features;
    }
    throw new Error('GeoJSON input must be a FeatureCollection');
  }
  if (ext === '.shp') {
    return await readFeaturesFromShapefile(inputPath);
  }
  throw new Error('Unsupported format. Please provide .geojson, .json, or .shp');
}

(async () => {
  const inputPath = path.resolve(argv.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const features = await readFeatures(inputPath);
  const snippets = {};

  for (const feature of features) {
    const props = feature.properties || {};
    const country = (props.NAME_0 || props.ADMIN0_NAME || props.ADM0_NAME || '').trim();
    if (!country || !countryFilter.has(country.toLowerCase())) {
      continue;
    }
    const admin1 = (props.NAME_1 || props.ADM1_NAME || '').trim();
    const name = (props.NAME || props.NAME_EN || props.NAME_LOCAL || '').trim();
    const normalized = normalizeKey(name, admin1, country);
    if (!snippets[normalized]) {
      snippets[normalized] = {
        type: 'FeatureCollection',
        features: []
      };
    }
    snippets[normalized].features.push(buildFeature(feature));
  }

  const outputPath = path.resolve(argv.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(snippets, null, 2), 'utf8');
  console.log(`Generated ${Object.keys(snippets).length} polygon snippet(s) at ${outputPath}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
