#!/usr/bin/env node

/**
 * Build a compact JSON dataset of populated places from the GeoNames cities5000 dump.
 *
 * Usage:
 *   node scripts/geocoder/build-geocoder.js
 *
 * Expects the raw txt file at data/geonames/cities5000.txt (download from https://download.geonames.org/export/dump/cities5000.zip).
 * Generates data/geocoder/cities.min.json containing an array of records:
 * { id, name, ascii, lat, lon, country, admin1, admin2, population }
 */

const fs = require('fs');
const path = require('path');

const INPUT_PATH = path.join(process.cwd(), 'data', 'geonames', 'cities5000.txt');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'geocoder');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'cities.min.json');

function parseLine(line) {
  if (!line) return null;
  const parts = line.split('\t');
  if (parts.length < 15) {
    return null;
  }
  const [
    geonameId,
    name,
    asciiName,
    _altNames,
    lat,
    lon,
    featureClass,
    featureCode,
    countryCode,
    _cc2,
    admin1,
    admin2,
    admin3,
    admin4,
    population
  ] = parts;

  if (!lat || !lon || !name) {
    return null;
  }

  return {
    id: Number(geonameId),
    name: name,
    ascii: asciiName || name,
    lat: Number(lat),
    lon: Number(lon),
    country: countryCode || '',
    admin1: admin1 || '',
    admin2: admin2 || '',
    population: Number(population) || 0,
    featureClass: featureClass || '',
    featureCode: featureCode || ''
  };
}

function main() {
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`❌ Missing input file at ${INPUT_PATH}. Download cities5000.zip from GeoNames and extract before running this script.`);
    process.exit(1);
  }

  console.log(`➡️  Reading ${INPUT_PATH} ...`);
  const raw = fs.readFileSync(INPUT_PATH, 'utf8');
  const lines = raw.split('\n');
  const results = [];

  for (const line of lines) {
    const record = parseLine(line.trim());
    if (!record) continue;

    // Optionally filter out very small places by population; keep everything >= 1000 residents.
    if (record.population && record.population < 1000) {
      continue;
    }

    // Round coordinates to 5 decimal places to cut size.
    record.lat = Math.round(record.lat * 1e5) / 1e5;
    record.lon = Math.round(record.lon * 1e5) / 1e5;

    results.push({
      id: record.id,
      name: record.name,
      ascii: record.ascii,
      lat: record.lat,
      lon: record.lon,
      country: record.country,
      admin1: record.admin1,
      admin2: record.admin2,
      population: record.population
    });
  }

  console.log(`✅ Parsed ${results.length.toLocaleString()} records.`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results));
  const stats = fs.statSync(OUTPUT_PATH);
  console.log(`💾 Wrote ${OUTPUT_PATH} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
}

main();

