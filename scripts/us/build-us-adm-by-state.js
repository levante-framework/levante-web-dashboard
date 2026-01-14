#!/usr/bin/env node

/**
 * Build US ADM6-10 packs by state from Geofabrik PBF files
 * 
 * This script extracts admin_level 6-10 boundaries from the US PBF file,
 * splitting them by state to avoid Node.js string size limits.
 * 
 * Usage:
 *   node scripts/us/build-us-adm-by-state.js [--levels=6,7,8,9,10] [--states=CA,OR,FL]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');
const { Storage } = require('@google-cloud/storage');

const ADM_PACK_DIR = path.join(process.cwd(), 'public', 'adm-packs');
const GEOFABRIK_CACHE_DIR = path.join(process.cwd(), 'data', 'geofabrik');
const BOUNDARY_PACKS_BUCKET = process.env.BOUNDARY_PACKS_BUCKET || 'levante-assets-draft';
const BOUNDARY_PACKS_PREFIX = process.env.BOUNDARY_PACKS_PREFIX || 'maps/boundaries';

// US state bounding boxes (approximate, from OSM)
const STATE_BBOXES = {
  'al': { minLat: 30.1, maxLat: 35.0, minLon: -88.5, maxLon: -84.9 },
  'ak': { minLat: 51.2, maxLat: 71.5, minLon: -179.1, maxLon: -129.9 },
  'az': { minLat: 31.3, maxLat: 37.0, minLon: -114.8, maxLon: -109.0 },
  'ar': { minLat: 33.0, maxLat: 36.5, minLon: -94.6, maxLon: -89.6 },
  'ca': { minLat: 32.5, maxLat: 42.0, minLon: -124.5, maxLon: -114.1 },
  'co': { minLat: 37.0, maxLat: 41.0, minLon: -109.1, maxLon: -102.0 },
  'ct': { minLat: 40.9, maxLat: 42.0, minLon: -73.7, maxLon: -71.8 },
  'de': { minLat: 38.4, maxLat: 39.7, minLon: -75.8, maxLon: -75.0 },
  'dc': { minLat: 38.8, maxLat: 39.0, minLon: -77.1, maxLon: -76.9 },
  'fl': { minLat: 24.5, maxLat: 31.0, minLon: -87.6, maxLon: -80.0 },
  'ga': { minLat: 30.4, maxLat: 35.0, minLon: -85.6, maxLon: -80.8 },
  'hi': { minLat: 18.9, maxLat: 22.2, minLon: -160.3, maxLon: -154.8 },
  'id': { minLat: 42.0, maxLat: 49.0, minLon: -117.2, maxLon: -111.0 },
  'il': { minLat: 37.0, maxLat: 42.5, minLon: -91.5, maxLon: -87.5 },
  'in': { minLat: 37.8, maxLat: 41.8, minLon: -88.1, maxLon: -84.8 },
  'ia': { minLat: 40.4, maxLat: 43.5, minLon: -96.6, maxLon: -90.1 },
  'ks': { minLat: 37.0, maxLat: 40.0, minLon: -102.1, maxLon: -94.6 },
  'ky': { minLat: 36.5, maxLat: 39.1, minLon: -89.6, maxLon: -81.9 },
  'la': { minLat: 29.0, maxLat: 33.0, minLon: -94.0, maxLon: -88.8 },
  'me': { minLat: 43.1, maxLat: 47.5, minLon: -71.1, maxLon: -66.9 },
  'md': { minLat: 37.9, maxLat: 39.7, minLon: -79.5, maxLon: -75.0 },
  'ma': { minLat: 41.2, maxLat: 42.9, minLon: -73.5, maxLon: -69.9 },
  'mi': { minLat: 41.7, maxLat: 48.3, minLon: -90.4, maxLon: -82.4 },
  'mn': { minLat: 43.5, maxLat: 49.4, minLon: -97.2, maxLon: -89.5 },
  'ms': { minLat: 30.2, maxLat: 35.0, minLon: -91.7, maxLon: -88.1 },
  'mo': { minLat: 36.0, maxLat: 40.6, minLon: -95.8, maxLon: -89.1 },
  'mt': { minLat: 44.4, maxLat: 49.0, minLon: -116.0, maxLon: -104.0 },
  'ne': { minLat: 40.0, maxLat: 43.0, minLon: -104.1, maxLon: -95.3 },
  'nv': { minLat: 35.0, maxLat: 42.0, minLon: -120.0, maxLon: -114.0 },
  'nh': { minLat: 42.7, maxLat: 45.3, minLon: -72.6, maxLon: -70.6 },
  'nj': { minLat: 38.9, maxLat: 41.4, minLon: -75.6, maxLon: -73.9 },
  'nm': { minLat: 31.3, maxLat: 37.0, minLon: -109.1, maxLon: -103.0 },
  'ny': { minLat: 40.5, maxLat: 45.0, minLon: -79.8, maxLon: -71.8 },
  'nc': { minLat: 33.8, maxLat: 36.6, minLon: -84.3, maxLon: -75.5 },
  'nd': { minLat: 45.9, maxLat: 49.0, minLon: -104.1, maxLon: -96.6 },
  'oh': { minLat: 38.4, maxLat: 42.0, minLon: -84.8, maxLon: -80.5 },
  'ok': { minLat: 33.6, maxLat: 37.0, minLon: -103.0, maxLon: -94.4 },
  'or': { minLat: 42.0, maxLat: 46.3, minLon: -124.6, maxLon: -116.5 },
  'pa': { minLat: 39.7, maxLat: 42.3, minLon: -80.5, maxLon: -74.7 },
  'ri': { minLat: 41.1, maxLat: 42.0, minLon: -71.9, maxLon: -71.1 },
  'sc': { minLat: 32.0, maxLat: 35.2, minLon: -83.4, maxLon: -78.5 },
  'sd': { minLat: 42.5, maxLat: 45.9, minLon: -104.1, maxLon: -96.4 },
  'tn': { minLat: 35.0, maxLat: 36.7, minLon: -90.3, maxLon: -81.7 },
  'tx': { minLat: 25.8, maxLat: 36.5, minLon: -106.7, maxLon: -93.5 },
  'ut': { minLat: 37.0, maxLat: 42.0, minLon: -114.1, maxLon: -109.0 },
  'vt': { minLat: 42.7, maxLat: 45.0, minLon: -73.4, maxLon: -71.5 },
  'va': { minLat: 36.5, maxLat: 39.5, minLon: -83.7, maxLon: -75.2 },
  'wa': { minLat: 45.5, maxLat: 49.0, minLon: -124.8, maxLon: -116.9 },
  'wv': { minLat: 37.2, maxLat: 40.6, minLon: -82.6, maxLon: -77.7 },
  'wi': { minLat: 42.5, maxLat: 47.1, minLon: -92.9, maxLon: -86.8 },
  'wy': { minLat: 41.0, maxLat: 45.0, minLon: -111.1, maxLon: -104.0 }
};

function checkOsmiumTool() {
  try {
    execSync('osmium --version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function getArg(name, defaultValue) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : defaultValue;
}

async function extractStateAdmLevel(pbfPath, stateAbbr, adminLevel) {
  const state = stateAbbr.toLowerCase();
  const bbox = STATE_BBOXES[state];
  if (!bbox) {
    throw new Error(`No bounding box for state: ${stateAbbr}`);
  }
  
  const outputDir = path.join(ADM_PACK_DIR, 'us', `adm${adminLevel}`);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const tempPbfPath = path.join(outputDir, `${state}-temp.osm.pbf`);
  const tempGeojsonPath = path.join(outputDir, `${state}-temp.geojson`);
  const finalPath = path.join(outputDir, `${state}.json.gz`);
  
  try {
    // Step 1: Extract by bounding box first (this gives us a much smaller file)
    const bboxStr = `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`;
    const tempBboxPath = path.join(outputDir, `${state}-bbox-temp.osm.pbf`);
    console.log(`    🔍 Extracting bounding box for ${stateAbbr.toUpperCase()}...`);
    execSync(`osmium extract -b "${bboxStr}" "${pbfPath}" -o "${tempBboxPath}"`, {
      stdio: 'inherit'
    });
    
    // Step 2: Filter by admin_level from the smaller bbox file
    console.log(`    🔍 Filtering admin_level ${adminLevel}...`);
    execSync(`osmium tags-filter "${tempBboxPath}" r/boundary=administrative r/admin_level=${adminLevel} -o "${tempPbfPath}"`, {
      stdio: 'inherit'
    });
    
    // Step 3: Convert to GeoJSON
    console.log(`    🔄 Converting to GeoJSON...`);
    execSync(`osmium export "${tempPbfPath}" -o "${tempGeojsonPath}"`, {
      stdio: 'inherit'
    });
    
    // Cleanup bbox temp file
    if (fs.existsSync(tempBboxPath)) fs.unlinkSync(tempBboxPath);
    
    // Step 3: Read, filter by state, compress, and save
    if (fs.existsSync(tempGeojsonPath)) {
      const stats = fs.statSync(tempGeojsonPath);
      const fileSizeMB = stats.size / (1024 * 1024);
      
      // Always parse to filter by state bounds
      let geojson;
      try {
        geojson = JSON.parse(fs.readFileSync(tempGeojsonPath, 'utf8'));
      } catch (error) {
        if (error.message.includes('string longer than')) {
          console.log(`    ⚠️  File too large to parse directly. Filtering will be limited.`);
          // For very large files, we'll need to stream parse or skip filtering
          // For now, just compress as-is
          const readStream = fs.createReadStream(tempGeojsonPath);
          const writeStream = fs.createWriteStream(finalPath);
          const gzip = zlib.createGzip();
          
          await new Promise((resolve, reject) => {
            readStream.pipe(gzip).pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
          });
          
          const finalStats = fs.statSync(finalPath);
          console.log(`    ✅ Saved: (unfiltered, ${(finalStats.size / 1024).toFixed(1)}KB)`);
          
          // Cleanup
          if (fs.existsSync(tempPbfPath)) fs.unlinkSync(tempPbfPath);
          if (fs.existsSync(tempGeojsonPath)) fs.unlinkSync(tempGeojsonPath);
          return finalPath;
        }
        throw error;
      }
      
      if (fileSizeMB < 100) {
        // Parse and filter
        const geojson = JSON.parse(fs.readFileSync(tempGeojsonPath, 'utf8'));
        
        // Filter to only include features with admin_level
        if (geojson.features) {
          geojson.features = geojson.features.filter(f => {
            const adminLevelTag = f.properties?.['boundary:administrative'] || 
                                 f.properties?.admin_level ||
                                 f.properties?.['admin_level'];
            return adminLevelTag === adminLevel || adminLevelTag === String(adminLevel);
          });
          
          // Additional filtering: ensure features are within state bounds
          geojson.features = geojson.features.filter(f => {
            if (!f.geometry || !f.geometry.coordinates) return false;
            // Simple check: if centroid is within bounds
            const coords = f.geometry.coordinates;
            let centroid = null;
            
            if (f.geometry.type === 'Polygon' && coords[0] && coords[0].length > 0) {
              const ring = coords[0];
              let sumLat = 0, sumLon = 0, count = 0;
              for (const [lon, lat] of ring) {
                sumLat += lat;
                sumLon += lon;
                count++;
              }
              if (count > 0) centroid = [sumLon / count, sumLat / count];
            }
            
            if (centroid) {
              const [lon, lat] = centroid;
              return lat >= bbox.minLat && lat <= bbox.maxLat &&
                     lon >= bbox.minLon && lon <= bbox.maxLon;
            }
            return true; // Keep if we can't determine centroid
          });
        }
        
        const compressed = zlib.gzipSync(JSON.stringify(geojson));
        fs.writeFileSync(finalPath, compressed);
      }
      
      // Cleanup temp files
      const tempBboxPath = path.join(outputDir, `${state}-bbox-temp.osm.pbf`);
      if (fs.existsSync(tempBboxPath)) fs.unlinkSync(tempBboxPath);
      if (fs.existsSync(tempPbfPath)) fs.unlinkSync(tempPbfPath);
      if (fs.existsSync(tempGeojsonPath)) fs.unlinkSync(tempGeojsonPath);
      
        const finalStats = fs.statSync(finalPath);
        const featureCount = geojson.features?.length || 0;
        console.log(`    ✅ Saved: ${featureCount} features (${(finalStats.size / 1024).toFixed(1)}KB)`);
      
      return finalPath;
    }
    
    return null;
  } catch (error) {
    // Cleanup on error
    const tempBboxPath = path.join(outputDir, `${state}-bbox-temp.osm.pbf`);
    if (fs.existsSync(tempBboxPath)) fs.unlinkSync(tempBboxPath);
    if (fs.existsSync(tempPbfPath)) fs.unlinkSync(tempPbfPath);
    if (fs.existsSync(tempGeojsonPath)) fs.unlinkSync(tempGeojsonPath);
    throw error;
  }
}

async function uploadToGCS(stateAbbr, adminLevel, filePath) {
  const storage = new Storage();
  const bucket = storage.bucket(BOUNDARY_PACKS_BUCKET);
  const remotePath = `${BOUNDARY_PACKS_PREFIX}/us/adm${adminLevel}/${stateAbbr.toLowerCase()}.json.gz`;
  
  try {
    await bucket.upload(filePath, {
      destination: remotePath,
      metadata: {
        cacheControl: 'public, max-age=31536000',
        contentType: 'application/gzip',
      },
    });
    return true;
  } catch (error) {
    console.warn(`    ⚠️  Failed to upload to GCS: ${error.message}`);
    return false;
  }
}

async function buildStateAdmLevels(pbfPath, stateAbbr, levels) {
  console.log(`\n🌍 Processing ${stateAbbr.toUpperCase()}...`);
  
  for (const level of levels) {
    try {
      const filePath = await extractStateAdmLevel(pbfPath, stateAbbr, level);
      if (filePath) {
        await uploadToGCS(stateAbbr, level, filePath);
      }
    } catch (error) {
      console.error(`  ❌ Failed ADM${level} for ${stateAbbr}: ${error.message}`);
    }
  }
}

async function main() {
  const levelsArg = getArg('levels', '6,7,8,9,10');
  const statesArg = getArg('states', null); // null = all states
  
  const levels = levelsArg.split(',').map(l => parseInt(l.trim())).filter(l => !isNaN(l));
  const states = statesArg ? 
    statesArg.split(',').map(s => s.trim().toLowerCase()).filter(s => STATE_BBOXES[s]) :
    Object.keys(STATE_BBOXES);
  
  console.log('🗺️  Building US ADM packs by state from Geofabrik');
  console.log(`Levels: ${levels.join(', ')}`);
  console.log(`States: ${states.length} states\n`);
  
  if (!checkOsmiumTool()) {
    console.error('❌ osmium-tool is required. Install: sudo apt-get install osmium-tool');
    process.exit(1);
  }
  
  // Download US PBF file
  const pbfPath = path.join(GEOFABRIK_CACHE_DIR, 'us-latest.osm.pbf');
  if (!fs.existsSync(pbfPath)) {
    console.log('📥 US PBF file not found. Please run:');
    console.log(`   node scripts/adm/build-geofabrik-packs.js us`);
    console.log('   This will download the US PBF file.');
    process.exit(1);
  }
  
  console.log(`📦 Using PBF file: ${pbfPath}\n`);
  
  // Process each state
  for (const state of states) {
    try {
      await buildStateAdmLevels(pbfPath, state, levels);
    } catch (error) {
      console.error(`❌ Failed ${state}: ${error.message}`);
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

module.exports = { buildStateAdmLevels };
