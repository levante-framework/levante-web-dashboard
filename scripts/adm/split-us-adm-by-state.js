#!/usr/bin/env node

/**
 * Split US ADM6-10 packs by state
 * 
 * This script takes the large US ADM6-10 packs and splits them into state-specific
 * packs (similar to how ADM3 is already split). This avoids Node.js string size limits.
 * 
 * Usage:
 *   node scripts/adm/split-us-adm-by-state.js [adm6|adm7|adm8|adm9|adm10]
 * 
 * If no level is specified, processes all levels (6-10).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Storage } = require('@google-cloud/storage');

const ADM_PACK_DIR = path.join(process.cwd(), 'public', 'adm-packs');
const BOUNDARY_PACKS_BUCKET = process.env.BOUNDARY_PACKS_BUCKET || 'levante-assets-draft';
const BOUNDARY_PACKS_PREFIX = process.env.BOUNDARY_PACKS_PREFIX || 'maps/boundaries';

// US state abbreviations
const US_STATES = ['al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'dc', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy'];

// Map state names to abbreviations
const STATE_NAME_TO_ABBR = {
  'alabama': 'al', 'alaska': 'ak', 'arizona': 'az', 'arkansas': 'ar',
  'california': 'ca', 'colorado': 'co', 'connecticut': 'ct', 'delaware': 'de',
  'district of columbia': 'dc', 'florida': 'fl', 'georgia': 'ga', 'hawaii': 'hi',
  'idaho': 'id', 'illinois': 'il', 'indiana': 'in', 'iowa': 'ia',
  'kansas': 'ks', 'kentucky': 'ky', 'louisiana': 'la', 'maine': 'me',
  'maryland': 'md', 'massachusetts': 'ma', 'michigan': 'mi', 'minnesota': 'mn',
  'mississippi': 'ms', 'missouri': 'mo', 'montana': 'mt', 'nebraska': 'ne',
  'nevada': 'nv', 'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm',
  'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd', 'ohio': 'oh',
  'oklahoma': 'ok', 'oregon': 'or', 'pennsylvania': 'pa', 'rhode island': 'ri',
  'south carolina': 'sc', 'south dakota': 'sd', 'tennessee': 'tn', 'texas': 'tx',
  'utah': 'ut', 'vermont': 'vt', 'virginia': 'va', 'washington': 'wa',
  'west virginia': 'wv', 'wisconsin': 'wi', 'wyoming': 'wy'
};

// Point-in-polygon check (ray casting algorithm)
function pointInPolygon(pt, geom) {
  if (!geom) return false;
  const [lon, lat] = pt;
  
  const polys = geom.type === 'Polygon' 
    ? [geom.coordinates]
    : geom.type === 'MultiPolygon'
    ? geom.coordinates
    : [];
  
  if (!polys.length) return false;
  
  for (const poly of polys) {
    const ring = poly[0]; // Outer ring
    if (!ring || ring.length < 3) continue;
    
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersect = (yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

// Get centroid of a feature
function getCentroid(feature) {
  if (!feature.geometry) return null;
  
  const coords = feature.geometry.coordinates;
  if (feature.geometry.type === 'Polygon') {
    const ring = coords[0];
    let sumLat = 0, sumLon = 0, count = 0;
    for (const [lon, lat] of ring) {
      sumLat += lat;
      sumLon += lon;
      count++;
    }
    return count > 0 ? [sumLon / count, sumLat / count] : null;
  } else if (feature.geometry.type === 'MultiPolygon') {
    let sumLat = 0, sumLon = 0, count = 0;
    for (const poly of coords) {
      const ring = poly[0];
      for (const [lon, lat] of ring) {
        sumLat += lat;
        sumLon += lon;
        count++;
      }
    }
    return count > 0 ? [sumLon / count, sumLat / count] : null;
  }
  return null;
}

async function loadAdm1Pack() {
  const filePath = path.join(ADM_PACK_DIR, 'us', 'adm1.json.gz');
  if (!fs.existsSync(filePath)) {
    throw new Error(`ADM1 pack not found: ${filePath}`);
  }
  
  const raw = zlib.gunzipSync(fs.readFileSync(filePath));
  return JSON.parse(raw.toString());
}

async function loadAdmPackFromGCS(level) {
  const storage = new Storage();
  const bucket = storage.bucket(BOUNDARY_PACKS_BUCKET);
  const remotePath = `${BOUNDARY_PACKS_PREFIX}/us/adm${level}-geofabrik.json.gz`;
  
  try {
    const [exists] = await bucket.file(remotePath).exists();
    if (!exists) return null;
    
    const [file] = await bucket.file(remotePath).download();
    const decompressed = zlib.gunzipSync(file);
    const sizeMB = decompressed.length / (1024 * 1024);
    
    if (sizeMB > 400) {
      console.warn(`  ⚠️  GCS file too large (${sizeMB.toFixed(1)}MB) - will try to process in chunks`);
      // For very large files, we'll need to stream process
      // For now, return null and use local file
      return null;
    }
    
    return JSON.parse(decompressed.toString('utf8'));
  } catch (error) {
    console.warn(`  ⚠️  Failed to load from GCS: ${error.message}`);
    return null;
  }
}

async function splitByState(level) {
  console.log(`\n🔨 Splitting ADM${level} by state...`);
  
  // Load ADM1 (states) pack
  console.log('  📦 Loading ADM1 (states) pack...');
  const adm1Pack = await loadAdm1Pack();
  console.log(`  ✅ Loaded ${adm1Pack.features.length} states`);
  
  // Create state lookup map
  const stateMap = new Map();
  for (const feature of adm1Pack.features) {
    // Try various property names for state abbreviation
    let stateAbbr = feature.properties?.iso || 
                    feature.properties?.iso_3166_2?.split('-')[1]?.toLowerCase() ||
                    feature.properties?.iso_3166_2?.toLowerCase() ||
                    feature.properties?.GID_1?.split('_')[1]?.toLowerCase();
    
    // If not found, try mapping from state name
    if (!stateAbbr && feature.properties?.name) {
      const stateName = feature.properties.name.toLowerCase().trim();
      stateAbbr = STATE_NAME_TO_ABBR[stateName];
    }
    
    if (stateAbbr) {
      const normalized = stateAbbr.toLowerCase();
      if (US_STATES.includes(normalized)) {
        stateMap.set(normalized, feature);
      }
    }
  }
  console.log(`  ✅ Mapped ${stateMap.size} states`);
  
  if (stateMap.size === 0) {
    console.warn(`  ⚠️  No states mapped! Checking first feature properties:`);
    if (adm1Pack.features.length > 0) {
      console.log(`  Sample properties:`, Object.keys(adm1Pack.features[0].properties || {}));
      console.log(`  Sample name:`, adm1Pack.features[0].properties?.name);
    }
  }
  
  // Load ADM pack (try GCS first, then local)
  console.log(`  📦 Loading ADM${level} pack...`);
  let admPack = await loadAdmPackFromGCS(level);
  
  if (!admPack) {
    const filePath = path.join(ADM_PACK_DIR, 'us', `adm${level}-geofabrik.json.gz`);
    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠️  ADM${level} pack not found: ${filePath}`);
      return;
    }
    
    console.log(`  📦 Loading from local file...`);
    const stats = fs.statSync(filePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    console.log(`  📊 File size: ${fileSizeMB.toFixed(1)}MB compressed`);
    
    try {
      const raw = zlib.gunzipSync(fs.readFileSync(filePath));
      const uncompressedMB = raw.length / (1024 * 1024);
      console.log(`  📊 Uncompressed size: ${uncompressedMB.toFixed(1)}MB`);
      
      if (uncompressedMB > 400) {
        console.warn(`  ⚠️  File is very large. Will try to load anyway...`);
        // For now, we'll try to load it anyway and see if it works
        // If it fails, we'll need to implement streaming JSON parsing
      }
      
      admPack = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      if (error.message.includes('string longer than') || error.message.includes('ERR_STRING_TOO_LONG')) {
        const raw = zlib.gunzipSync(fs.readFileSync(filePath));
        const uncompressedMB = raw.length / (1024 * 1024);
        console.error(`  ❌ File too large to load directly (${uncompressedMB.toFixed(1)}MB)`);
        console.error(`  💡 Consider using GCS or implementing streaming JSON parsing`);
        return;
      }
      throw error;
    }
  }
  
  console.log(`  ✅ Loaded ${admPack.features.length} ADM${level} features`);
  
  // Create output directory
  const outputDir = path.join(ADM_PACK_DIR, 'us', `adm${level}`);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Group features by state
  const stateFeatures = new Map();
  for (const stateAbbr of US_STATES) {
    stateFeatures.set(stateAbbr, []);
  }
  
  console.log(`  🔍 Assigning features to states...`);
  let processed = 0;
  let assigned = 0;
  
  for (const feature of admPack.features) {
    processed++;
    if (processed % 1000 === 0) {
      process.stdout.write(`\r  📊 Processed ${processed}/${admPack.features.length} features (${assigned} assigned)`);
    }
    
    // Try to get centroid
    const centroid = getCentroid(feature);
    if (!centroid) continue;
    
    // Check which state contains this feature
    let assignedToState = false;
    for (const [stateAbbr, stateFeature] of stateMap.entries()) {
      if (pointInPolygon(centroid, stateFeature.geometry)) {
        stateFeatures.get(stateAbbr).push(feature);
        assigned++;
        assignedToState = true;
        break;
      }
    }
    
    // If not assigned, try checking the feature's properties for state info
    if (!assignedToState) {
      const stateFromProps = feature.properties?.is_in_state || 
                            feature.properties?.state_code?.toLowerCase() ||
                            feature.properties?.addr_state?.toLowerCase();
      if (stateFromProps && US_STATES.includes(stateFromProps.toLowerCase())) {
        stateFeatures.get(stateFromProps.toLowerCase()).push(feature);
        assigned++;
      }
    }
  }
  
  console.log(`\r  ✅ Processed ${processed} features, assigned ${assigned} to states`);
  
  // Save state-specific packs
  console.log(`  💾 Saving state-specific packs...`);
  const storage = new Storage();
  const bucket = storage.bucket(BOUNDARY_PACKS_BUCKET);
  
  let savedCount = 0;
  let uploadedCount = 0;
  
  for (const [stateAbbr, features] of stateFeatures.entries()) {
    if (features.length === 0) continue;
    
    const statePack = {
      type: 'FeatureCollection',
      features: features
    };
    
    // Save locally
    const localPath = path.join(outputDir, `${stateAbbr}.json.gz`);
    const compressed = zlib.gzipSync(JSON.stringify(statePack));
    fs.writeFileSync(localPath, compressed);
    savedCount++;
    
    const stats = fs.statSync(localPath);
    console.log(`    ✅ ${stateAbbr.toUpperCase()}: ${features.length} features (${(stats.size / 1024).toFixed(1)}KB)`);
    
    // Upload to GCS
    try {
      const remotePath = `${BOUNDARY_PACKS_PREFIX}/us/adm${level}/${stateAbbr}.json.gz`;
      await bucket.upload(localPath, {
        destination: remotePath,
        metadata: {
          cacheControl: 'public, max-age=31536000',
          contentType: 'application/gzip',
        },
      });
      uploadedCount++;
    } catch (error) {
      console.warn(`    ⚠️  Failed to upload ${stateAbbr}: ${error.message}`);
    }
  }
  
  console.log(`\n  ✅ Saved ${savedCount} state packs`);
  console.log(`  ✅ Uploaded ${uploadedCount} packs to GCS`);
}

async function main() {
  const levels = process.argv.slice(2);
  const levelsToProcess = levels.length > 0 ? levels.map(l => parseInt(l.replace('adm', ''))) : [6, 7, 8, 9, 10];
  
  console.log('🗺️  Splitting US ADM packs by state');
  console.log(`Levels to process: ${levelsToProcess.join(', ')}\n`);
  
  for (const level of levelsToProcess) {
    try {
      await splitByState(level);
    } catch (error) {
      console.error(`\n❌ Error processing ADM${level}:`, error.message);
      console.error(error.stack);
    }
  }
  
  console.log('\n✅ Done!');
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { splitByState };
