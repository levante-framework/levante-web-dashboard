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
const https = require('https');
const puppeteer = require('puppeteer');

const DATA_FILE = path.join(process.cwd(), 'public', 'gallery', 'locate-me', 'gallery-data.json');
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'gallery', 'locate-me', 'images');
const HTML_TEMPLATE = path.join(process.cwd(), 'scripts', 'gallery-image-template.html');

loadEnvFile(path.join(process.cwd(), '.env'));

let cachedMapboxToken = null;
const MAPBOX_STYLE_INPUT = process.env.MAPBOX_STYLE_ID || "";
const MAPBOX_STYLE_REFERENCE = MAPBOX_STYLE_INPUT && MAPBOX_STYLE_INPUT.includes('/')
  ? MAPBOX_STYLE_INPUT
  : null;

if (MAPBOX_STYLE_INPUT && !MAPBOX_STYLE_REFERENCE) {
  console.warn('[Mapbox] MAPBOX_STYLE_ID must include "username/styleId". Value ignored:', MAPBOX_STYLE_INPUT);
}

const USE_EXTERNAL_STYLE = Boolean(MAPBOX_STYLE_REFERENCE);

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function loadEnvFile(envPath) {
  try {
    if (!fs.existsSync(envPath)) {
      return;
    }
    const contents = fs.readFileSync(envPath, 'utf8');
    contents.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return;
      }
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        return;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (!key || key.startsWith('#')) {
        return;
      }
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
    console.log(`Loaded environment variables from ${path.basename(envPath)}`);
  } catch (error) {
    console.warn(`⚠️ Unable to load ${envPath}: ${error.message}`);
  }
}

function getMapboxToken() {
  if (cachedMapboxToken) {
    return cachedMapboxToken;
  }
  const token = (process.env.MAPBOX_ACCESS_TOKEN || '').trim();
  if (!token) {
    console.error('❌ MAPBOX_ACCESS_TOKEN not set. Add it to your shell or to a .env file next to this script.');
    console.error('   Example entry: MAPBOX_ACCESS_TOKEN=pk.xxxxxx');
    process.exit(1);
  }
  cachedMapboxToken = token;
  return cachedMapboxToken;
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

// Mapbox Static Images API helpers
function calculateZoomForWidth(lat, widthKm) {
  const degrees = widthKm / 111.0;
  const zoom = Math.log2(360 / degrees);
  return Math.round(zoom * 10) / 10;
}

// Simplify polygon coordinates using Douglas-Peucker algorithm
function simplifyPolygon(geometry, tolerance = 0.0001) {
  if (!geometry || !geometry.coordinates) return geometry;
  
  function simplifyRing(ring, tolerance) {
    if (ring.length <= 2) return ring;
    
    let maxDist = 0;
    let maxIndex = 0;
    const start = ring[0];
    const end = ring[ring.length - 1];
    
    for (let i = 1; i < ring.length - 1; i++) {
      const point = ring[i];
      const dist = pointToLineDistance(point, start, end);
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }
    
    if (maxDist > tolerance) {
      const left = simplifyRing(ring.slice(0, maxIndex + 1), tolerance);
      const right = simplifyRing(ring.slice(maxIndex), tolerance);
      return [...left.slice(0, -1), ...right];
    } else {
      return [start, end];
    }
  }
  
  function pointToLineDistance(point, lineStart, lineEnd) {
    const [x0, y0] = point;
    const [x1, y1] = lineStart;
    const [x2, y2] = lineEnd;
    
    const A = x0 - x1;
    const B = y0 - y1;
    const C = x2 - x1;
    const D = y2 - y1;
    
    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = lenSq !== 0 ? dot / lenSq : -1;
    
    let xx, yy;
    if (param < 0) {
      xx = x1; yy = y1;
    } else if (param > 1) {
      xx = x2; yy = y2;
    } else {
      xx = x1 + param * C;
      yy = y1 + param * D;
    }
    
    const dx = x0 - xx;
    const dy = y0 - yy;
    return Math.sqrt(dx * dx + dy * dy);
  }
  
  if (geometry.type === 'Polygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map(ring => simplifyRing(ring, tolerance))
    };
  } else if (geometry.type === 'MultiPolygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map(polygon =>
        polygon.map(ring => simplifyRing(ring, tolerance))
      )
    };
  }
  
  return geometry;
}

