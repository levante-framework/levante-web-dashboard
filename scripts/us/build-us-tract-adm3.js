#!/usr/bin/env node
/**
 * Build a US-only "ADM3-like" dataset using Census TIGER/Line Census Tracts.
 *
 * Why tracts:
 * - Consistent nationwide coverage
 * - Neighborhood-ish granularity in cities; still meaningful in rural areas
 *
 * Output (per-state to keep downloads reasonable):
 *   public/adm-packs/us/adm3/<state>.json.gz
 *
 * Usage:
 *   node scripts/us/build-us-tract-adm3.js --states=CA,OR,FL,NY,IL --year=2024 --precision=3 --maxPoints=250
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const unzipper = require('unzipper');
const shapefile = require('shapefile');

const YEAR_DEFAULT = 2024;
const PRECISION_DEFAULT = 3;
const MAX_POINTS_DEFAULT = 250;

const STATE_FIPS = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09',
  DE: '10', DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17',
  IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24',
  MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31',
  NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38',
  OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46',
  TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54',
  WI: '55', WY: '56',
  PR: '72'
};

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

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', reject);
  });
}

async function unzip(zipPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: outDir })).promise();
}

async function buildState(stateAbbr, year, precision, maxPoints) {
  const abbr = String(stateAbbr || '').trim().toUpperCase();
  const fips = STATE_FIPS[abbr];
  if (!fips) throw new Error(`Unknown state: ${abbr}`);

  const base = `https://www2.census.gov/geo/tiger/TIGER${year}/TRACT`;
  const zipName = `tl_${year}_${fips}_tract.zip`;
  const url = `${base}/${zipName}`;

  const cacheDir = path.join(process.cwd(), 'data', 'tiger', `TIGER${year}`, 'TRACT');
  const zipPath = path.join(cacheDir, zipName);
  const extractDir = path.join(cacheDir, `tl_${year}_${fips}_tract`);

  if (!fs.existsSync(zipPath)) {
    console.log(`⬇️  Downloading ${abbr} tracts (${year})...`);
    await download(url, zipPath);
  } else {
    console.log(`📦 Using cached ${abbr} zip`);
  }

  if (!fs.existsSync(extractDir) || !fs.readdirSync(extractDir).some((f) => f.endsWith('.shp'))) {
    console.log(`🧩 Extracting ${abbr}...`);
    await unzip(zipPath, extractDir);
  }

  const shp = path.join(extractDir, `tl_${year}_${fips}_tract.shp`);
  const dbf = path.join(extractDir, `tl_${year}_${fips}_tract.dbf`);
  if (!fs.existsSync(shp) || !fs.existsSync(dbf)) {
    throw new Error(`Missing shp/dbf after unzip for ${abbr}`);
  }

  console.log(`🧹 Reading + minimizing ${abbr}...`);
  const features = [];
  const source = await shapefile.open(shp, dbf);
  while (true) {
    const res = await source.read();
    if (res.done) break;
    const geom = simplifyGeometry(res.value.geometry, maxPoints, precision);
    if (!geom) continue;
    const p = res.value.properties || {};
    features.push({
      type: 'Feature',
      geometry: geom,
      properties: {
        name: p.NAMELSAD || p.NAME || null,          // e.g., "Census Tract 1.02"
        geoid: p.GEOID || null,                      // unique ID
        state: abbr,
        statefp: p.STATEFP || fips,
        countyfp: p.COUNTYFP || null
      }
    });
  }

  const fc = { type: 'FeatureCollection', features };
  const jsonStr = JSON.stringify(fc);
  const gz = zlib.gzipSync(Buffer.from(jsonStr), { level: 9 });

  const outDir = path.join(process.cwd(), 'public', 'adm-packs', 'us', 'adm3');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${abbr.toLowerCase()}.json.gz`);
  fs.writeFileSync(outPath, gz);
  console.log(`💾 Wrote ${outPath} (${gz.length} bytes gz, ${features.length} tracts)`);
}

async function main() {
  const statesArg = arg('states') || 'CA,OR,FL,NY,IL';
  const year = Number(arg('year') || YEAR_DEFAULT);
  const precision = Number(arg('precision') || PRECISION_DEFAULT);
  const maxPoints = Number(arg('maxPoints') || MAX_POINTS_DEFAULT);

  const states = statesArg
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  for (const st of states) {
    try {
      await buildState(st, year, precision, maxPoints);
    } catch (err) {
      console.error(`❌ Failed ${st}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


