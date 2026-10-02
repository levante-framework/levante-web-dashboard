#!/usr/bin/env node
/**
 * Refresh country boundary packs and GeoNames postal codes.
 *
 * Boundary packs are written by scripts/adm/build-packs.js to
 * public/adm-packs/<iso2>/adm{1,2,3,4}.json.gz.
 * Postal codes are downloaded from GeoNames into data/geonames/postal/<CC>.txt.
 *
 * The country list is saved in data/country-refresh-manifest.json.
 * Run the script again with no arguments to update that same list.
 *
 * Usage:
 *   node scripts/update-country-and-postal.js
 *   node scripts/update-country-and-postal.js --countries=US,GH
 *   node scripts/update-country-and-postal.js --all
 *   node scripts/update-country-and-postal.js --packs-only
 *   node scripts/update-country-and-postal.js --postal-only
 *   node scripts/update-country-and-postal.js --skip-index
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const unzipper = require('unzipper');

const ROOT = process.cwd();
const DEFAULT_COUNTRIES = ['US', 'DE', 'GB', 'NL', 'CA', 'CO', 'IN', 'AR', 'GH', 'CH'];
const MANIFEST_PATH = path.join(ROOT, 'data', 'country-refresh-manifest.json');
const COUNTRY_INFO_PATH = path.join(ROOT, 'data', 'geonames', 'countryInfo.txt');
const POSTAL_DIR = path.join(ROOT, 'data', 'geonames', 'postal');
const PACK_DIR = path.join(ROOT, 'public', 'adm-packs');
const INDEX_SCRIPT = path.join(ROOT, 'scripts', 'geocoder', 'build-country-autocomplete-index.js');
const PACK_SCRIPT = path.join(ROOT, 'scripts', 'adm', 'build-packs.js');

const COUNTRY_INFO_URL = 'https://download.geonames.org/export/dump/countryInfo.txt';
const POSTAL_INDEX_URL = 'https://download.geonames.org/export/zip/';
const POSTAL_ZIP_URL = 'https://download.geonames.org/export/zip/';
const GB_INDEX_URL = 'https://www.geoboundaries.org/api/current/gbOpen/';

const fetchImpl = globalThis.fetch;
if (typeof fetchImpl !== 'function') {
  throw new Error('This script requires Node.js with global fetch (Node 18+).');
}

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((item) => item.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseCountryList(value) {
  return String(value || '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => /^[A-Z]{2}$/.test(code));
}

function readManifestCountries() {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const countries = parseCountryList((manifest.countries || []).join(','));
    return countries.length ? countries : null;
  } catch (err) {
    console.warn(`Could not read ${MANIFEST_PATH}: ${err.message}`);
    return null;
  }
}

function readIndexAllowlist() {
  const src = fs.readFileSync(INDEX_SCRIPT, 'utf8');
  const match = src.match(/const DEFAULT_COUNTRIES = \[([^\]]+)\]/);
  if (!match) return DEFAULT_COUNTRIES.slice();
  return [...match[1].matchAll(/'([A-Z]{2})'/g)].map((item) => item[1]);
}

async function fetchText(url) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'levante-web-dashboard country-refresh' }
  });
  if (!res.ok) {
    throw new Error(`${url} returned HTTP ${res.status}`);
  }
  return res.text();
}

function saveCountryInfo(text) {
  fs.mkdirSync(path.dirname(COUNTRY_INFO_PATH), { recursive: true });
  fs.writeFileSync(COUNTRY_INFO_PATH, text);
}

function isoMapsFromCountryInfo(text) {
  const iso2ToIso3 = {};
  const iso3ToIso2 = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [iso2, iso3] = line.split('\t');
    if (!iso2 || !iso3 || iso2.length !== 2 || iso3.length !== 3) continue;
    iso2ToIso3[iso2.toUpperCase()] = iso3.toUpperCase();
    iso3ToIso2[iso3.toUpperCase()] = iso2.toUpperCase();
  }
  return { iso2ToIso3, iso3ToIso2 };
}

async function ensureCountryInfo() {
  const text = await fetchText(COUNTRY_INFO_URL);
  saveCountryInfo(text);
  return isoMapsFromCountryInfo(text);
}

async function discoverAvailableCountries() {
  const { iso3ToIso2 } = await ensureCountryInfo();
  const [zipHtml, gbHtml] = await Promise.all([
    fetchText(POSTAL_INDEX_URL),
    fetchText(GB_INDEX_URL)
  ]);
  const postal = new Set([...zipHtml.matchAll(/href="([A-Z]{2})\.zip"/g)].map((match) => match[1]));
  const packs = new Set();
  for (const match of gbHtml.matchAll(/href="([A-Z]{3})\/"/g)) {
    const iso2 = iso3ToIso2[match[1]];
    if (iso2) packs.add(iso2);
  }
  const countries = [...new Set([...postal, ...packs])].sort();
  return { countries, postal, packs };
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

async function downloadPostal(countryCode) {
  const url = `${POSTAL_ZIP_URL}${countryCode}.zip`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'levante-web-dashboard country-refresh' }
  });
  if (res.status === 404) {
    return { status: 'missing' };
  }
  if (!res.ok) {
    return { status: 'error', error: `HTTP ${res.status}` };
  }
  const directory = await unzipper.Open.buffer(Buffer.from(await res.arrayBuffer()));
  const wanted = `${countryCode}.TXT`;
  const entry = (directory.files || []).find((file) => {
    return path.basename(String(file.path || '')).toUpperCase() === wanted;
  });
  if (!entry) {
    return { status: 'error', error: 'zip did not contain a country text file' };
  }
  const body = await entry.buffer();
  fs.mkdirSync(POSTAL_DIR, { recursive: true });
  const dest = path.join(POSTAL_DIR, `${countryCode}.txt`);
  fs.writeFileSync(dest, body);
  return { status: 'ok', bytes: body.length, file: path.relative(ROOT, dest) };
}

function packStatus(countryCode) {
  const filePath = path.join(PACK_DIR, countryCode.toLowerCase(), 'adm1.json.gz');
  if (!fs.existsSync(filePath)) return { status: 'missing' };
  const stat = fs.statSync(filePath);
  return {
    status: 'ok',
    bytes: stat.size,
    file: path.relative(ROOT, filePath),
    mtime: stat.mtime.toISOString()
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const packsOnly = hasFlag('packs-only');
  const postalOnly = hasFlag('postal-only');
  const skipIndex = hasFlag('skip-index');
  if (packsOnly && postalOnly) {
    throw new Error('Use only one of --packs-only and --postal-only.');
  }

  let countries;
  let source;
  if (hasFlag('all')) {
    const discovered = await discoverAvailableCountries();
    countries = discovered.countries;
    source = 'all';
    console.log(`Discovered ${countries.length} countries with a boundary pack, a postal file, or both.`);
  } else if (arg('countries')) {
    countries = parseCountryList(arg('countries'));
    source = 'countries';
    if (!countries.length) throw new Error('--countries did not include any ISO2 codes.');
  } else {
    countries = readManifestCountries() || DEFAULT_COUNTRIES.slice();
    source = fs.existsSync(MANIFEST_PATH) ? 'manifest' : 'default';
  }

  console.log(`Refreshing ${countries.length} countries (${source}).`);

  const manifest = {
    updatedAt: new Date().toISOString(),
    source,
    countries,
    postal: {},
    packs: {},
    index: null
  };

  if (postalOnly && fs.existsSync(MANIFEST_PATH)) {
    try {
      const previous = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
      if (previous.packs) manifest.packs = previous.packs;
    } catch (err) {
      console.warn(`Could not keep previous pack results: ${err.message}`);
    }
  }

  if (!postalOnly) {
    if (!hasFlag('all')) await ensureCountryInfo();
    console.log('Building country boundary packs...');
    const ok = runNode(PACK_SCRIPT, [`--countries=${countries.join(',')}`]);
    for (const code of countries) {
      const status = packStatus(code);
      if (!ok && status.status === 'ok') status.note = 'pack build reported an error';
      manifest.packs[code] = status;
    }
  }

  if (!packsOnly) {
    console.log('Downloading postal codes...');
    for (const code of countries) {
      let row;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          row = await downloadPostal(code);
        } catch (err) {
          row = { status: 'error', error: err.message };
        }
        const retryable = row.status === 'error' && /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|HTTP 429|HTTP 5/i.test(row.error || '');
        if (!retryable || attempt === 3) break;
        console.warn(`  ${code} ${row.error}, retrying`);
        await sleep(1000 * attempt);
      }
      manifest.postal[code] = row;
      if (row.status === 'ok') console.log(`  ${code} ${row.bytes} bytes`);
      else if (row.status === 'missing') console.log(`  ${code} no GeoNames postal file`);
      else console.warn(`  ${code} ${row.error}`);
      await sleep(200);
    }
  }

  if (!packsOnly && !skipIndex) {
    const allowlist = new Set(readIndexAllowlist());
    const indexCountries = countries.filter((code) => allowlist.has(code));
    const skipped = countries.filter((code) => !allowlist.has(code));
    if (indexCountries.length) {
      console.log(`Rebuilding autocomplete index for ${indexCountries.join(',')}...`);
      const ok = runNode(INDEX_SCRIPT, [`--countries=${indexCountries.join(',')}`]);
      manifest.index = { status: ok ? 'ok' : 'error', countries: indexCountries };
    } else {
      manifest.index = { status: 'skipped', countries: [] };
    }
    if (skipped.length) {
      console.log(`Autocomplete index still allowlists only its current countries. Skipped: ${skipped.join(',')}.`);
    }
  }

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${path.relative(ROOT, MANIFEST_PATH)}`);

  const postalErrors = Object.values(manifest.postal).filter((row) => row.status === 'error').length;
  const packMissing = Object.values(manifest.packs).filter((row) => row.status === 'missing').length;
  if (postalErrors || manifest.index?.status === 'error') process.exitCode = 1;
  if (packMissing) {
    console.log(`${packMissing} countries have no ADM1 pack after the build.`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