function buildGeoJSONOverlay(point, polygons, adminArea, options = {}) {
  const {
    includePolygons = true,
    includeAdminArea = true
  } = options;
  const features = [];
  
  // GPS point marker
  features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
    properties: { 'marker-color': '#da3d16', 'marker-size': 'large' }
  });
  
  // 2-mile circle (approximate as polygon)
  const radiusKm = 1.60934;
  const points = [];
  for (let i = 0; i < 64; i++) {
    const angle = (i / 64) * 2 * Math.PI;
    const latOffset = (radiusKm / 111.0) * Math.cos(angle);
    const lonOffset = (radiusKm / (111.0 * Math.cos(point.lat * Math.PI / 180))) * Math.sin(angle);
    points.push([point.lon + lonOffset, point.lat + latOffset]);
  }
  points.push(points[0]);
  features.push({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [points] },
    properties: { stroke: '#2563eb', 'stroke-width': 3, fill: '#2563eb', 'fill-opacity': 0.15 }
  });
  
  // Add city polygons
  if (includePolygons && polygons && polygons.length > 0) {
    polygons.forEach((p, idx) => {
      if (p.polygon && p.polygon.geometry) {
        const color = idx === 0 ? '#2563eb' : '#22c55e';
        features.push({
          type: 'Feature',
          geometry: simplifyPolygon(p.polygon.geometry, 0.0001),
          properties: { stroke: color, 'stroke-width': 4, fill: color, 'fill-opacity': 0.3 }
        });
      }
    });
  }
  
  // Admin area polygon
  if (includeAdminArea && adminArea && adminArea.polygon && adminArea.polygon.geometry) {
    features.push({
      type: 'Feature',
      geometry: simplifyPolygon(adminArea.polygon.geometry, 0.0001),
      properties: { stroke: '#dc2626', 'stroke-width': 4, fill: '#dc2626', 'fill-opacity': 0.25 }
    });
  }
  
  return { type: 'FeatureCollection', features };
}

