#!/usr/bin/env node

/**
 * Build compact country-scoped autocomplete indexes for Locate Me.
 *
 * Output:
 *   public/geocoder-index/meta.json
 *   public/geocoder-index/{CC}.lite.json.gz
 *   public/geocoder-index/{CC}.full.json.gz
 *
 * Usage:
 *   node scripts/geocoder/build-country-autocomplete-index.js
 *   node scripts/geocoder/build-country-autocomplete-index.js --countries=US,DE,GB
 *   node scripts/geocoder/build-country-autocomplete-index.js --version=2026-01-27
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const DEFAULT_COUNTRIES = ['US', 'DE', 'GB', 'NL', 'CA', 'CO', 'IN', 'AR', 'GH', 'CH'];
const PREFIX_MIN = 2;
const PREFIX_MAX = 5;
const MAX_IDS_PER_PREFIX = 180;
const LITE_LIMIT = 2500;

const INPUT_JSON = path.join(process.cwd(), 'data', 'geocoder', 'cities.min.json');
const INPUT_GZ = path.join(process.cwd(), 'data', 'geocoder', 'cities.min.json.gz');
const POSTAL_DIR = path.join(process.cwd(), 'data', 'geonames', 'postal');
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'geocoder-index');
const META_PATH = path.join(OUTPUT_DIR, 'meta.json');

function parseArgs(argv) {
  const out = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const [k, v] = raw.slice(2).split('=');
    out[k] = v === undefined ? true : v;
  }
  return out;
}

function readCitiesDataset() {
  if (fs.existsSync(INPUT_GZ)) {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(INPUT_GZ)).toString('utf8'));
  }
  if (fs.existsSync(INPUT_JSON)) {
    return JSON.parse(fs.readFileSync(INPUT_JSON, 'utf8'));
  }
  throw new Error(`Missing cities dataset. Expected ${INPUT_GZ} or ${INPUT_JSON}`);
}

function readPostalRowsForCountry(countryCode) {
  const cc = String(countryCode || '').trim().toUpperCase();
  if (!cc) return [];
  const filePath = path.join(POSTAL_DIR, `${cc}.txt`);
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 12) continue;
    const [
      rowCountry,
      postalCode,
      placeName,
      adminName1,
      adminCode1,
      _adminName2,
      _adminCode2,
      _adminName3,
      _adminCode3,
      lat,
      lon
    ] = parts;
    if (String(rowCountry || '').toUpperCase() !== cc) continue;
    if (!placeName || !postalCode) continue;
    const latNum = Number(lat);
    const lonNum = Number(lon);
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) continue;
    rows.push({
      country: cc,
      name: String(placeName).trim(),
      ascii: String(placeName).trim(),
      admin1: String(adminName1 || adminCode1 || '').trim(),
      admin1Code: String(adminCode1 || '').trim(),
      lat: latNum,
      lon: lonNum,
      population: 0,
      postal: String(postalCode || '').trim(),
      source: 'postal'
    });
  }
  return rows;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePostal(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function tokenizeName(nameNorm) {
  const tokens = new Set();
  if (!nameNorm) return tokens;
  tokens.add(nameNorm);
  const noSpace = nameNorm.replace(/\s+/g, '');
  if (noSpace.length >= PREFIX_MIN) tokens.add(noSpace);
  nameNorm.split(' ').forEach((token) => {
    if (token.length >= PREFIX_MIN) tokens.add(token);
  });
  return tokens;
}

function addPrefix(prefixMap, prefix, id) {
  if (!prefix || prefix.length < PREFIX_MIN) return;
  if (!prefixMap[prefix]) prefixMap[prefix] = [];
  const arr = prefixMap[prefix];
  if (arr.length >= MAX_IDS_PER_PREFIX) return;
  if (arr[arr.length - 1] !== id && !arr.includes(id)) {
    arr.push(id);
  }
}

function addTokenPrefixes(prefixMap, token, id) {
  for (let i = PREFIX_MIN; i <= Math.min(PREFIX_MAX, token.length); i += 1) {
    addPrefix(prefixMap, token.slice(0, i), id);
  }
}

function dedupeCountryRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const name = String(row.name || row.ascii || '').trim();
    if (!name) continue;
    const admin1 = String(row.admin1 || '').trim();
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const postalNorm = normalizePostal(row.postal || '');
    const key = `${normalizeText(name)}|${normalizeText(admin1)}|${postalNorm}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    const existing = map.get(key);
    if (!existing || Number(row.population || 0) > Number(existing.population || 0)) {
      map.set(key, row);
    }
  }
  return Array.from(map.values());
}

function toEntryTuple(row) {
  const name = String(row.name || row.ascii || '').trim();
  const admin1 = String(row.admin1 || '').trim();
  const nameNorm = normalizeText(row.ascii || name);
  const postalNorm = normalizePostal(row.postal || '');
  return [
    nameNorm, // 0
    postalNorm, // 1
    name, // 2
    admin1, // 3
    Math.round(Number(row.lat) * 1e5) / 1e5, // 4
    Math.round(Number(row.lon) * 1e5) / 1e5, // 5
    Number(row.population) || 0 // 6
  ];
}

function buildPrefixMap(entries) {
  const prefix = {};
  entries.forEach((entry, id) => {
    const nameNorm = entry[0];
    const postalNorm = entry[1];
    const nameTokens = tokenizeName(nameNorm);
    nameTokens.forEach((token) => addTokenPrefixes(prefix, token, id));
    if (postalNorm && postalNorm.length >= PREFIX_MIN) {
      for (let i = PREFIX_MIN; i <= Math.min(PREFIX_MAX, postalNorm.length); i += 1) {
        addPrefix(prefix, postalNorm.slice(0, i).toLowerCase(), id);
      }
    }
  });
  return prefix;
}

function compressJson(obj) {
  const json = JSON.stringify(obj);
  return zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
}

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeGzipJson(outPath, obj) {
  const gz = compressJson(obj);
  fs.writeFileSync(outPath, gz);
  return {
    bytes: gz.length,
    sha256: hashBuffer(gz)
  };
}

function buildForCountry(countryCode, rows, version) {
  const postalRows = readPostalRowsForCountry(countryCode);
  const admin1NameByCode = new Map();
  postalRows.forEach((row) => {
    const code = String(row.admin1Code || '').trim();
    const name = String(row.admin1 || '').trim();
    if (code && name && !admin1NameByCode.has(code)) {
      admin1NameByCode.set(code, name);
    }
  });

  const normalizedCityRows = rows.map((row) => {
    const next = { ...row };
    const admin1 = String(next.admin1 || '').trim();
    if (/^[0-9A-Za-z.\-_]+$/.test(admin1) && admin1NameByCode.has(admin1)) {
      next.admin1 = admin1NameByCode.get(admin1);
    }
    return next;
  });

  const countryRows = dedupeCountryRows(normalizedCityRows.concat(postalRows))
    .sort((a, b) => {
      const popDiff = (Number(b.population) || 0) - (Number(a.population) || 0);
      if (popDiff !== 0) return popDiff;
      const nameA = String(a.name || '').toLowerCase();
      const nameB = String(b.name || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });

  const fullEntries = countryRows.map(toEntryTuple);
  const liteEntries = fullEntries.slice(0, Math.min(LITE_LIMIT, fullEntries.length));

  const full = {
    version,
    country: countryCode,
    tier: 'full',
    entries: fullEntries,
    prefix: buildPrefixMap(fullEntries)
  };
  const lite = {
    version,
    country: countryCode,
    tier: 'lite',
    entries: liteEntries,
    prefix: buildPrefixMap(liteEntries)
  };

  const fullPath = path.join(OUTPUT_DIR, `${countryCode}.full.json.gz`);
  const litePath = path.join(OUTPUT_DIR, `${countryCode}.lite.json.gz`);
  const fullStats = writeGzipJson(fullPath, full);
  const liteStats = writeGzipJson(litePath, lite);

  return {
    country: countryCode,
    totalEntries: fullEntries.length,
    liteEntries: liteEntries.length,
    postalEntries: postalRows.length,
    files: {
      full: {
        file: `${countryCode}.full.json.gz`,
        bytes: fullStats.bytes,
        sha256: fullStats.sha256
      },
      lite: {
        file: `${countryCode}.lite.json.gz`,
        bytes: liteStats.bytes,
        sha256: liteStats.sha256
      }
    }
  };
}

function main() {
  const args = parseArgs(process.argv);
  const version = String(args.version || new Date().toISOString().slice(0, 10));
  const countries = String(args.countries || DEFAULT_COUNTRIES.join(','))
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);

  const supported = new Set(DEFAULT_COUNTRIES);
  const invalid = countries.filter((c) => !supported.has(c));
  if (invalid.length) {
    throw new Error(`Unsupported country codes: ${invalid.join(', ')}. Supported: ${DEFAULT_COUNTRIES.join(', ')}`);
  }

  const rows = readCitiesDataset();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Cities dataset is empty or invalid.');
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const perCountryRows = new Map();
  for (const row of rows) {
    const cc = String(row.country || '').toUpperCase();
    if (!cc || !countries.includes(cc)) continue;
    if (!perCountryRows.has(cc)) perCountryRows.set(cc, []);
    perCountryRows.get(cc).push(row);
  }

  const generatedAt = new Date().toISOString();
  const countryMeta = {};
  for (const cc of countries) {
    const group = perCountryRows.get(cc) || [];
    if (!group.length) {
      console.warn(`⚠️ No rows found for ${cc}; skipping`);
      continue;
    }
    console.log(`➡️ Building autocomplete index for ${cc} (${group.length.toLocaleString()} rows)...`);
    countryMeta[cc] = buildForCountry(cc, group, version);
  }

  const meta = {
    version,
    generatedAt,
    supportedCountries: countries,
    source: 'data/geocoder/cities.min.json(.gz)',
    notes: [
      'Postal prefixes are included when source rows contain a postal field.',
      'Current GeoNames cities dataset is location-name focused; postal coverage may be limited.'
    ],
    countries: countryMeta
  };
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  console.log(`✅ Wrote ${META_PATH}`);
}

main();
