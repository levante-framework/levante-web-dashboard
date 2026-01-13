#!/usr/bin/env node

/**
 * Build Admin Boundary Packs from Geofabrik Extracts
 * 
 * Downloads Geofabrik PBF files and extracts admin_level 4-5 boundaries,
 * storing them as GeoJSON packs (similar to GADM packs) for fast local lookups.
 * 
 * This script automatically detects and uses the best available method:
 *   1. If osmium-tool is installed: Downloads PBF → Extracts with osmium → Converts to GeoJSON (FASTEST)
 *   2. Otherwise: Uses Overpass API to query admin boundaries (works without installation)
 * 
 * Installation:
 *   Ubuntu/Debian: sudo apt-get install osmium-tool
 *   macOS: brew install osmium-tool
 *   Windows: Download from https://osmcode.org/osmium-tool/
 * 
 * Usage:
 *   node scripts/adm/build-geofabrik-packs.js [country1,country2,...]
 * 
 * Example:
 *   node scripts/adm/build-geofabrik-packs.js us,ca,de,gb
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const { execSync } = require('child_process');

const ADM_PACK_DIR = path.join(process.cwd(), 'public', 'adm-packs');
const GEOFABRIK_CACHE_DIR = path.join(process.cwd(), 'data', 'geofabrik');
const GEOFABRIK_BASE_URL = 'https://download.geofabrik.de';

// Check if osmium-tool is available
function checkOsmiumTool() {
  try {
    execSync('osmium --version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

// ISO2 to Geofabrik region mapping
const GEOFABRIK_REGIONS = {
  'us': {
    'north-america': 'us',
    'subregions': ['us-alabama', 'us-alaska', 'us-arizona', 'us-arkansas', 'us-california', 'us-colorado', 'us-connecticut', 'us-delaware', 'us-district-of-columbia', 'us-florida', 'us-georgia', 'us-hawaii', 'us-idaho', 'us-illinois', 'us-indiana', 'us-iowa', 'us-kansas', 'us-kentucky', 'us-louisiana', 'us-maine', 'us-maryland', 'us-massachusetts', 'us-michigan', 'us-minnesota', 'us-mississippi', 'us-missouri', 'us-montana', 'us-nebraska', 'us-nevada', 'us-new-hampshire', 'us-new-jersey', 'us-new-mexico', 'us-new-york', 'us-north-carolina', 'us-north-dakota', 'us-ohio', 'us-oklahoma', 'us-oregon', 'us-pennsylvania', 'us-rhode-island', 'us-south-carolina', 'us-south-dakota', 'us-tennessee', 'us-texas', 'us-utah', 'us-vermont', 'us-virginia', 'us-washington', 'us-west-virginia', 'us-wisconsin', 'us-wyoming']
  },
  'ca': {
    'north-america': 'canada',
    'subregions': []
  },
  'co': {
    'south-america': 'colombia',
    'subregions': []
  },
  'de': {
    'europe': 'germany',
    'subregions': []
  },
  'gb': {
    'europe': 'great-britain',
    'subregions': []
  },
  'nl': {
    'europe': 'netherlands',
    'subregions': []
  },
  'gh': {
    'africa': 'ghana',
    'subregions': []
  },
  'ch': {
    'europe': 'switzerland',
    'subregions': []
  },
  'in': {
    'asia': 'india',
    'subregions': []
  },
  'ar': {
    'south-america': 'argentina',
    'subregions': []
  }
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Use Overpass API to query admin boundaries for the country
// This is more reliable than parsing PBF files and doesn't require system dependencies
async function queryOverpassForCountry(countryIso2, adminLevel) {
  // Get bounding box for country (reuse from OSM pack builder)
  const COUNTRY_BBOX = {
    'us': { minLat: 24.5, maxLat: 49.4, minLon: -125.0, maxLon: -66.9 },
    'ca': { minLat: 41.7, maxLat: 83.1, minLon: -141.0, maxLon: -52.6 },
    'co': { minLat: -4.2, maxLat: 12.5, minLon: -79.0, maxLon: -66.9 },
    'de': { minLat: 47.3, maxLat: 55.1, minLon: 5.9, maxLon: 15.0 },
    'gb': { minLat: 49.9, maxLat: 60.8, minLon: -8.6, maxLon: 1.8 },
    'nl': { minLat: 50.8, maxLat: 53.6, minLon: 3.4, maxLon: 7.2 },
    'gh': { minLat: 4.7, maxLat: 11.2, minLon: -3.3, maxLon: 1.3 },
    'ch': { minLat: 45.8, maxLat: 47.8, minLon: 5.9, maxLon: 10.5 },
    'in': { minLat: 6.8, maxLat: 35.7, minLon: 68.2, maxLon: 97.4 },
    'ar': { minLat: -55.1, maxLat: -21.8, minLon: -73.6, maxLon: -53.6 }
  };
  
  const bbox = COUNTRY_BBOX[countryIso2];
  if (!bbox) {
    console.warn(`  ⚠️  No bounding box for ${countryIso2}`);
    return null;
  }
  
  // Use Overpass API with proper relation geometry extraction
  // Note: This is a simplified approach - for production, consider using
  // Geofabrik extracts with osmium-tool for better performance
  const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
  
  // Query for relations with admin_level, then get their ways/nodes
  const query = `[out:json][timeout:300];
(
  relation["admin_level"="${adminLevel}"]["boundary"="administrative"]
    (${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon});
);
(._;>;);
out geom;`;
  
  return new Promise((resolve, reject) => {
    const postData = `data=${encodeURIComponent(query)}`;
    
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Levante-Locations/1.0 (contact: support@levante-network.org)'
      },
      timeout: 600000 // 10 minutes for large queries
    };

    const req = https.request(OVERPASS_URL, options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          return;
        }
        
        if (data.trim().startsWith('<?xml') || data.trim().startsWith('<!DOCTYPE')) {
          reject(new Error(`Overpass returned XML error: ${data.slice(0, 500)}`));
          return;
        }
        
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (error) {
          reject(new Error(`Failed to parse JSON: ${error.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`  📥 Downloading: ${url}`);
    const file = fs.createWriteStream(outputPath);
    
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // Follow redirect
        return downloadFile(res.headers.location, outputPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      
      const totalSize = parseInt(res.headers['content-length'], 10);
      let downloadedSize = 0;
      
      res.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize) {
          const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
          process.stdout.write(`\r  📥 Progress: ${percent}% (${(downloadedSize / 1024 / 1024).toFixed(1)}MB / ${(totalSize / 1024 / 1024).toFixed(1)}MB)`);
        }
      });
      
      res.pipe(file);
      
      file.on('finish', () => {
        file.close();
        console.log(''); // New line after progress
        const stats = fs.statSync(outputPath);
        console.log(`  ✅ Downloaded: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
        resolve();
      });
    }).on('error', (err) => {
      fs.unlinkSync(outputPath);
      reject(err);
    });
  });
}

function getGeofabrikUrl(countryIso2) {
  const region = GEOFABRIK_REGIONS[countryIso2];
  if (!region) return null;
  
  // For countries with subregions (like US), we'll use the main country file
  // For others, use the direct country file
  const continent = Object.keys(region).find(k => k !== 'subregions');
  const countryName = region[continent];
  
  return `${GEOFABRIK_BASE_URL}/${continent}/${countryName}-latest.osm.pbf`;
}

async function downloadGeofabrikExtract(countryIso2) {
  const url = getGeofabrikUrl(countryIso2);
  if (!url) {
    console.warn(`  ⚠️  No Geofabrik URL for ${countryIso2}`);
    return null;
  }
  
  const cacheDir = GEOFABRIK_CACHE_DIR;
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  
  const pbfPath = path.join(cacheDir, `${countryIso2}-latest.osm.pbf`);
  
  // Check if already downloaded
  if (fs.existsSync(pbfPath)) {
    const stats = fs.statSync(pbfPath);
    console.log(`  ⏭️  Already downloaded: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
    return pbfPath;
  }
  
  try {
    await downloadFile(url, pbfPath);
    return pbfPath;
  } catch (error) {
    console.error(`  ❌ Download failed: ${error.message}`);
    return null;
  }
}

function extractAdminBoundariesOsmium(pbfPath, countryIso2, adminLevel) {
  const outputPath = path.join(ADM_PACK_DIR, countryIso2, `adm${adminLevel}-geofabrik.json`);
  const tempPath = outputPath + '.tmp';
  
  try {
    // Extract relations with admin_level using osmium
    // osmium tags-filter extracts relations with specific tags
    const filterCmd = `osmium tags-filter "${pbfPath}" r/boundary=administrative r/admin_level=${adminLevel} -o "${tempPath}"`;
    console.log(`  🔍 Extracting admin_level ${adminLevel}...`);
    execSync(filterCmd, { stdio: 'inherit' });
    
    // Convert to GeoJSON (we'll need to use a different tool or library)
    // For now, let's use ogr2ogr if available, or we'll need to parse the PBF
    console.log(`  ⚠️  osmium extraction complete, but GeoJSON conversion needed`);
    console.log(`  💡 Consider using ogr2ogr or a PBF parser to convert to GeoJSON`);
    
    return null; // Placeholder - need to implement conversion
  } catch (error) {
    console.error(`  ❌ Extraction failed: ${error.message}`);
    return null;
  }
}

function extractAdminBoundariesOgr2ogr(pbfPath, countryIso2, adminLevel) {
  const outputPath = path.join(ADM_PACK_DIR, countryIso2, `adm${adminLevel}-geofabrik.json`);
  
  try {
    // ogr2ogr can read OSM PBF and filter by tags
    const cmd = `ogr2ogr -f GeoJSON "${outputPath}" "${pbfPath}" -where "boundary='administrative' AND admin_level='${adminLevel}'" -sql "SELECT * FROM multipolygons WHERE boundary='administrative' AND admin_level='${adminLevel}'"`;
    console.log(`  🔍 Extracting admin_level ${adminLevel} with ogr2ogr...`);
    execSync(cmd, { stdio: 'inherit' });
    
    // Compress
    if (fs.existsSync(outputPath)) {
      const geojson = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      const compressed = zlib.gzipSync(JSON.stringify(geojson));
      const gzPath = outputPath + '.gz';
      fs.writeFileSync(gzPath, compressed);
      fs.unlinkSync(outputPath);
      
      const stats = fs.statSync(gzPath);
      console.log(`  ✅ Saved: ${geojson.features.length} features (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
      return gzPath;
    }
    
    return null;
  } catch (error) {
    console.error(`  ❌ Extraction failed: ${error.message}`);
    return null;
  }
}

// Convert OSM Overpass response to GeoJSON
// This is a simplified version - relations need geometry reconstruction from ways
function convertOSMToGeoJSON(osmData, adminLevel, countryIso2 = null) {
  const features = [];
  const relations = osmData.elements.filter(e => e.type === 'relation');
  
  // Group ways by relation
  const ways = osmData.elements.filter(e => e.type === 'way');
  const nodes = osmData.elements.filter(e => e.type === 'node');
  
  // Create node lookup
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.id, [node.lon, node.lat]);
  }
  
  // For each relation, try to reconstruct geometry from its members
  for (const relation of relations) {
    if (!relation.tags || parseInt(relation.tags.admin_level) !== adminLevel) continue;
    
    // Filter by country: check ISO3166-1 tag
    // Note: This is a basic check - for more accuracy, use osmium-tool with country-specific PBF
    if (countryIso2) {
      const relationCountry = relation.tags['ISO3166-1'] || relation.tags['ISO3166-1:alpha2'];
      // If country tag exists and doesn't match, skip (but allow if tag is missing)
      // This helps filter out neighboring countries when bounding box is too large
      if (relationCountry && relationCountry.toUpperCase() !== countryIso2.toUpperCase()) {
        continue; // Skip relations from other countries
      }
    }
    
    // Get ways that are members of this relation
    const relationWays = [];
    if (relation.members) {
      for (const member of relation.members) {
        if (member.type === 'way' && member.role === 'outer') {
          const way = ways.find(w => w.id === member.ref);
          if (way && way.nodes) {
            const coordinates = way.nodes
              .map(nodeId => nodeMap.get(nodeId))
              .filter(coord => coord !== undefined);
            if (coordinates.length > 0) {
              relationWays.push(coordinates);
            }
          }
        }
      }
    }
    
    // If we have geometry from ways, create a feature
    // Note: This is simplified - full implementation would need to handle
    // multiple outer rings, inner rings, and proper polygon construction
    if (relationWays.length > 0) {
      // Use the first outer ring (simplified)
      const coordinates = relationWays[0];
      if (coordinates.length >= 3) {
        // Close polygon
        if (coordinates[0][0] !== coordinates[coordinates.length - 1][0] ||
            coordinates[0][1] !== coordinates[coordinates.length - 1][1]) {
          coordinates.push(coordinates[0]);
        }
        
        // Filter by country bounding box if no ISO3166-1 tag
        if (countryIso2) {
          const COUNTRY_BBOX = {
            'us': { minLat: 24.5, maxLat: 49.4, minLon: -125.0, maxLon: -66.9 },
            'ca': { minLat: 41.7, maxLat: 83.1, minLon: -141.0, maxLon: -52.6 },
            'co': { minLat: -4.2, maxLat: 12.5, minLon: -79.0, maxLon: -66.9 },
            'de': { minLat: 47.3, maxLat: 55.1, minLon: 5.9, maxLon: 15.0 },
            'gb': { minLat: 49.9, maxLat: 60.8, minLon: -8.6, maxLon: 1.8 },
            'nl': { minLat: 50.8, maxLat: 53.6, minLon: 3.4, maxLon: 7.2 },
            'gh': { minLat: 4.7, maxLat: 11.2, minLon: -3.3, maxLon: 1.3 },
            'ch': { minLat: 45.8, maxLat: 47.8, minLon: 5.9, maxLon: 10.5 },
            'in': { minLat: 6.8, maxLat: 35.7, minLon: 68.2, maxLon: 97.4 },
            'ar': { minLat: -55.1, maxLat: -21.8, minLon: -73.6, maxLon: -53.6 }
          };
          
          const bbox = COUNTRY_BBOX[countryIso2.toLowerCase()];
          if (bbox) {
            // Check if polygon centroid is within country bounds
            let sumLat = 0, sumLon = 0, count = 0;
            for (const coord of coordinates) {
              if (coord && coord.length >= 2) {
                sumLon += coord[0];
                sumLat += coord[1];
                count++;
              }
            }
            if (count > 0) {
              const centroidLat = sumLat / count;
              const centroidLon = sumLon / count;
              
              // Skip if centroid is outside country bounds
              if (centroidLat < bbox.minLat || centroidLat > bbox.maxLat ||
                  centroidLon < bbox.minLon || centroidLon > bbox.maxLon) {
                continue; // Skip features outside country bounds
              }
            }
          }
        }
        
        features.push({
          type: 'Feature',
          properties: {
            name: relation.tags.name || relation.tags['name:en'] || relation.tags['name:local'] || 'Unknown',
            admin_level: adminLevel,
            source: 'geofabrik-overpass',
            osm_id: relation.id
          },
          geometry: {
            type: 'Polygon',
            coordinates: [coordinates]
          }
        });
      }
    }
  }
  
  return {
    type: 'FeatureCollection',
    features
  };
}

async function extractWithOsmium(pbfPath, countryIso2, adminLevel) {
  const outputDir = path.join(ADM_PACK_DIR, countryIso2);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const tempPbfPath = path.join(outputDir, `adm${adminLevel}-temp.osm.pbf`);
  const tempGeojsonPath = path.join(outputDir, `adm${adminLevel}-temp.geojson`);
  const finalPath = path.join(outputDir, `adm${adminLevel}-geofabrik.json.gz`);
  
  try {
    // Step 1: Extract relations with admin_level using osmium tags-filter
    console.log(`  🔍 Extracting admin_level ${adminLevel} with osmium...`);
    execSync(`osmium tags-filter "${pbfPath}" r/boundary=administrative r/admin_level=${adminLevel} -o "${tempPbfPath}"`, {
      stdio: 'inherit'
    });
    
    // Step 2: Convert to GeoJSON using osmium export
    console.log(`  🔄 Converting to GeoJSON...`);
    execSync(`osmium export "${tempPbfPath}" -o "${tempGeojsonPath}"`, {
      stdio: 'inherit'
    });
    
    // Step 3: Read, compress, and save
    if (fs.existsSync(tempGeojsonPath)) {
      const geojson = JSON.parse(fs.readFileSync(tempGeojsonPath, 'utf8'));
      
      // Filter to only include features with admin_level
      if (geojson.features) {
        geojson.features = geojson.features.filter(f => {
          const adminLevelTag = f.properties?.['boundary:administrative'] || 
                               f.properties?.admin_level ||
                               f.properties?.['admin_level'];
          return adminLevelTag === adminLevel || adminLevelTag === String(adminLevel);
        });
      }
      
      const compressed = zlib.gzipSync(JSON.stringify(geojson));
      fs.writeFileSync(finalPath, compressed);
      
      // Cleanup temp files
      if (fs.existsSync(tempPbfPath)) fs.unlinkSync(tempPbfPath);
      if (fs.existsSync(tempGeojsonPath)) fs.unlinkSync(tempGeojsonPath);
      
      const stats = fs.statSync(finalPath);
      console.log(`  ✅ Saved: ${geojson.features?.length || 0} features (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
      return true;
    }
    
    return false;
  } catch (error) {
    // Cleanup on error
    if (fs.existsSync(tempPbfPath)) fs.unlinkSync(tempPbfPath);
    if (fs.existsSync(tempGeojsonPath)) fs.unlinkSync(tempGeojsonPath);
    throw error;
  }
}

async function buildGeofabrikPack(countryIso2) {
  console.log(`\n🌍 Building Geofabrik packs for ${countryIso2.toUpperCase()}...`);
  
  const hasOsmium = checkOsmiumTool();
  
  if (hasOsmium) {
    console.log(`  ✅ Using osmium-tool (fast local processing)`);
    
    // Download PBF file
    const pbfPath = await downloadGeofabrikExtract(countryIso2);
    if (!pbfPath) {
      return;
    }
    
    const outputDir = path.join(ADM_PACK_DIR, countryIso2);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Extract admin_level 4, 5, 6, 7, 8, 9, 10 using osmium-tool
    // Note: ADM4/5 removed from gallery lookup, but keeping in pack builder for testing
    // ADM6/7/8/9/10 are more granular (towns, neighborhoods, wards, electoral districts)
    for (const level of [4, 5, 6, 7, 8, 9, 10]) {
      try {
        await extractWithOsmium(pbfPath, countryIso2, level);
      } catch (error) {
        console.error(`  ❌ Failed admin_level ${level}: ${error.message}`);
      }
    }
  } else {
    console.log(`  💡 Using Overpass API (install osmium-tool for faster processing)`);
    console.log(`  📝 Install: sudo apt-get install osmium-tool`);
    
    const outputDir = path.join(ADM_PACK_DIR, countryIso2);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Extract admin_level 4 and 5 using Overpass API
    for (const level of [4, 5]) {
      console.log(`  📥 Querying admin_level ${level}...`);
      
      try {
        await sleep(2000); // Rate limiting
        const osmData = await queryOverpassForCountry(countryIso2, level);
        
        if (!osmData || !osmData.elements || osmData.elements.length === 0) {
          console.log(`  ⚠️  No admin_level ${level} boundaries found`);
          continue;
        }
        
        console.log(`  ✅ Found ${osmData.elements.filter(e => e.type === 'relation').length} relations`);
        
        const geojson = convertOSMToGeoJSON(osmData, level, countryIso2);
        
        if (!geojson || !geojson.features || geojson.features.length === 0) {
          console.warn(`  ⚠️  Could not convert to GeoJSON (geometry reconstruction issues)`);
          continue;
        }
        
        const outputPath = path.join(outputDir, `adm${level}-geofabrik.json.gz`);
        const compressed = zlib.gzipSync(JSON.stringify(geojson));
        fs.writeFileSync(outputPath, compressed);
        
        const stats = fs.statSync(outputPath);
        console.log(`  💾 Saved: ${geojson.features.length} features (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
      } catch (error) {
        console.error(`  ❌ Failed: ${error.message}`);
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const countries = args.length > 0 
    ? args[0].split(',').map(c => c.trim().toLowerCase())
    : Object.keys(GEOFABRIK_REGIONS);
  
  console.log('🗺️  Building Admin Boundary Packs using Geofabrik data');
  console.log(`Countries: ${countries.join(', ')}\n`);
  
  const hasOsmium = checkOsmiumTool();
  if (hasOsmium) {
    console.log('✅ Using osmium-tool (fast local processing)\n');
  } else {
    console.log('💡 Using Overpass API (install osmium-tool for faster processing)');
    console.log('   Install: sudo apt-get install osmium-tool\n');
  }
  
  for (const country of countries) {
    if (!GEOFABRIK_REGIONS[country]) {
      console.warn(`⚠️  Unknown country: ${country}, skipping...`);
      continue;
    }
    
    await buildGeofabrikPack(country);
  }
  
  console.log('\n✅ Pack building complete!');
  console.log('\nNext steps:');
  console.log('  1. Update loadAdmPack to try Geofabrik packs');
  console.log('  2. Regenerate gallery data');
}

main().catch(console.error);