function downloadMapboxStaticImage(point, polygons, adminArea, outputPath, token) {
  return new Promise((resolve, reject) => {
    const zoom = calculateZoomForWidth(point.lat, 40);
    const overlayOptions = USE_EXTERNAL_STYLE
      ? { includePolygons: false, includeAdminArea: false }
      : {};
    const overlay = buildGeoJSONOverlay(point, polygons, adminArea, overlayOptions);
    const overlayJson = JSON.stringify(overlay);
    const overlayEncoded = encodeURIComponent(overlayJson);

    if (!token) {
      const errorMsg = 'Mapbox token required. Set MAPBOX_ACCESS_TOKEN environment variable.';
      console.error(`    ❌ ${errorMsg}`);
      reject(new Error(errorMsg));
      return;
    }

    const polygonCount = overlay.features.filter(f => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon').length;
    if (USE_EXTERNAL_STYLE) {
      console.log(`    Building inline overlay: ${overlay.features.length} lightweight features (polygons served via Mapbox style)`);
    } else {
      console.log(`    Building overlay: ${overlay.features.length} features (${polygonCount} polygons)`);
    }

    function pipeResponse(res) {
      const file = fs.createWriteStream(outputPath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }

    if (USE_EXTERNAL_STYLE) {
      const overlaySegment = overlay.features.length ? `geojson(${overlayEncoded})/` : '';
      const url = `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE_REFERENCE}/static/${overlaySegment}${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;

      https.get(url, res => {
        if (res.statusCode === 200) {
          pipeResponse(res);
        } else {
          let errorBody = '';
          res.on('data', chunk => errorBody += chunk);
          res.on('end', () => {
            const errorMsg = errorBody.substring(0, 200);
            console.error(`    ❌ Mapbox style API ${res.statusCode}: ${errorMsg}`);
            reject(new Error(`Mapbox style API ${res.statusCode}: ${errorMsg}`));
          });
        }
      }).on('error', reject);

      return;
    }

    // Try progressively simpler tolerances if URL is too long
    let finalOverlay = overlay;
    let finalEncoded = overlayEncoded;
    let tolerance = 0.0001;
    const maxAttempts = 5;
    let simpleFallbackAttempted = false;

    function requestSimpleMap() {
      if (simpleFallbackAttempted) return;
      simpleFallbackAttempted = true;
      const simpleUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;
      console.warn('    ⚠️ Falling back to simple map without overlays');
      https.get(simpleUrl, res => handleResponse(res, { isSimple: true }))
        .on('error', reject);
    }

    function handleResponse(res, { isSimple = false } = {}) {
      if (res.statusCode === 200) {
        pipeResponse(res);
      } else {
        let errorBody = '';
        res.on('data', chunk => errorBody += chunk);
        res.on('end', () => {
          if (!isSimple && res.statusCode === 422 && !simpleFallbackAttempted) {
            console.warn('    ⚠️ Mapbox API 422 (Invalid GeoJSON). Retrying without overlays.');
            requestSimpleMap();
            return;
          }
          const errorMsg = errorBody.substring(0, 200);
          console.error(`    ❌ Mapbox API ${res.statusCode}: ${errorMsg}`);
          reject(new Error(`Mapbox API ${res.statusCode}: ${errorMsg}`));
        });
      }
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${finalEncoded})/${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;

      if (url.length <= 8000) {
        // URL is acceptable, use it
        if (attempt > 0) {
          console.log(`    ✅ Simplified polygons (tolerance: ${tolerance.toFixed(6)}) to fit URL (${url.length} chars)`);
        }
        https.get(url, res => handleResponse(res));
        return;
      }

      // URL too long, simplify more aggressively
      if (attempt < maxAttempts - 1) {
        tolerance *= 2; // Increase tolerance (simplify more)
        const simplifiedFeatures = finalOverlay.features.map(f => {
          if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
            return {
              ...f,
              geometry: simplifyPolygon(f.geometry, tolerance)
            };
          }
          return f;
        });
        finalOverlay = { type: 'FeatureCollection', features: simplifiedFeatures };
        finalEncoded = encodeURIComponent(JSON.stringify(finalOverlay));
      }
    }

    // If still too long after all attempts, use simple map
    console.warn(`    ⚠️ URL still too long after simplification (${finalEncoded.length} chars), using simple map without overlays`);
    requestSimpleMap();
  });
}
function createHTML(data) {
  const { point, geocode, polygons, adminArea } = data;
  const results = geocode.results.slice(0, 2);
  
  // Build polygon GeoJSON for map (nearest cities)
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
  
  // Admin area polygon (red) - smallest administrative area containing GPS point
  const adminAreaGeoJSON = adminArea && adminArea.polygon ? {
    type: 'Feature',
    properties: {
      name: adminArea.name,
      adminLevel: adminArea.adminLevel,
      population: adminArea.population
    },
    geometry: adminArea.polygon.geometry
  } : null;
  
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
    .card.admin-area {
      border-left: 4px solid #dc2626;
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
            /* Ensure scale control is visible */
            .leaflet-control-scale {
              background: rgba(255, 255, 255, 0.95) !important;
              border: 2px solid #000 !important;
              border-top: none !important;
              border-radius: 4px !important;
              padding: 5px 10px !important;
              font-weight: bold !important;
              box-shadow: 0 1px 5px rgba(0,0,0,0.4) !important;
              color: #000 !important;
              z-index: 1000 !important;
            }
            .leaflet-control-scale-line {
              border: 2px solid #000 !important;
              border-top: none !important;
              background: rgba(255, 255, 255, 0.95) !important;
              color: #000 !important;
              font-weight: bold !important;
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
    /* Ensure scale control is visible */
    .leaflet-control-scale {
      background: rgba(255, 255, 255, 0.95) !important;
      border: 2px solid #000 !important;
      border-top: none !important;
      border-radius: 4px !important;
      padding: 5px 10px !important;
      font-weight: bold !important;
      box-shadow: 0 1px 5px rgba(0,0,0,0.4) !important;
      color: #000 !important;
      z-index: 1000 !important;
    }
    .leaflet-control-scale-line {
      border: 2px solid #000 !important;
      border-top: none !important;
      background: rgba(255, 255, 255, 0.95) !important;
      color: #000 !important;
      font-weight: bold !important;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="cards">
      ${adminArea ? `
        <div class="card admin-area">
          <h3>🗺️ Administrative Area</h3>
          <div class="location">${adminArea.name}</div>
          <div class="details">
            Admin Level: ${adminArea.adminLevel}
            ${adminArea.population ? ` · Pop: ${adminArea.population.toLocaleString()}` : ''}
          </div>
        </div>
      ` : ''}
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
    function formatDistanceKm(km) {
      if (km < 1) return (km * 1000).toFixed(0) + ' m';
      return km.toFixed(1) + ' km';
    }
    
    const point = ${JSON.stringify(point)};
    const polygons = ${JSON.stringify(polygonGeoJSON)};
    const adminAreaPolygon = ${adminAreaGeoJSON ? JSON.stringify(adminAreaGeoJSON) : 'null'};
    
    // Initialize map - will fit bounds after adding features
    const map = L.map('map').setView([point.lat, point.lon], 10);
    
    // Add tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
    
    // Add scale control with better visibility
    L.control.scale({
      metric: true,
      imperial: false,
      position: 'bottomleft',
      maxWidth: 200
    }).addTo(map);
    
    // Wait for map to be ready
    map.whenReady(function() {
      // Add GPS point marker
      const marker = L.circleMarker([point.lat, point.lon], {
        radius: 8,
        fillColor: '#da3d16',
        color: '#fff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.8
      }).addTo(map).bindPopup('GPS Location');
      
      // Add blue 2-mile diameter circle (1 mile radius = 1609.34 meters)
      const twoMileCircle = L.circle([point.lat, point.lon], {
        radius: 1609.34,
        color: '#2563eb',
        fillColor: '#2563eb',
        fillOpacity: 0.15,
        weight: 3,
        dashArray: '8, 4'
      }).addTo(map).bindPopup('2-mile radius');
      
      // Add circle around GPS point (20km radius to match filter)
      const circle = L.circle([point.lat, point.lon], {
        radius: 20000,
        color: '#da3d16',
        fillColor: '#da3d16',
        fillOpacity: 0.1,
        weight: 2,
        dashArray: '5, 5'
      }).addTo(map);
      
      // Add administrative area polygon (red) - smallest admin area containing GPS point
      let adminAreaLayer = null;
      if (adminAreaPolygon && adminAreaPolygon.geometry) {
        try {
          adminAreaLayer = L.geoJSON(adminAreaPolygon, {
            style: {
              color: '#dc2626',
              weight: 4,
              opacity: 1.0,
              fillColor: '#dc2626',
              fillOpacity: 0.25
            }
          }).addTo(map);
          
          if (adminAreaPolygon.properties && adminAreaPolygon.properties.name) {
            adminAreaLayer.bindPopup(adminAreaPolygon.properties.name + ' (Admin Area)');
          }
          console.log('Added admin area polygon:', adminAreaPolygon.properties?.name || 'unknown');
        } catch (e) {
          console.error('Failed to add admin area polygon:', e);
        }
      }
      
      // Add polygons with more visible styling
      const polygonLayers = [];
      let polygonCount = 0;
      
      polygons.features.forEach((feature, idx) => {
        if (!feature || !feature.geometry) {
          console.warn('Skipping feature without geometry:', idx);
          return;
        }
        const color = idx === 0 ? '#2563eb' : '#22c55e';
        try {
          const layer = L.geoJSON(feature, {
            style: {
              color: color,
              weight: 4,  // Thicker lines for visibility
              opacity: 1.0,  // Full opacity
              fillColor: color,
              fillOpacity: 0.3  // More visible fill
            }
          }).addTo(map);
          
          // Add popup if we have name
          if (feature.properties && feature.properties.name) {
            layer.bindPopup(feature.properties.name + ' (' + formatDistanceKm(feature.properties.distance) + ')');
          }
          
          polygonLayers.push(layer);
          polygonCount++;
          console.log('Added polygon', idx, 'for', feature.properties?.name || 'unknown');
        } catch (e) {
          console.error('Failed to add polygon:', e, feature);
        }
      });
      
      console.log('Total polygons added:', polygonCount, 'out of', polygons.features.length);
      
      // Wait for layers to be added and rendered, then calculate bounds
      setTimeout(function() {
      // Set view to show exactly 40km across (20km radius from center)
      setTimeout(function() {
        // Calculate bounds for 40km width (20km radius)
        // At the equator, 1 degree latitude ≈ 111km, so 20km ≈ 0.18 degrees
        // Longitude varies by latitude: 1 degree ≈ 111km * cos(latitude)
        const lat = point.lat;
        const lon = point.lon;
        const radiusKm = 20; // 20km radius = 40km width
        
        // Approximate degrees for latitude (constant)
        const latDegrees = radiusKm / 111.0;
        
        // Approximate degrees for longitude (varies by latitude)
        const lonDegrees = radiusKm / (111.0 * Math.cos(lat * Math.PI / 180));
        
        // Create bounds centered on GPS point with 40km width
        const bounds = L.latLngBounds(
          [lat - latDegrees, lon - lonDegrees], // Southwest
          [lat + latDegrees, lon + lonDegrees]  // Northeast
        );
        
        // Fit map to show exactly 40km across
        map.fitBounds(bounds, {
          padding: [20, 20], // Small padding
          maxZoom: 12,        // Don't zoom in too close
          minZoom: 8          // Don't zoom out too far
        });
        
        console.log('Set view to 40km width centered on', lat.toFixed(4), lon.toFixed(4));
            const validLayers = [];
            for (let i = 0; i < polygonLayers.length; i++) {
              try {
                const layer = polygonLayers[i];
                const b = layer.getBounds();
                if (b && b.isValid() && !b.isFlat()) {
                  const sw = b.getSouthWest();
                  const ne = b.getNorthEast();
                  const latSpan = Math.abs(ne.lat - sw.lat);
                  const lonSpan = Math.abs(ne.lng - sw.lng);
                  console.log('Polygon', i, 'bounds:', latSpan.toFixed(4), 'x', lonSpan.toFixed(4));
                  
                  // Be less strict - allow larger polygons (cities can be big)
                  // Only filter out truly invalid or tiny bounds
                  if (latSpan > 0.00001 && lonSpan > 0.00001 && latSpan < 50 && lonSpan < 50) {
                    validLayers.push(layer);
                  } else {
                    console.warn('Filtered out polygon', i, 'due to bounds:', latSpan, lonSpan);
                  }
                } else {
                  console.warn('Polygon', i, 'has invalid bounds');
                }
              } catch (e) {
                console.error('Error getting bounds for polygon', i, ':', e);
              }
            }
            
            console.log('Valid layers:', validLayers.length);
            
            if (validLayers.length > 0) {
              // Create a group with marker, 2-mile circle, admin area, and all valid polygons
              const allFeatures = [marker, twoMileCircle];
              if (adminAreaLayer) allFeatures.push(adminAreaLayer);
              allFeatures.push(...validLayers);
              const group = L.featureGroup(allFeatures);
              
              try {
                const bounds = group.getBounds();
                console.log('Group bounds:', bounds.isValid() ? 'valid' : 'invalid');
                
                if (bounds && bounds.isValid() && !bounds.isFlat()) {
                  const sw = bounds.getSouthWest();
                  const ne = bounds.getNorthEast();
                  const latSpan = Math.abs(ne.lat - sw.lat);
                  const lonSpan = Math.abs(ne.lng - sw.lng);
                  
                  console.log('Fitting bounds with span:', latSpan.toFixed(4), 'x', lonSpan.toFixed(4));
                  
                  // Ensure bounds are reasonable
                  if (latSpan > 0.00001 && lonSpan > 0.00001) {
                    // Fit bounds with generous padding to ensure polygons are visible
                    map.fitBounds(bounds.pad(0.5), { 
                      maxZoom: 16,  // Allow closer zoom
                      minZoom: 8,   // Allow wider view
                      padding: [60, 60]  // Even more padding
                    });
                    boundsSet = true;
                    console.log('Bounds set successfully');
                  } else {
                    console.warn('Bounds span too small:', latSpan, lonSpan);
                  }
                } else {
                  console.warn('Group bounds invalid or flat');
                }
              } catch (e) {
                console.error('Error fitting bounds:', e);
              }
            } else {
              console.warn('No valid layers found, falling back to circle');
            }
          } else {
            console.log('No polygons to display');
          }
          
          // If no polygons or bounds failed, zoom to show the circles nicely
          if (!boundsSet) {
            console.log('Using circle fallback');
            try {
              // Prefer showing the 2-mile circle
              const circleBounds = twoMileCircle.getBounds();
              if (circleBounds && circleBounds.isValid()) {
                // Fit to 2-mile circle with padding
                map.fitBounds(circleBounds.pad(0.3), { 
                  maxZoom: 13,
                  minZoom: 9
                });
              } else {
                // Fallback to 20km circle
                const fallbackBounds = circle.getBounds();
                if (fallbackBounds && fallbackBounds.isValid()) {
                  map.fitBounds(fallbackBounds.pad(0.3), { 
                    maxZoom: 13,
                    minZoom: 9
                  });
                } else {
                  // Last resort: set a reasonable zoom level centered on point
                  map.setView([point.lat, point.lon], 11);
                }
              }
            } catch (e) {
              console.error('Circle fallback error:', e);
              // Fallback: set view directly
              map.setView([point.lat, point.lon], 11);
            }
          }
        } catch (e) {
          console.error('Bounds calculation error:', e);
          // Fallback on any error - ensure we at least show the point
          map.setView([point.lat, point.lon], 11);
        }
        
        // Signal that map is ready after bounds are set
        // Give extra time for tiles and polygons to render
        setTimeout(function() {
          console.log('Map ready signal sent');
          window.mapReady = true;
        }, 1000);
      });
    });
  </script>
</body>
</html>`;
}

async function generateImage(data, index, total, mapboxTokenOverride) {
  const { point, polygons = [], adminArea } = data;
  const imageFile = path.join(OUTPUT_DIR, `${point.id}.png`);
  const mapboxToken = mapboxTokenOverride || getMapboxToken();
  try {
    console.log(`  [${index + 1}/${total}] Downloading map for ${point.id}...`);
    await downloadMapboxStaticImage(point, polygons, adminArea, imageFile, mapboxToken);
    console.log(`[${index + 1}/${total}] ✅ Generated ${point.id}.png`);
  } catch (error) {
    console.error(`  ❌ Error generating ${point.id}:`, error.message);
    throw error;
  }
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
  console.log(`Filtered out: ${allResults.length - resultsWithPolygons.length} results without polygons\n`);
  console.log(`Processing ${resultsWithPolygons.length} results with polygons...\n`);
  
  const mapboxToken = getMapboxToken();
  
  for (let i = 0; i < resultsWithPolygons.length; i++) {
    await generateImage(resultsWithPolygons[i], i, resultsWithPolygons.length, mapboxToken);
  }
  
  console.log(`\n✅ Generated ${resultsWithPolygons.length} images in ${OUTPUT_DIR}`);
  console.log(`\n📄 Next step: Open public/gallery/locate-me/index.html to view the gallery`);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { generateImage, createHTML };

