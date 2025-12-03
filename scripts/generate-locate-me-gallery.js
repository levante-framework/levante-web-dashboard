#!/usr/bin/env node

/**
 * Generate Locate Me Gallery
 * 
 * Generates 100 GPS points from US, Colombia, Canada, and Germany,
 * processes them through the Locate-Me workflow, and creates an image gallery.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Country bounding boxes (approximate)
const COUNTRIES = {
  US: { lat: [24.5, 49.5], lon: [-125.0, -66.0], count: 125 },
  CO: { lat: [-4.2, 12.5], lon: [-79.0, -66.9], count: 125 },
  CA: { lat: [41.7, 83.1], lon: [-141.0, -52.6], count: 125 },
  DE: { lat: [47.3, 55.1], lon: [5.9, 15.0], count: 125 }
};

const BASE_URL = process.env.BASE_URL || 'https://levante-audio-dashboard.vercel.app';
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'gallery', 'locate-me');
const DATA_FILE = path.join(OUTPUT_DIR, 'gallery-data.json');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

function generateGPSPoints() {
  const points = [];
  
  for (const [countryCode, config] of Object.entries(COUNTRIES)) {
    for (let i = 0; i < config.count; i++) {
      points.push({
        id: `${countryCode}-${i + 1}`,
        country: countryCode,
        lat: randomInRange(config.lat[0], config.lat[1]),
        lon: randomInRange(config.lon[0], config.lon[1])
      });
    }
  }
  
  // Shuffle the points
  for (let i = points.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [points[i], points[j]] = [points[j], points[i]];
  }
  
  return points;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

async function processPoint(point, index, total) {
  console.log(`[${index + 1}/${total}] Processing ${point.id} (${point.country})...`);
  
  try {
    // Step 1: Reverse geocode
    const geocodeUrl = `${BASE_URL}/api/reverse-geocode?lat=${point.lat}&lon=${point.lon}&limit=2&maxDistanceKm=150`;
    const geocodeData = await fetchJSON(geocodeUrl);
    
    if (!geocodeData.results || geocodeData.results.length === 0) {
      console.warn(`  ⚠️  No results for ${point.id}`);
      return null;
    }
    
    const results = geocodeData.results.slice(0, 2);
    
    // Step 2: Get polygons for each result
    const polygons = [];
    for (const result of results) {
      try {
        const polygonUrl = `${BASE_URL}/api/gadm-polygon?country=${result.country}&lat=${result.lat}&lon=${result.lon}`;
        const polygonData = await fetchJSON(polygonUrl);
        polygons.push({
          city: result,
          polygon: polygonData.feature
        });
      } catch (err) {
        console.warn(`  ⚠️  Failed to get polygon for ${result.name}: ${err.message}`);
        polygons.push({
          city: result,
          polygon: null
        });
      }
    }
    
    // Step 3: Get administrative area polygon for the GPS point itself
    console.log(`  [${point.id}] Starting admin area query...`);
    let adminArea = null;
    try {
      const countryCodeMap = {
        'US': 'usa', 'CA': 'canada', 'CO': 'colombia', 'DE': 'germany',
        'IN': 'india', 'AR': 'argentina', 'NL': 'netherlands',
        'GH': 'ghana', 'CH': 'switzerland', 'GB': 'scotland'
      };
      const countryCode = countryCodeMap[point.country] || point.country.toLowerCase();
      const adminUrl = `${BASE_URL}/api/gadm-polygon?country=${countryCode}&lat=${point.lat}&lon=${point.lon}`;
      const adminData = await fetchJSON(adminUrl);
      if (adminData.feature) {
        const name = adminData.feature.properties?.name || 
                    adminData.feature.properties?.tags?.name || 
                    adminData.feature.properties?.tags?.['name:en'] || 'Unknown';
        const population = adminData.feature.properties?.population || 
                          adminData.feature.properties?.tags?.population || null;
        adminArea = {
          polygon: adminData.feature,
          adminLevel: adminData.adminLevel,
          name: name,
          population: population ? parseInt(population, 10) : null
        };
      }
    } catch (err) {
      console.warn(`  [${point.id}] Admin area error: ${err.message}`);
    }
    
    return {
      point,
      geocode: geocodeData,
      polygons,
      adminArea: adminArea || null,
      metrics: geocodeData.metrics || null
    };
  } catch (error) {
    console.error(`  ❌ Error processing ${point.id}: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('🎯 Generating Locate Me Gallery');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Output directory: ${OUTPUT_DIR}\n`);
  
  // Generate GPS points
  console.log('📍 Generating 100 GPS points...');
  const points = generateGPSPoints();
  console.log(`   Generated ${points.length} points\n`);
  
  // Process each point
  console.log('🔄 Processing points through Locate-Me workflow...\n');
  const results = [];
  
  for (let i = 0; i < points.length; i++) {
    const result = await processPoint(points[i], i, points.length);
    if (result) {
      results.push(result);
    }
    
    // Small delay to avoid rate limiting
    if (i < points.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  console.log(`\n✅ Processed ${results.length}/${points.length} points successfully\n`);
  
  // Save data
  const galleryData = {
    generated: new Date().toISOString(),
    baseUrl: BASE_URL,
    total: results.length,
    results: results
  };
  
  fs.writeFileSync(DATA_FILE, JSON.stringify(galleryData, null, 2));
  console.log(`💾 Saved gallery data to ${DATA_FILE}`);
  console.log(`\n📸 Next step: Run 'node scripts/generate-gallery-images.js' to create images`);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { generateGPSPoints, processPoint };

