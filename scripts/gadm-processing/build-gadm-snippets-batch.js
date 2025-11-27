#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(process.env.HOME, 'levante/levante-web-dashboard');
const GADM_DIR = path.join(REPO_ROOT, 'scripts/gadm-processing');
const PROCESSED_DIR = path.join(GADM_DIR, 'gadm_processed');

const COUNTRY_MAPPING = {
  GBR: 'Scotland',
  USA: 'USA',
  CAN: 'Canada',
  COL: 'Colombia',
  IND: 'India',
  ARG: 'Argentina',
  NLD: 'Netherlands',
  GHA: 'Ghana',
  CHE: 'Switzerland',
  DEU: 'Germany'
};

console.log('🔨 Building GADM snippets...\n');

if (!fs.existsSync(PROCESSED_DIR)) {
  console.error(`Error: ${PROCESSED_DIR} not found. Run process_gadm_files.sh first.`);
  process.exit(1);
}

const countries = fs.readdirSync(PROCESSED_DIR)
  .filter(f => fs.statSync(path.join(PROCESSED_DIR, f)).isDirectory());

for (const countryCode of countries) {
  const countryName = COUNTRY_MAPPING[countryCode] || countryCode;
  const countryDir = path.join(PROCESSED_DIR, countryCode);
  
  const levels = fs.readdirSync(countryDir)
    .filter(f => f.startsWith('level') && fs.statSync(path.join(countryDir, f)).isDirectory());
  
  if (levels.length === 0) continue;
  
  const levelDir = path.join(countryDir, levels[0]);
  const level = levels[0].replace('level', '');
  
  const shpFiles = fs.readdirSync(levelDir).filter(f => f.endsWith('.shp'));
  if (shpFiles.length === 0) continue;
  
  const shpPath = path.join(levelDir, shpFiles[0]);
  const outputDir = path.join(countryDir, 'snippets');
  const outputPath = path.join(outputDir, `gadm_${countryCode}_snippets.json`);
  
  console.log(`Processing ${countryName} (${countryCode}) - Level ${level}`);
  
  fs.mkdirSync(outputDir, { recursive: true });
  
  const tempConfig = path.join(countryDir, 'temp_config.json');
  fs.writeFileSync(tempConfig, JSON.stringify({ countries: [countryName] }));
  
  try {
    const buildScript = path.join(REPO_ROOT, 'scripts/build-gadm-snippets.js');
    execSync(
      `node "${buildScript}" -i "${shpPath}" -o "${outputPath}" -c "${tempConfig}"`,
      { stdio: 'inherit' }
    );
    console.log(`   ✓ Created: ${outputPath}\n`);
  } catch (error) {
    console.error(`   ✗ Failed for ${countryCode}\n`);
  } finally {
    fs.unlinkSync(tempConfig);
  }
}

console.log('✅ Snippet generation complete!');
