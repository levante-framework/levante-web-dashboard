#!/usr/bin/env node
/**
 * Build a tiny on-device ADM0 (country) seed dataset.
 *
 * Output:
 *   public/adm0/countries.min.json.gz
 *
 * Data source: Natural Earth (GeoJSON) - admin 0 countries, 110m scale (small/coarse)
 * Strategy:
 * - Keep only { name, iso2, iso3 } props
 * - Round coordinates (default precision=3)
 * - Downsample rings to maxPoints (default 200)
 * - Gzip at level 9
 *
 * Usage:
 *   node scripts/adm/build-adm0.js
 *   node scripts/adm/build-adm0.js --precision=3 --maxPoints=200
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const fetch = globalThis.fetch;
if (typeof fetch !== 'function') {
  throw new Error('This script requires Node.js with global fetch (Node 18+).');
}

const NE_110M_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';

const DEST_DIR = path.join(process.cwd(), 'public', 'adm0');
const DEST_GZ = path.join(DEST_DIR, 'countries.min.json.gz');

const arg = (name) => {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};

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

  if (working.length <= maxPoints) return finalize(working);

  const step = Math.max(1, Math.floor(working.length / maxPoints));
  const sampled = [];
  for (let i = 0; i < working.length - 1; i += step) sampled.push(working[i]);
  sampled.push(working[working.length - 1]);

  const f = sampled[0];
  const l = sampled[sampled.length - 1];
  if (f && l && (f[0] !== l[0] || f[1] !== l[1])) sampled.push([f[0], f[1]]);

  return finalize(sampled);
}

function simplifyGeometry(geom, maxPoints, precision) {
  if (!geom || !geom.type || !geom.coordinates) return null;
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
  return null;
}

function pickProps(props = {}) {
  const name =
    props.ADMIN ||
    props.NAME ||
    props.name ||
    props.SOVEREIGNT ||
    props.BRK_NAME ||
    null;
  const iso2 = props.ISO_A2 || props.iso_a2 || props.ISO2 || null;
  const iso3 = props.ISO_A3 || props.iso_a3 || props.ISO3 || null;
  return {
    name,
    iso2: (iso2 && iso2 !== '-99') ? String(iso2) : null,
    iso3: (iso3 && iso3 !== '-99') ? String(iso3) : null
  };
}

async function downloadJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return res.json();
}

async function main() {
  const precision = arg('precision') != null ? Number(arg('precision')) : 3;
  const maxPoints = arg('maxPoints') != null ? Number(arg('maxPoints')) : 200;

  console.log(`⬇️  Downloading Natural Earth ADM0 (110m)...`);
  const geo = await downloadJson(NE_110M_URL);
  if (!geo || geo.type !== 'FeatureCollection' || !Array.isArray(geo.features)) {
    throw new Error('Unexpected Natural Earth payload');
  }

  console.log(`🧹 Minimizing ${geo.features.length} country features...`);
  const features = geo.features
    .map((f) => {
      const geometry = simplifyGeometry(f.geometry, maxPoints, precision);
      if (!geometry) return null;
      const properties = pickProps(f.properties || {});
      if (!properties.iso2 && !properties.iso3) return null;
      return { type: 'Feature', geometry, properties };
    })
    .filter(Boolean);

  const out = { type: 'FeatureCollection', features };
  const jsonStr = JSON.stringify(out);
  const gz = zlib.gzipSync(Buffer.from(jsonStr), { level: 9 });

  fs.mkdirSync(DEST_DIR, { recursive: true });
  fs.writeFileSync(DEST_GZ, gz);

  console.log(`💾 Wrote ${DEST_GZ}`);
  console.log(`   features: ${features.length}`);
  console.log(`   gz bytes: ${gz.length}`);
}

main().catch((err) => {
  console.error('❌ build-adm0 failed:', err);
  process.exit(1);
});


