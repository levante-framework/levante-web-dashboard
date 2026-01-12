#!/usr/bin/env node

/**
 * Build OSM Admin Boundary Packs
 * 
 * Downloads admin_level 4-5 boundaries from OpenStreetMap via Overpass API
 * and stores them as GeoJSON packs (similar to GADM packs) for fast local lookups.
 * 
 * Usage:
 *   node scripts/adm/build-osm-packs.js [country1,country2,...]
 * 
 * Example:
 *   node scripts/adm/build-osm-packs.js us,ca,de,gb
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const ADM_PACK_DIR = path.join(process.cwd(), 'public', 'adm-packs');
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// ISO2 to ISO3 mapping
const ISO2_TO_ISO3 = {
  'us': 'USA',
  'ca': 'CAN',
  'co': 'COL',
  'de': 'DEU',
  'gb': 'GBR',
  'nl': 'NLD',
  'gh': 'GHA',
  'ch': 'CHE',
  'in': 'IND',
  'ar': 'ARG'
};

// Country bounding boxes (approximate) for Overpass queries
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function queryOverpass(query) {
  return new Promise((resolve, reject) => {
    const postData = `data=${encodeURIComponent(query)}`;
    
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Levante-Locations/1.0 (contact: support@levante-network.org)'
      },
      timeout: 300000 // 5 minutes for large queries
    };

    const req = https.request(OVERPASS_URL, options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode !== 200) {
          // Show more of the error for debugging
          const errorPreview = data.slice(0, 500);
          reject(new Error(`HTTP ${res.statusCode}: ${errorPreview}`));
          return;
        }
        
        // Check if response is XML (error) instead of JSON
        if (data.trim().startsWith('<?xml') || data.trim().startsWith('<!DOCTYPE')) {
          reject(new Error(`Overpass returned XML error: ${data.slice(0, 500)}`));
          return;
        }
        
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (error) {
          reject(new Error(`Failed to parse JSON: ${error.message}. Response preview: ${data.slice(0, 200)}`));
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

function convertOSMToGeoJSON(osmData) {
  const features = [];
  const relations = osmData.elements.filter(e => e.type === 'relation');
  
  for (const relation of relations) {
    if (!relation.tags) continue;
    
    // Overpass with 'out geom;' returns geometry in relation.geometry
    // For relations, geometry is an array of {lat, lon} objects
    if (!relation.geometry || !Array.isArray(relation.geometry) || relation.geometry.length < 3) {
      // Debug: log first relation structure if conversion fails
      if (relations.indexOf(relation) === 0) {
        console.log(`    Debug: First relation structure - has geometry: ${!!relation.geometry}, geometry type: ${typeof relation.geometry}, geometry length: ${relation.geometry?.length || 'N/A'}`);
        if (relation.geometry && Array.isArray(relation.geometry) && relation.geometry.length > 0) {
          console.log(`    Debug: First geometry point: ${JSON.stringify(relation.geometry[0])}`);
        }
      }
      continue; // Need at least 3 points for a polygon
    }
    
    // Convert OSM geometry format to GeoJSON Polygon
    const coordinates = [];
    for (const geom of relation.geometry) {
      if (geom && typeof geom === 'object' && geom.lat !== undefined && geom.lon !== undefined) {
        coordinates.push([Number(geom.lon), Number(geom.lat)]);
      } else if (Array.isArray(geom) && geom.length >= 2) {
        // Handle array format [lon, lat] or [lat, lon]
        coordinates.push([Number(geom[0]), Number(geom[1])]);
      }
    }
    
    if (coordinates.length < 3) {
      if (relations.indexOf(relation) === 0) {
        console.log(`    Debug: Only ${coordinates.length} valid coordinates extracted`);
      }
      continue;
    }
    
    // Close the polygon if not already closed
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      coordinates.push([first[0], first[1]]);
    }
    
    // Handle MultiPolygon if there are multiple outer rings
    // For simplicity, we'll create a Polygon with the first ring
    // Full implementation would need to detect inner/outer rings
    const geometry = {
      type: 'Polygon',
      coordinates: [coordinates]
    };
    
    features.push({
      type: 'Feature',
      properties: {
        name: relation.tags.name || relation.tags['name:en'] || relation.tags['name:local'] || 'Unknown',
        admin_level: parseInt(relation.tags.admin_level) || null,
        source: 'osm-overpass',
        osm_id: relation.id
      },
      geometry
    });
  }
  
  return {
    type: 'FeatureCollection',
    features
  };
}

async function downloadOSMAdminBoundaries(countryIso2, adminLevel) {
  const bbox = COUNTRY_BBOX[countryIso2];
  if (!bbox) {
    console.warn(`  ⚠️  No bounding box for ${countryIso2}`);
    return null;
  }

  // Overpass bounding box format: (south,west,north,east)
  // For relations, we need to recurse down to ways and nodes to get geometry
  const query = `[out:json][timeout:300];
(
  relation["admin_level"="${adminLevel}"]["boundary"="administrative"]
    (${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon});
);
(._;>;);
out geom;`;

  console.log(`  📥 Downloading admin_level ${adminLevel} for ${countryIso2}...`);
  
  try {
    // Rate limiting: 2 seconds between queries
    await sleep(2000);
    
    const data = await queryOverpass(query);
    
    if (!data.elements || data.elements.length === 0) {
      console.log(`  ⚠️  No admin_level ${adminLevel} boundaries found for ${countryIso2}`);
      return null;
    }
    
    console.log(`  ✅ Found ${data.elements.length} admin_level ${adminLevel} boundaries`);
    
    const geojson = convertOSMToGeoJSON(data);
    
    if (!geojson || !geojson.features || geojson.features.length === 0) {
      console.warn(`  ⚠️  Conversion resulted in 0 features (might be geometry issues)`);
      return null;
    }
    
    console.log(`  ✅ Converted to ${geojson.features.length} GeoJSON features`);
    
    return geojson;
  } catch (error) {
    console.error(`  ❌ Error downloading ${countryIso2} admin_level ${adminLevel}: ${error.message}`);
    return null;
  }
}

async function buildOSMPack(countryIso2) {
  console.log(`\n🌍 Building OSM packs for ${countryIso2.toUpperCase()}...`);
  
  const outputDir = path.join(ADM_PACK_DIR, countryIso2);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Try admin_level 4 and 5
  for (const level of [4, 5]) {
    const geojson = await downloadOSMAdminBoundaries(countryIso2, level);
    
    if (geojson && geojson.features.length > 0) {
      const outputPath = path.join(outputDir, `adm${level}-osm.json.gz`);
      const compressed = zlib.gzipSync(JSON.stringify(geojson));
      fs.writeFileSync(outputPath, compressed);
      
      const stats = fs.statSync(outputPath);
      console.log(`  💾 Saved ${geojson.features.length} features to ${outputPath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const countries = args.length > 0 
    ? args[0].split(',').map(c => c.trim().toLowerCase())
    : Object.keys(COUNTRY_BBOX);
  
  console.log('🗺️  Building OSM Admin Boundary Packs');
  console.log(`Countries: ${countries.join(', ')}\n`);
  
  for (const country of countries) {
    if (!COUNTRY_BBOX[country]) {
      console.warn(`⚠️  Unknown country: ${country}, skipping...`);
      continue;
    }
    
    await buildOSMPack(country);
  }
  
  console.log('\n✅ OSM pack building complete!');
  console.log('\nNext steps:');
  console.log('  1. Update lookupTwoLevelAreas to try OSM packs');
  console.log('  2. Regenerate gallery data');
}

main().catch(console.error);
