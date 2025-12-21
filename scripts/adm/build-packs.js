#!/usr/bin/env node
/**
 * Build offline ADM packs for client-side lookup.
 *
 * Produces per-country, per-level files:
 *   public/adm-packs/<iso2>/adm1.json.gz
 *   public/adm-packs/<iso2>/adm2.json.gz
 *
 * (Optional) also writes uncompressed JSON if --writeJson is set.
 *
 * Minification strategy:
 * - Keep only essential properties (name, iso2, id)
 * - Round coordinates (default precision=3)
 * - Downsample each ring to a max vertex count (default maxPoints=250)
 *
 * Usage:
 *   node scripts/adm/build-packs.js --countries=CO,DE,US
 *   node scripts/adm/build-packs.js --countries=CO --maxPoints=300 --precision=3
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const fetch = require('node-fetch');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const DEFAULT_COUNTRIES = ['CO', 'DE', 'US'];
const LEVELS = ['ADM1', 'ADM2'];

const ISO3_MAP = {
  CO: 'COL',
  DE: 'DEU',
  US: 'USA',
  NL: 'NLD',
  CA: 'CAN',
  GB: 'GBR',
  IN: 'IND',
  AR: 'ARG',
  GH: 'GHA',
  CH: 'CHE'
};

const DEST_DIR = path.join(process.cwd(), 'public', 'adm-packs');

function metaUrl(iso2, level) {
  const iso3 = ISO3_MAP[iso2.toUpperCase()] || iso2.toUpperCase();
  return `https://www.geoboundaries.org/api/current/gbOpen/${iso3}/${level}`;
}

async function downloadJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return res.json();
}

function roundCoord(value, precision) {
  const m = 10 ** precision;
  return Math.round(value * m) / m;
}

function downsampleRing(ring, maxPoints, precision) {
  if (!Array.isArray(ring) || ring.length < 4) return ring;

  const cleaned = ring
    .filter((c) => Array.isArray(c) && c.length >= 2)
    .map(([lon, lat]) => [Number(lon), Number(lat)])
    .filter(
      ([lon, lat]) =>
        Number.isFinite(lon) &&
        Number.isFinite(lat) &&
        lon >= -180 &&
        lon <= 180 &&
        lat >= -90 &&
        lat <= 90
    );

  if (cleaned.length < 4) return ring;

  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  const isClosed =
    Math.abs(first[0] - last[0]) < 1e-12 && Math.abs(first[1] - last[1]) < 1e-12;
  const working = isClosed ? cleaned : [...cleaned, first];

  const finalize = (coords) =>
    coords.map(([lon, lat]) => [roundCoord(lon, precision), roundCoord(lat, precision)]);

  if (working.length <= maxPoints) {
    return finalize(working);
  }

  const step = Math.max(1, Math.floor(working.length / maxPoints));
  const sampled = [];
  for (let i = 0; i < working.length - 1; i += step) sampled.push(working[i]);
  sampled.push(working[working.length - 1]);

  // ensure closed
  const f = sampled[0];
  const l = sampled[sampled.length - 1];
  if (f && l && (f[0] !== l[0] || f[1] !== l[1])) sampled.push([f[0], f[1]]);

  return finalize(sampled);
}

function simplifyGeometry(geom, maxPoints, precision) {
  if (!geom || !geom.type || !geom.coordinates) return geom;
  if (geom.type === 'Polygon') {
    const rings = (geom.coordinates || [])
      .map((r) => downsampleRing(r, maxPoints, precision))
      .filter((r) => Array.isArray(r) && r.length >= 4);
    return { type: 'Polygon', coordinates: rings };
  }
  if (geom.type === 'MultiPolygon') {
    const polys = (geom.coordinates || [])
      .map((poly) =>
        (poly || [])
          .map((r) => downsampleRing(r, maxPoints, precision))
          .filter((r) => Array.isArray(r) && r.length >= 4)
      )
      .filter((poly) => Array.isArray(poly) && poly.length);
    return { type: 'MultiPolygon', coordinates: polys };
  }
  return geom;
}

function minimizeFeature(feature, iso2, maxPoints, precision) {
  const props = feature?.properties || {};
  const name = props.name || props.shapeName || props.NAME_2 || props.NAME || null;
  const id = props.shapeID || props.id || null;
  const geom = simplifyGeometry(feature.geometry, maxPoints, precision);
  if (!geom || !geom.coordinates) return null;
  return {
    type: 'Feature',
    geometry: geom,
    properties: { name, iso2: iso2.toUpperCase(), id }
  };
}

function writePackFiles({ country, level, payload, writeJson }) {
  const code = country.toLowerCase();
  const levelName = level.toLowerCase(); // adm1 / adm2
  const dir = path.join(DEST_DIR, code);
  fs.mkdirSync(dir, { recursive: true });

  const jsonStr = JSON.stringify(payload);
  const gz = zlib.gzipSync(Buffer.from(jsonStr), { level: 9 });

  const gzPath = path.join(dir, `${levelName}.json.gz`);
  fs.writeFileSync(gzPath, gz);

  if (writeJson) {
    const jsonPath = path.join(dir, `${levelName}.json`);
    fs.writeFileSync(jsonPath, jsonStr);
  }

  console.log(`💾 Saved ${country}/${level}: ${gz.length} bytes gz`);
}

async function fetchAndSaveCountry(country, { maxPoints, precision, writeJson }) {
  const code = country.toUpperCase();
  for (const level of LEVELS) {
    console.log(`🌐 Fetching metadata for ${code} ${level}...`);
    const meta = await downloadJson(metaUrl(code, level));
    const gjUrl = meta?.gjDownloadURL;
    if (!gjUrl) throw new Error(`No gjDownloadURL for ${code} ${level}`);

    console.log(`⬇️  Downloading GeoJSON for ${code} ${level}...`);
    const geo = await downloadJson(gjUrl);
    if (!geo?.features) throw new Error(`No features for ${code} ${level}`);

    console.log(
      `🧹 Minimizing ${geo.features.length} features (maxPoints=${maxPoints}, precision=${precision})...`
    );
    const features = geo.features
      .map((f) => minimizeFeature(f, code, maxPoints, precision))
      .filter(Boolean);

    writePackFiles({
      country: code,
      level,
      payload: { type: 'FeatureCollection', features },
      writeJson
    });
  }
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('countries', { type: 'string', default: DEFAULT_COUNTRIES.join(',') })
    .option('maxPoints', { type: 'number', default: 250 })
    .option('precision', { type: 'number', default: 3 })
    .option('writeJson', { type: 'boolean', default: false })
    .parse();

  const list = String(argv.countries)
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  for (const country of list) {
    try {
      await fetchAndSaveCountry(country, {
        maxPoints: argv.maxPoints,
        precision: argv.precision,
        writeJson: argv.writeJson
      });
    } catch (err) {
      console.error(`❌ Failed for ${country}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
