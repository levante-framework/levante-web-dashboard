#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(process.env.HOME, 'levante/levante-web-dashboard');
const GADM_DIR = path.join(REPO_ROOT, 'scripts/gadm-processing');
const PROCESSED_DIR = path.join(GADM_DIR, 'gadm_processed');
const OUTPUT_FILE = path.join(GADM_DIR, 'gadm_config.json');

const COUNTRY_NAMES = {
  GBR: 'Scotland',
  USA: 'United States',
  CAN: 'Canada',
  COL: 'Colombia',
  IND: 'India',
  ARG: 'Argentina',
  NLD: 'Netherlands',
  GHA: 'Ghana',
  CHE: 'Switzerland',
  DEU: 'Germany'
};

console.log('⚙️  Generating GADM configuration...\n');

const config = {
  version: '4.1',
  lastUpdated: new Date().toISOString(),
  bucket: 'gs://levante-assets-dev/maps/gadm',
  countries: {}
};

if (!fs.existsSync(PROCESSED_DIR)) {
  console.error(`Error: ${PROCESSED_DIR} not found.`);
  process.exit(1);
}

const countries = fs.readdirSync(PROCESSED_DIR)
  .filter(f => fs.statSync(path.join(PROCESSED_DIR, f)).isDirectory());

for (const code of countries) {
  const countryDir = path.join(PROCESSED_DIR, code);
  
  const levels = fs.readdirSync(countryDir)
    .filter(f => f.startsWith('level') && fs.statSync(path.join(countryDir, f)).isDirectory());
  
  if (levels.length === 0) continue;
  
  const level = parseInt(levels[0].replace('level', ''));
  const levelDir = path.join(countryDir, levels[0]);
  
  const shpFiles = fs.readdirSync(levelDir).filter(f => f.endsWith('.shp'));
  if (shpFiles.length === 0) continue;
  
  const snippetsDir = path.join(countryDir, 'snippets');
  const hasSnippets = fs.existsSync(snippetsDir) && 
    fs.readdirSync(snippetsDir).some(f => f.endsWith('.json'));
  
  config.countries[code] = {
    name: COUNTRY_NAMES[code] || code,
    level,
    shapefile: `${code}/level${level}/gadm41_${code}_${level}.zip`,
    snippets: hasSnippets ? `${code}/snippets/gadm_${code}_snippets.json` : null,
    nameField: `NAME_${level}`,
    admin1Field: level > 1 ? 'NAME_1' : null,
    countryField: 'NAME_0'
  };
  
  console.log(`✓ ${COUNTRY_NAMES[code] || code}: Level ${level}`);
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(config, null, 2));

console.log(`\n✅ Configuration saved to: ${OUTPUT_FILE}`);
console.log(`   Countries configured: ${Object.keys(config.countries).length}`);
