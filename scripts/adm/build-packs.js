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
const fetch = globalThis.fetch;

if (typeof fetch !== 'function') {
  throw new Error('This script requires Node.js with global fetch (Node 18+).');
}

const DEFAULT_COUNTRIES = ['CO', 'DE', 'US'];
// Note: ADM5 can be extremely large for some countries (e.g., India). We exclude it by default.
const LEVELS = ['ADM1', 'ADM2', 'ADM3', 'ADM4'];

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function downloadJson(url, label = 'download') {
  const maxRetries = 4;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text}`);
      }
      // Use arrayBuffer + JSON.parse to avoid some streaming edge-cases.
      const buf = await res.arrayBuffer();
      return JSON.parse(Buffer.from(buf).toString('utf8'));
    } catch (err) {
      const msg = err?.message || String(err);
      const retryable = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket/i.test(msg);
      if (!retryable || attempt === maxRetries) {
        throw new Error(`${label}: ${msg}`);
      }
      const backoff = 800 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
      console.warn(`  ⚠️  ${label}: attempt ${attempt} failed (${msg}). Retrying in ${backoff}ms...`);
      await sleep(backoff);
    }
  }
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
    try {
      console.log(`🌐 Fetching metadata for ${code} ${level}...`);
      const meta = await downloadJson(metaUrl(code, level));
      const gjUrl = meta?.simplifiedGeometryGeoJSON || meta?.gjDownloadURL;
      if (!gjUrl) throw new Error(`No GeoJSON download URL for ${code} ${level}`);
      if (meta?.simplifiedGeometryGeoJSON) {
        console.log(`   ↳ using simplifiedGeometryGeoJSON`);
      }

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
    } catch (err) {
      // Many countries do not have ADM3+ in GeoBoundaries. Treat as optional.
      const upper = String(level).toUpperCase();
      const isOptional = /^ADM[3-9]$/.test(upper);
      const msg = err?.message || String(err);
      if (isOptional && /HTTP 404/i.test(msg)) {
        console.warn(`  ⚠️  ${code} ${level} unavailable (404). Skipping.`);
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  const arg = (name) => {
    const prefix = `--${name}=`;
    const hit = process.argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };
  const hasFlag = (name) => process.argv.includes(`--${name}`);

  const countriesArg = arg('countries');
  const maxPointsArg = arg('maxPoints');
  const precisionArg = arg('precision');
  const writeJson = hasFlag('writeJson');

  const list = String(countriesArg || DEFAULT_COUNTRIES.join(','))
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  for (const country of list) {
    try {
      await fetchAndSaveCountry(country, {
        maxPoints: maxPointsArg != null ? Number(maxPointsArg) : 250,
        precision: precisionArg != null ? Number(precisionArg) : 3,
        writeJson
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
