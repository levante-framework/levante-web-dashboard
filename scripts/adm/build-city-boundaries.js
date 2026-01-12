#!/usr/bin/env node

/**
 * Build city boundary packs from OSM boundary relations
 * 
 * Queries OSM Overpass for boundary=administrative relations with place=city/town tags.
 * These represent actual city/town boundaries rather than admin divisions.
 * 
 * Usage:
 *   node scripts/adm/build-city-boundaries.js [country1,country2,...]
 * 
 * Example:
 *   node scripts/adm/build-city-boundaries.js ca,us,nl
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const ADM_PACK_DIR = path.join(__dirname, '../../public/adm-packs');

// Country bounding boxes for Overpass queries
const COUNTRY_BBOX = {
  'ca': { minLat: 41.7, maxLat: 83.1, minLon: -141.0, maxLon: -52.6 },
  'us': { minLat: 24.5, maxLat: 49.4, minLon: -125.0, maxLon: -66.9 },
  'nl': { minLat: 50.7, maxLat: 53.7, minLon: 3.2, maxLon: 7.2 },
  'de': { minLat: 47.3, maxLat: 55.1, minLon: 5.9, maxLon: 15.0 },
  'gb': { minLat: 49.9, maxLat: 60.8, minLon: -8.6, maxLon: 1.8 },
  'fr': { minLat: 41.3, maxLat: 51.1, minLon: -5.1, maxLon: 9.6 },
  'ch': { minLat: 45.8, maxLat: 47.8, minLon: 5.9, maxLon: 10.5 },
  'in': { minLat: 6.5, maxLat: 35.7, minLon: 68.1, maxLon: 97.4 },
  'ar': { minLat: -55.1, maxLat: -21.8, minLon: -73.6, maxLon: -53.6 },
  'co': { minLat: -4.2, maxLat: 12.5, minLon: -79.0, maxLon: -66.9 },
  'gh': { minLat: 4.7, maxLat: 11.2, minLon: -3.3, maxLon: 1.3 },
};

const OVERPASS_INSTANCES = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function queryOverpass(query, instanceIndex = 0) {
  const instance = OVERPASS_INSTANCES[instanceIndex % OVERPASS_INSTANCES.length];
  const url = `${instance}?data=${encodeURIComponent(query)}`;
  
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.elements) {
            resolve(result);
          } else {
            reject(new Error('Invalid response'));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', (err) => {
      // Try next instance
      if (instanceIndex < OVERPASS_INSTANCES.length - 1) {
        setTimeout(() => {
          queryOverpass(query, instanceIndex + 1).then(resolve).catch(reject);
        }, 2000);
      } else {
        reject(err);
      }
    });
  });
}

function reconstructGeometry(relation, ways, nodes) {
  const wayMap = new Map(ways.map(w => [w.id, w]));
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  
  const outerWays = [];
  const innerWays = [];
  
  // Find outer and inner ways
  for (const member of relation.members || []) {
    if (member.type === 'way') {
      const way = wayMap.get(member.ref);
      if (!way || !way.geometry) continue;
      
      const coords = way.geometry.map(p => [p.lon, p.lat]);
      if (member.role === 'outer') {
        outerWays.push(coords);
      } else if (member.role === 'inner') {
        innerWays.push(coords);
      }
    }
  }
  
  if (outerWays.length === 0) return null;
  
  // Combine outer ways into polygon
  const coordinates = [];
  for (const way of outerWays) {
    if (way.length > 0) {
      coordinates.push(...way);
    }
  }
  
  if (coordinates.length < 3) return null;
  
  // Close polygon if not closed
  if (coordinates[0][0] !== coordinates[coordinates.length - 1][0] ||
      coordinates[0][1] !== coordinates[coordinates.length - 1][1]) {
    coordinates.push(coordinates[0]);
  }
  
  return {
    type: 'Polygon',
    coordinates: [coordinates]
  };
}

async function buildCityBoundariesPack(countryIso2) {
  console.log(`\n🌍 Building city boundary pack for ${countryIso2.toUpperCase()}...`);
  
  const bbox = COUNTRY_BBOX[countryIso2.toLowerCase()];
  if (!bbox) {
    console.error(`  ❌ No bounding box for ${countryIso2}`);
    return;
  }
  
  const outputDir = path.join(ADM_PACK_DIR, countryIso2);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const finalPath = path.join(outputDir, 'city-boundaries-osm.json.gz');
  
  // Check if already exists
  if (fs.existsSync(finalPath)) {
    console.log(`  ✅ Already exists: city-boundaries-osm`);
    return;
  }
  
  // Query for boundary=administrative relations with place=city or place=town
  const query = `
[out:json][timeout:60];
(
  relation["boundary"="administrative"]["place"="city"](bbox:${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon});
  relation["boundary"="administrative"]["place"="town"](bbox:${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon});
);
out geom;
`;
  
  console.log(`  📥 Querying Overpass for city/town boundaries...`);
  
  try {
    await sleep(2000); // Rate limiting
    const result = await queryOverpass(query);
    
    if (!result.elements || result.elements.length === 0) {
      console.log(`  ⚠️  No city boundaries found`);
      return;
    }
    
    console.log(`  📦 Found ${result.elements.length} boundary relations`);
    
    // Separate relations, ways, and nodes
    const relations = result.elements.filter(e => e.type === 'relation');
    const ways = result.elements.filter(e => e.type === 'way');
    const nodes = result.elements.filter(e => e.type === 'node');
    
    const features = [];
    
    for (const relation of relations) {
      if (!relation.tags || !relation.tags.name) continue;
      
      const geometry = reconstructGeometry(relation, ways, nodes);
      if (!geometry) continue;
      
      features.push({
        type: 'Feature',
        properties: {
          name: relation.tags.name,
          place: relation.tags.place || 'unknown',
          admin_level: relation.tags.admin_level || null,
          source: 'osm-city-boundary',
          osm_id: relation.id
        },
        geometry: geometry
      });
    }
    
    const geojson = {
      type: 'FeatureCollection',
      features: features
    };
    
    const compressed = zlib.gzipSync(JSON.stringify(geojson));
    fs.writeFileSync(finalPath, compressed);
    
    const stats = fs.statSync(finalPath);
    console.log(`  ✅ Saved: ${features.length} features (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
    
    if (features.length > 0) {
      console.log(`  📋 Examples: ${features.slice(0, 5).map(f => f.properties.name).join(', ')}`);
    }
    
  } catch (error) {
    console.error(`  ❌ Failed: ${error.message}`);
  }
}

async function main() {
  const countries = process.argv.slice(2);
  
  if (countries.length === 0) {
    console.log('Usage: node build-city-boundaries.js <country1> [country2] ...');
    console.log('Example: node build-city-boundaries.js ca us nl');
    process.exit(1);
  }
  
  console.log('🗺️  Building City Boundary Packs from OSM');
  
  for (const country of countries) {
    try {
      await buildCityBoundariesPack(country);
    } catch (error) {
      console.error(`❌ Failed ${country}:`, error.message);
    }
  }
  
  console.log('\n✅ Done!');
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { buildCityBoundariesPack };
