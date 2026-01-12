#!/usr/bin/env node

/**
 * Build OSM place boundary packs (place=city, place=town, place=village)
 * These represent actual city/town boundaries rather than admin divisions
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');
const https = require('https');

const ADM_PACK_DIR = path.join(__dirname, '../../public/adm-packs');
const GEOFABRIK_CACHE_DIR = path.join(__dirname, '../../data/geofabrik');

// Geofabrik download URLs
const GEOFABRIK_BASE = 'https://download.geofabrik.de';
const COUNTRY_MAP = {
  'us': 'north-america/us',
  'ca': 'north-america/canada',
  'gb': 'europe/great-britain',
  'de': 'europe/germany',
  'fr': 'europe/france',
  'nl': 'europe/netherlands',
  'ch': 'europe/switzerland',
  'in': 'asia/india',
  'ar': 'south-america/argentina',
  'co': 'south-america/colombia',
  'gh': 'africa/ghana',
};

function checkOsmiumTool() {
  try {
    execSync('osmium --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function downloadGeofabrikExtract(countryIso2) {
  const countryPath = COUNTRY_MAP[countryIso2.toLowerCase()];
  if (!countryPath) {
    console.error(`  ❌ No Geofabrik extract for ${countryIso2}`);
    return null;
  }
  
  const url = `${GEOFABRIK_BASE}/${countryPath}-latest.osm.pbf`;
  const fileName = `${countryIso2}-latest.osm.pbf`;
  const filePath = path.join(GEOFABRIK_CACHE_DIR, fileName);
  
  if (fs.existsSync(filePath)) {
    console.log(`  ✅ Using cached PBF: ${fileName}`);
    return filePath;
  }
  
  console.log(`  📥 Downloading ${url}...`);
  const file = fs.createWriteStream(filePath);
  
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        https.get(response.headers.location, (redirectResponse) => {
          redirectResponse.pipe(file);
          redirectResponse.on('end', () => {
            console.log(`  ✅ Downloaded: ${fileName}`);
            resolve(filePath);
          });
        }).on('error', reject);
      } else {
        response.pipe(file);
        response.on('end', () => {
          console.log(`  ✅ Downloaded: ${fileName}`);
          resolve(filePath);
        });
      }
    }).on('error', (err) => {
      fs.unlinkSync(filePath);
      reject(err);
    });
  });
}

async function extractPlaceBoundaries(pbfPath, countryIso2, placeType) {
  const outputDir = path.join(ADM_PACK_DIR, countryIso2);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const finalPath = path.join(outputDir, `place-${placeType}-geofabrik.json.gz`);
  
  // Check if already exists
  if (fs.existsSync(finalPath)) {
    console.log(`  ✅ Already exists: place-${placeType}`);
    return true;
  }
  
  console.log(`  🔍 Extracting place=${placeType} with osmium...`);
  
  const tempGeojsonPath = path.join(outputDir, `place-${placeType}-temp.geojson`);
  
  try {
    // Extract place boundaries using osmium-tool
    // Filter for place=city, place=town, place=village, place=suburb
    execSync(`osmium tags-filter ${pbfPath} -o ${tempGeojsonPath} -f geojsonseq place=${placeType}`, {
      stdio: 'inherit'
    });
    
    // Read and convert to GeoJSON FeatureCollection
    const features = [];
    const lines = fs.readFileSync(tempGeojsonPath, 'utf8').split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      try {
        const feature = JSON.parse(line);
        if (feature.type === 'Feature' && feature.geometry) {
          // Ensure it has a name
          if (feature.properties?.name) {
            features.push(feature);
          }
        }
      } catch (e) {
        // Skip invalid JSON lines
      }
    }
    
    const geojson = {
      type: 'FeatureCollection',
      features: features
    };
    
    const compressed = zlib.gzipSync(JSON.stringify(geojson));
    fs.writeFileSync(finalPath, compressed);
    
    // Cleanup
    if (fs.existsSync(tempGeojsonPath)) fs.unlinkSync(tempGeojsonPath);
    
    const stats = fs.statSync(finalPath);
    console.log(`  ✅ Saved: ${features.length} features (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
    return true;
  } catch (error) {
    if (fs.existsSync(tempGeojsonPath)) fs.unlinkSync(tempGeojsonPath);
    throw error;
  }
}

async function buildPlacePack(countryIso2) {
  console.log(`\n🌍 Building place boundary packs for ${countryIso2.toUpperCase()}...`);
  
  const hasOsmium = checkOsmiumTool();
  
  if (!hasOsmium) {
    console.error(`  ❌ osmium-tool required for place boundaries`);
    console.error(`  📝 Install: sudo apt-get install osmium-tool`);
    return;
  }
  
  // Download PBF file
  const pbfPath = await downloadGeofabrikExtract(countryIso2);
  if (!pbfPath) {
    return;
  }
  
  const outputDir = path.join(ADM_PACK_DIR, countryIso2);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Extract place boundaries: city, town, village, suburb
  for (const placeType of ['city', 'town', 'village', 'suburb']) {
    try {
      await extractPlaceBoundaries(pbfPath, countryIso2, placeType);
    } catch (error) {
      console.error(`  ❌ Failed place=${placeType}: ${error.message}`);
    }
  }
}

async function main() {
  const countries = process.argv.slice(2);
  
  if (countries.length === 0) {
    console.log('Usage: node build-place-packs.js <country1> [country2] ...');
    console.log('Example: node build-place-packs.js ca us nl');
    process.exit(1);
  }
  
  console.log('🗺️  Building Place Boundary Packs using Geofabrik data');
  
  for (const country of countries) {
    try {
      await buildPlacePack(country);
    } catch (error) {
      console.error(`❌ Failed ${country}:`, error.message);
    }
  }
  
  console.log('\n✅ Done!');
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { buildPlacePack };
