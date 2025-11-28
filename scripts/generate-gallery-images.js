#!/usr/bin/env node

/**
 * Generate Gallery Images
 * 
 * Takes the gallery data and generates images showing:
 * - Two location cards with city info
 * - Map with GPS point, circle, and polygons
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const DATA_FILE = path.join(process.cwd(), 'public', 'gallery', 'locate-me', 'gallery-data.json');
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'gallery', 'locate-me', 'images');
const HTML_TEMPLATE = path.join(process.cwd(), 'scripts', 'gallery-image-template.html');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function formatDistance(km) {
  if (km < 1) return `${(km * 1000).toFixed(0)} m`;
  return `${km.toFixed(1)} km`;
}

function formatBytes(bytes) {
  if (!bytes) return 'N/A';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function createHTML(data) {
  const { point, geocode, polygons } = data;
  const results = geocode.results.slice(0, 2);
  
  // Build polygon GeoJSON for map
  const polygonFeatures = polygons
    .filter(p => p.polygon)
    .map((p, idx) => ({
      type: 'Feature',
      properties: {
        name: p.city.name,
        distance: p.city.distanceKm,
        index: idx
      },
      geometry: p.polygon.geometry
    }));
  
  const polygonGeoJSON = {
    type: 'FeatureCollection',
    features: polygonFeatures
  };
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Locate Me - ${point.id}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: Inter, system-ui, -apple-system, sans-serif;
      background: #fafafa;
      padding: 20px;
      width: 1200px;
      margin: 0 auto;
    }
    .container {
      display: flex;
      gap: 20px;
      margin-bottom: 20px;
    }
    .cards {
      display: flex;
      flex-direction: column;
      gap: 12px;
      width: 300px;
    }
    .card {
      background: white;
      border-radius: 8px;
      padding: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      border: 1px solid #e4e4e7;
    }
    .card h3 {
      font-size: 18px;
      font-weight: 600;
      color: #27272a;
      margin-bottom: 8px;
    }
    .card .location {
      color: #71717a;
      font-size: 14px;
      margin-bottom: 8px;
    }
    .card .distance {
      color: #da3d16;
      font-weight: 600;
      font-size: 16px;
    }
    .card .details {
      margin-top: 8px;
      font-size: 12px;
      color: #71717a;
    }
    .map-container {
      flex: 1;
      height: 400px;
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      border: 1px solid #e4e4e7;
    }
    #map {
      width: 100%;
      height: 100%;
    }
    .info {
      background: white;
      border-radius: 8px;
      padding: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      border: 1px solid #e4e4e7;
      font-size: 12px;
      color: #71717a;
    }
    .info strong {
      color: #27272a;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="cards">
      ${results.map((result, idx) => `
        <div class="card">
          <h3>${idx === 0 ? '📍 Nearest' : '📍 Second'}</h3>
          <div class="location">${result.name}</div>
          <div class="distance">${formatDistance(result.distanceKm)} away</div>
          <div class="details">
            ${result.admin1 ? `${result.admin1}, ` : ''}${result.country}
            ${result.population ? ` · Pop: ${result.population.toLocaleString()}` : ''}
          </div>
        </div>
      `).join('')}
    </div>
    <div class="map-container">
      <div id="map"></div>
    </div>
  </div>
  <div class="info">
    <strong>GPS Point:</strong> ${point.lat.toFixed(6)}, ${point.lon.toFixed(6)} 
    <strong>· Country:</strong> ${point.country}
    <strong>· ID:</strong> ${point.id}
  </div>
  
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const point = ${JSON.stringify(point)};
    const polygons = ${JSON.stringify(polygonGeoJSON)};
    
    // Initialize map centered on GPS point
    const map = L.map('map').setView([point.lat, point.lon], 12);
    
    // Add tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
    
    // Add GPS point marker
    L.circleMarker([point.lat, point.lon], {
      radius: 8,
      fillColor: '#da3d16',
      color: '#fff',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.8
    }).addTo(map).bindPopup('GPS Location');
    
    // Add circle around GPS point (150km radius)
    L.circle([point.lat, point.lon], {
      radius: 150000,
      color: '#da3d16',
      fillColor: '#da3d16',
      fillOpacity: 0.1,
      weight: 2,
      dashArray: '5, 5'
    }).addTo(map);
    
    // Add polygons
    polygons.features.forEach((feature, idx) => {
      const color = idx === 0 ? '#2563eb' : '#22c55e';
      L.geoJSON(feature, {
        style: {
          color: color,
          weight: 3,
          opacity: 0.8,
          fillColor: color,
          fillOpacity: 0.2
        }
      }).addTo(map).bindPopup(feature.properties.name + ' (' + formatDistance(feature.properties.distance) + ')');
    });
    
    // Fit map to show all features
    const group = new L.featureGroup([
      L.marker([point.lat, point.lon]),
      ...polygons.features.map(f => L.geoJSON(f))
    ]);
    map.fitBounds(group.getBounds().pad(0.1));
    
    function formatDistance(km) {
      if (km < 1) return (km * 1000).toFixed(0) + ' m';
      return km.toFixed(1) + ' km';
    }
  </script>
</body>
</html>`;
}

async function generateImage(data, index, total) {
  const { point } = data;
  const html = createHTML(data);
  const htmlFile = path.join(OUTPUT_DIR, `${point.id}.html`);
  const imageFile = path.join(OUTPUT_DIR, `${point.id}.png`);
  
  // Write HTML file
  fs.writeFileSync(htmlFile, html);
  
  // Launch browser and take screenshot
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 500 });
    await page.goto(`file://${htmlFile}`, { waitUntil: 'networkidle0' });
    
    // Wait for map to load
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Take screenshot
    await page.screenshot({
      path: imageFile,
      fullPage: false,
      type: 'png'
    });
    
    console.log(`[${index + 1}/${total}] ✅ Generated ${point.id}.png`);
  } finally {
    await browser.close();
  }
  
  // Clean up HTML file
  fs.unlinkSync(htmlFile);
}

async function main() {
  console.log('📸 Generating Gallery Images\n');
  
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ Data file not found: ${DATA_FILE}`);
    console.error('   Run "node scripts/generate-locate-me-gallery.js" first');
    process.exit(1);
  }
  
  const galleryData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const allResults = galleryData.results;
  
  // Filter to only include results with polygons
  const resultsWithPolygons = allResults.filter(result => {
    return result.polygons && result.polygons.some(p => p.polygon && p.polygon.geometry);
  });
  
  console.log(`Total results: ${allResults.length}`);
  console.log(`Results with polygons: ${resultsWithPolygons.length}`);
  console.log(`Filtered out: ${allResults.length - resultsWithPolygons.length} results without polygons
`);
  console.log(`Processing ${resultsWithPolygons.length} results with polygons...
`);
  
  for (let i = 0; i < resultsWithPolygons.length; i++) {
    await generateImage(resultsWithPolygons[i], i, resultsWithPolygons.length);
  }
  
  console.log(`
✅ Generated ${resultsWithPolygons.length} images in ${OUTPUT_DIR}`);
  console.log(`\n📄 Next step: Open public/gallery/locate-me/index.html to view the gallery`);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { generateImage, createHTML };

