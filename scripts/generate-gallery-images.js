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
const sharp = require('sharp');

// Load environment variables from .env file if it exists
// Use process.cwd() to find .env in project root
console.log('[DEBUG] About to load dotenv...');
try {
  const dotenv = require('dotenv');
  // Load from project root (where script is run from)
  const envPath = path.join(process.cwd(), '.env');
  console.log('[DEBUG] Loading .env from:', envPath);
  const result = dotenv.config({ path: envPath });
  console.log('[DEBUG] dotenv result:', result.parsed ? 'SUCCESS' : 'FAILED', result.error ? result.error.message : '');
  if (result.error) {
    console.warn('[dotenv] Error loading .env:', result.error.message);
  } else if (result.parsed && process.env.MAPBOX_ACCESS_TOKEN) {
    console.log(`[dotenv] Loaded MAPBOX_ACCESS_TOKEN from .env`);
  } else {
    console.warn('[dotenv] Token not found in parsed result');
  }
  console.log('[DEBUG] Token after dotenv:', process.env.MAPBOX_ACCESS_TOKEN ? 'FOUND' : 'NOT FOUND');
} catch (e) {
  // dotenv not installed or .env file doesn't exist - that's okay
  console.warn('[dotenv] Failed to load:', e.message);
}

const DATA_FILE = path.join(process.cwd(), 'public', 'gallery', 'locate-me', 'gallery-data.json');
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'gallery', 'locate-me', 'images');

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

// Mapbox Static Images API helpers
function calculateZoomForWidth(lat, widthKm) {
  const degrees = widthKm / 111.0;
  const zoom = Math.log2(360 / degrees);
  return Math.round(zoom * 10) / 10;
}

// Douglas-Peucker algorithm for polygon simplification
function simplifyPolygon(geometry, tolerance = 0.0001) {
  if (!geometry || !geometry.coordinates) return geometry;

  // Helper function for uniform sampling - non-recursive
  const uniformSample = (ring, maxPoints = 20) => {
    if (!ring || ring.length <= maxPoints) return ring;
    const step = Math.max(1, Math.floor(ring.length / maxPoints));
    const sampled = [];
    for (let i = 0; i < ring.length - 1; i += step) {
      sampled.push(ring[i]);
    }
    const lastPt = ring[ring.length - 1];
    if (sampled.length === 0 || 
        Math.abs(sampled[sampled.length - 1][0] - lastPt[0]) > 0.000001 ||
        Math.abs(sampled[sampled.length - 1][1] - lastPt[1]) > 0.000001) {
      sampled.push(lastPt);
    }
    const firstPt = sampled[0];
    const finalLast = sampled[sampled.length - 1];
    if (Math.abs(firstPt[0] - finalLast[0]) > 0.000001 || Math.abs(firstPt[1] - finalLast[1]) > 0.000001) {
      sampled.push([firstPt[0], firstPt[1]]);
    }
    return sampled.length >= 4 ? sampled : ring;
  };

  const simplifyRing = (ring, maxDepth = 5, depth = 0) => {
    // For rings > 100 points, skip Douglas-Peucker entirely - use uniform sampling immediately
    if (ring && ring.length > 100) {
      return uniformSample(ring, 20);
    }
    
    // For rings > 50 points at any depth, use uniform sampling
    if (ring && ring.length > 50 && depth > 0) {
      return uniformSample(ring, 20);
    }
    
    // Prevent infinite recursion - use uniform sampling immediately (suppress warning)
    if (depth > maxDepth) {
      return uniformSample(ring, 20);
    }
    
    // For any ring at depth > 2, use uniform sampling
    if (depth > 2) {
      return uniformSample(ring, 20);
    }
    
    // Ensure ring has at least 4 points (needed for valid Polygon)
    if (!ring || ring.length < 4) return ring;
    
    // Validate and clean coordinates first
    const cleanedRing = ring.filter(coord => {
      if (!Array.isArray(coord) || coord.length < 2) return false;
      const [lon, lat] = coord;
      return typeof lon === 'number' && typeof lat === 'number' &&
             isFinite(lon) && isFinite(lat) &&
             lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
    });
    
    if (cleanedRing.length < 4) return ring; // Can't simplify if too few valid points
    
    // Ensure ring is closed (first and last point match) - use tolerance for comparison
    const first = cleanedRing[0];
    const last = cleanedRing[cleanedRing.length - 1];
    const lonDiff = Math.abs(first[0] - last[0]);
    const latDiff = Math.abs(first[1] - last[1]);
    const isClosed = lonDiff < 0.000001 && latDiff < 0.000001;
    const workingRing = isClosed ? cleanedRing : [...cleanedRing, first];
    
    // For very high tolerance (>= 0.1), use uniform sampling instead of Douglas-Peucker
    if (tolerance >= 0.1) {
      // Use uniform sampling with fewer points for high tolerance
      const maxPoints = tolerance >= 1.0 ? 20 : (tolerance >= 0.5 ? 25 : 30);
      return uniformSample(workingRing, maxPoints);
    }
    
    // For rings > 50 points, skip Douglas-Peucker and use uniform sampling
    if (workingRing.length > 50) {
      return uniformSample(workingRing, 20);
    }
    
    // If ring is already minimal, return as-is (but ensure closed)
    if (workingRing.length <= 4) {
      const firstPt = workingRing[0];
      const lastPt = workingRing[workingRing.length - 1];
      const closed = (Math.abs(firstPt[0] - lastPt[0]) < 0.000001 && Math.abs(firstPt[1] - lastPt[1]) < 0.000001)
        ? workingRing 
        : [...workingRing.slice(0, -1), firstPt];
      return closed;
    }
    
    let maxDistance = 0;
    let index = 0;
    const start = workingRing[0];
    const end = workingRing[workingRing.length - 1];

    for (let i = 1; i < workingRing.length - 1; i++) {
      const d = pointToLineDistance(workingRing[i], start, end);
      if (d > maxDistance) {
        maxDistance = d;
        index = i;
      }
    }

    if (maxDistance > tolerance) {
      // Ensure slices are actually smaller to prevent infinite recursion
      const slice1 = workingRing.slice(0, index + 1);
      const slice2 = workingRing.slice(index);
      
      // Safety check: if slices aren't getting smaller, use uniform sampling
      if (slice1.length >= workingRing.length || slice2.length >= workingRing.length) {
        return uniformSample(workingRing, 20);
      }
      
      // Safety check: if ring is still very large after slicing, use uniform sampling
      if (slice1.length > 100 || slice2.length > 100 || workingRing.length > 150) {
        return uniformSample(workingRing, 20);
      }
      
      // Additional safety: if we're already deep in recursion, use uniform sampling
      if (depth > 1) {
        return uniformSample(workingRing, 20);
      }
      
      const rec1 = simplifyRing(slice1, maxDepth, depth + 1);
      const rec2 = simplifyRing(slice2, maxDepth, depth + 1);
      // Merge: remove duplicate point at junction
      const simplified = [...rec1.slice(0, -1), ...rec2];
      // Ensure closed and at least 4 points
      const firstPt = simplified[0];
      const lastPt = simplified[simplified.length - 1];
      const closed = (Math.abs(firstPt[0] - lastPt[0]) < 0.000001 && Math.abs(firstPt[1] - lastPt[1]) < 0.000001)
        ? simplified 
        : [...simplified, firstPt];
      return closed.length >= 4 ? closed : ring;
    } else {
      // Keep at least 4 points (start, 2 points, close)
      const minimal = [workingRing[0], workingRing[1], workingRing[workingRing.length - 2], workingRing[workingRing.length - 1]];
      // Ensure closed
      const firstPt = minimal[0];
      const lastPt = minimal[minimal.length - 1];
      return (Math.abs(firstPt[0] - lastPt[0]) < 0.000001 && Math.abs(firstPt[1] - lastPt[1]) < 0.000001)
        ? minimal 
        : [...minimal, firstPt];
    }
  };

  const pointToLineDistance = (point, lineStart, lineEnd) => {
    const x = point[0];
    const y = point[1];
    const x1 = lineStart[0];
    const y1 = lineStart[1];
    const x2 = lineEnd[0];
    const y2 = lineEnd[1];

    const A = x - x1;
    const B = y - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const len_sq = C * C + D * D;
    let param = -1;
    if (len_sq !== 0) {
      param = dot / len_sq;
    }

    let xx, yy;
    if (param < 0) {
      xx = x1;
      yy = y1;
    } else if (param > 1) {
      xx = x2;
      yy = y2;
    } else {
      xx = x1 + param * C;
      yy = y1 + param * D;
    }

    const dx = x - xx;
    const dy = y - yy;
    return Math.sqrt(dx * dx + dy * dy);
  };

  if (geometry.type === 'Polygon') {
    const simplified = geometry.coordinates.map(ring => simplifyRing(ring, 5, 0));
    // Validate: ensure all rings have at least 4 points and are closed
    const validRings = simplified.filter(ring => {
      if (!ring || ring.length < 4) return false;
      // Ensure ring is closed
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) return false;
      // Validate all coordinates
      return ring.every(coord => {
        if (!Array.isArray(coord) || coord.length < 2) return false;
        const [lon, lat] = coord;
        return typeof lon === 'number' && typeof lat === 'number' &&
               isFinite(lon) && isFinite(lat) &&
               lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
      });
    });
    if (validRings.length === 0) {
      // Return original if simplification made it invalid
      return geometry;
    }
    return {
      type: 'Polygon',
      coordinates: validRings
    };
  } else if (geometry.type === 'MultiPolygon') {
    const simplified = geometry.coordinates.map(poly => poly.map(ring => simplifyRing(ring, 5, 0)));
    // Validate: ensure all polygons have at least one valid ring
    const validPolygons = simplified.filter(poly => {
      if (!poly || poly.length === 0) return false;
      return poly.some(ring => {
        if (!ring || ring.length < 4) return false;
        // Ensure ring is closed - allow small floating point differences
        const first = ring[0];
        const last = ring[ring.length - 1];
        const lonDiff = Math.abs(first[0] - last[0]);
        const latDiff = Math.abs(first[1] - last[1]);
        if (lonDiff > 0.000001 || latDiff > 0.000001) return false; // Allow tiny floating point differences
        // Validate coordinates
        return ring.every(coord => {
          if (!Array.isArray(coord) || coord.length < 2) return false;
          const [lon, lat] = coord;
          return typeof lon === 'number' && typeof lat === 'number' &&
                 isFinite(lon) && isFinite(lat) &&
                 lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
        });
      });
    });
    if (validPolygons.length === 0) {
      // Return original if simplification made it invalid
      return geometry;
    }
    return {
      type: 'MultiPolygon',
      coordinates: validPolygons
    };
  }
  return geometry;
}

// Fix common polygon geometry issues
function fixPolygonGeometry(geometry) {
  if (!geometry || !geometry.coordinates) return geometry;
  
  const fixRing = (ring) => {
    if (!Array.isArray(ring) || ring.length < 3) return ring;
    
    // Filter invalid coordinates
    const valid = ring.filter(coord => {
      if (!Array.isArray(coord) || coord.length < 2) return false;
      const [lon, lat] = coord;
      return typeof lon === 'number' && typeof lat === 'number' &&
             isFinite(lon) && isFinite(lat) &&
             lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
    });
    
    if (valid.length < 4) return ring; // Need at least 4 points for valid polygon
    
    // Ensure ring is closed - check with tolerance for floating point precision
    const first = valid[0];
    const last = valid[valid.length - 1];
    const lonDiff = Math.abs(first[0] - last[0]);
    const latDiff = Math.abs(first[1] - last[1]);
    if (lonDiff > 0.000001 || latDiff > 0.000001) {
      return [...valid, first];
    }
    return valid;
  };
  
  if (geometry.type === 'Polygon') {
    const fixed = geometry.coordinates.map(fixRing).filter(ring => ring && ring.length >= 4);
    if (fixed.length === 0) return geometry;
    return { type: 'Polygon', coordinates: fixed };
  }
  
  if (geometry.type === 'MultiPolygon') {
    const fixed = geometry.coordinates.map(poly => 
      poly.map(fixRing).filter(ring => ring && ring.length >= 4)
    ).filter(poly => poly.length > 0);
    if (fixed.length === 0) return geometry;
    return { type: 'MultiPolygon', coordinates: fixed };
  }
  
  return geometry;
}

// Validate GeoJSON feature with comprehensive checks
function isValidGeoJSONFeature(feature) {
  if (!feature || !feature.geometry) return false;
  const geom = feature.geometry;
  
  // Check for valid geometry type
  const validTypes = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon'];
  if (!geom.type || !validTypes.includes(geom.type)) return false;
  
  if (!geom.coordinates || !Array.isArray(geom.coordinates)) return false;
  
  if (geom.type === 'Polygon') {
    if (geom.coordinates.length === 0) return false;
    // Check each ring
    for (const ring of geom.coordinates) {
      if (!Array.isArray(ring) || ring.length < 4) return false;
      // Check that coordinates are valid numbers
      for (const coord of ring) {
        if (!Array.isArray(coord) || coord.length < 2) return false;
        const [lon, lat] = coord;
        if (typeof lon !== 'number' || typeof lat !== 'number' || 
            !isFinite(lon) || !isFinite(lat) ||
            lon < -180 || lon > 180 || lat < -90 || lat > 90) {
          return false;
        }
      }
      // Check that first and last coordinates match (closed ring) - allow small floating point differences
      const first = ring[0];
      const last = ring[ring.length - 1];
      const lonDiff = Math.abs(first[0] - last[0]);
      const latDiff = Math.abs(first[1] - last[1]);
      if (lonDiff > 0.000001 || latDiff > 0.000001) return false; // Allow tiny floating point differences
    }
    return true;
  }
  
  if (geom.type === 'MultiPolygon') {
    if (geom.coordinates.length === 0) return false;
    for (const poly of geom.coordinates) {
      if (!Array.isArray(poly) || poly.length === 0) return false;
      for (const ring of poly) {
        if (!Array.isArray(ring) || ring.length < 4) return false;
        // Validate coordinates
        for (const coord of ring) {
          if (!Array.isArray(coord) || coord.length < 2) return false;
          const [lon, lat] = coord;
          if (typeof lon !== 'number' || typeof lat !== 'number' || 
              !isFinite(lon) || !isFinite(lat) ||
              lon < -180 || lon > 180 || lat < -90 || lat > 90) {
            return false;
          }
        }
        // Check closed ring - allow small floating point differences
        const first = ring[0];
        const last = ring[ring.length - 1];
        const lonDiff = Math.abs(first[0] - last[0]);
        const latDiff = Math.abs(first[1] - last[1]);
        if (lonDiff > 0.000001 || latDiff > 0.000001) return false; // Allow tiny floating point differences
      }
    }
    return true;
  }
  
  // Point - validate coordinates
  if (geom.type === 'Point') {
    if (!Array.isArray(geom.coordinates) || geom.coordinates.length < 2) return false;
    const [lon, lat] = geom.coordinates;
    return typeof lon === 'number' && typeof lat === 'number' && 
           isFinite(lon) && isFinite(lat) &&
           lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
  }
  
  // LineString - validate coordinates
  if (geom.type === 'LineString') {
    if (!Array.isArray(geom.coordinates) || geom.coordinates.length < 2) return false;
    return geom.coordinates.every(coord => {
      if (!Array.isArray(coord) || coord.length < 2) return false;
      const [lon, lat] = coord;
      return typeof lon === 'number' && typeof lat === 'number' && 
             isFinite(lon) && isFinite(lat) &&
             lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
    });
  }
  
  // Other types - basic validation
  return true;
}

function geometryToBoundingBoxPolygon(geometry) {
  if (!geometry || !geometry.coordinates) return null;

  const collectPoints = coords => {
    if (!coords) return [];
    if (typeof coords[0] === 'number') {
      const [lon, lat] = coords;
      if (isFinite(lon) && isFinite(lat)) {
        return [[lon, lat]];
      }
      return [];
    }
    return coords.flatMap(collectPoints);
  };

  const points = collectPoints(geometry.coordinates);
  if (!points.length) return null;

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  if (!isFinite(minLon) || !isFinite(maxLon) || !isFinite(minLat) || !isFinite(maxLat)) {
    return null;
  }

  // Expand bbox slightly so zero-width polygons still render
  const padding = 0.001;
  minLon -= padding;
  maxLon += padding;
  minLat -= padding;
  maxLat += padding;

  const ring = [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat]
  ];
  return { type: 'Polygon', coordinates: [ring] };
}

function createBoundingBoxFeature(geometry, stroke, fillOpacity) {
  if (!geometry) return null;
  const bboxPolygon = geometryToBoundingBoxPolygon(geometry);
  if (!bboxPolygon) return null;
  return {
    type: 'Feature',
    geometry: bboxPolygon,
    properties: {
      stroke,
      'stroke-width': 2,
      'stroke-opacity': 0.9,
      fill: stroke,
      'fill-opacity': fillOpacity
    }
  };
}

function buildGeoJSONOverlay(point, polygons, adminArea) {
  const features = [];
  
  // GPS point marker
  features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
    properties: { 'marker-color': '#da3d16', 'marker-size': 'large' }
  });
  
  // 2-mile circle (approximate as polygon) - reduced to 32 points to save space
  const radiusKm = 1.60934;
  const points = [];
  const circlePoints = 32; // Reduced from 64 to save URL space
  for (let i = 0; i < circlePoints; i++) {
    const angle = (i / circlePoints) * 2 * Math.PI;
    const latOffset = (radiusKm / 111.0) * Math.cos(angle);
    const lonOffset = (radiusKm / (111.0 * Math.cos(point.lat * Math.PI / 180))) * Math.sin(angle);
    points.push([point.lon + lonOffset, point.lat + latOffset]);
  }
  // Ensure circle is closed (first and last point match)
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (firstPoint[0] !== lastPoint[0] || firstPoint[1] !== lastPoint[1]) {
    points.push([firstPoint[0], firstPoint[1]]);
  }
  
  // Always include the circle - it's generated correctly
  features.push({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [points] },
    properties: { stroke: '#2563eb', 'stroke-width': 3, fill: '#2563eb', 'fill-opacity': 0.15 }
  });
  console.log(`    Added 2-mile circle with ${points.length} points`);
  
  // Add scale bar (10km scale bar in bottom-left corner)
  // Calculate 10km in degrees at this latitude
  const scaleKm = 10;
  const latDegrees = scaleKm / 111.0;
  const lonDegrees = scaleKm / (111.0 * Math.cos(point.lat * Math.PI / 180));
  
  // Position scale bar in bottom-left (offset from center)
  const scaleLat = point.lat - 0.15; // Move down
  const scaleLon = point.lon - 0.15; // Move left
  
  // Scale bar line (horizontal)
  const scaleBar = {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [scaleLon, scaleLat],
        [scaleLon + lonDegrees, scaleLat]
      ]
    },
    properties: {
      stroke: '#000000',
      'stroke-width': 4,
      'stroke-opacity': 0.8
    }
  };
  features.push(scaleBar);
  
  // Scale bar endpoints (vertical ticks)
  const tickLength = 0.005; // Small tick length
  features.push({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [scaleLon, scaleLat - tickLength],
        [scaleLon, scaleLat + tickLength]
      ]
    },
    properties: {
      stroke: '#000000',
      'stroke-width': 4,
      'stroke-opacity': 0.8
    }
  });
  features.push({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [scaleLon + lonDegrees, scaleLat - tickLength],
        [scaleLon + lonDegrees, scaleLat + tickLength]
      ]
    },
    properties: {
      stroke: '#000000',
      'stroke-width': 4,
      'stroke-opacity': 0.8
    }
  });
  
  // Add city bounding boxes (keep just first two to minimize URL size)
  if (Array.isArray(polygons) && polygons.length > 0) {
    polygons.slice(0, 2).forEach((p, idx) => {
      const geometry = p?.polygon?.geometry;
      if (!geometry) return;
      const fixedGeometry = fixPolygonGeometry(geometry);
      const bboxFeature = createBoundingBoxFeature(
        fixedGeometry,
        idx === 0 ? '#2563eb' : '#22c55e',
        0.08
      );
      if (bboxFeature) {
        features.push(bboxFeature);
        console.log(`    Added city bounding box ${idx + 1} for ${point.id || 'unknown'}`);
      } else {
        console.warn(`    Skipping city polygon ${idx + 1} for ${point.id || 'unknown'} (unable to derive bounding box)`);
      }
    });
  }
  
  // Admin area bounding box
  if (adminArea && adminArea.polygon && adminArea.polygon.geometry) {
    const fixedGeometry = fixPolygonGeometry(adminArea.polygon.geometry);
    const bboxFeature = createBoundingBoxFeature(fixedGeometry, '#dc2626', 0.12);
    if (bboxFeature) {
      features.push(bboxFeature);
      console.log(`    Added admin bounding box for ${point.id || 'unknown'}`);
    } else {
      console.warn(`    Skipping admin area for ${point.id || 'unknown'} (unable to derive bounding box)`);
    }
  }
  
  console.log(`    Total features in overlay: ${features.length} (Point: 1, Circle: 1, Boxes: ${features.length - 2})`);
  
  return { type: 'FeatureCollection', features };
}

function downloadMapboxStaticImage(point, polygons, adminArea, outputPath, token) {
  return new Promise((resolve, reject) => {
    // Declare url at the very top to avoid temporal dead zone issues
    // Initialize to undefined explicitly
    let url = undefined;
    
    const zoom = calculateZoomForWidth(point.lat, 40);
    
    // Build overlay
    let overlay = buildGeoJSONOverlay(point, polygons, adminArea);
    let overlayJson = JSON.stringify(overlay);
    let overlayEncoded = encodeURIComponent(overlayJson);
    
    // Log debug info
    const polygonCount = overlay.features.filter(f => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon').length;
    const pointCount = overlay.features.filter(f => f.geometry.type === 'Point').length;
    console.log(`    Building overlay: ${overlay.features.length} features (${pointCount} points, ${polygonCount} polygons)`);
    
    // Debug: log what features we have
    overlay.features.forEach((f, idx) => {
      console.log(`      Feature ${idx + 1}: ${f.geometry.type}${f.properties ? ` (${Object.keys(f.properties).join(', ')})` : ''}`);
    });
    
    let isFallbackRequest = false;
    
    function handleResponse(res) {
      if (res.statusCode === 200) {
        const file = fs.createWriteStream(outputPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
        file.on('error', reject);
      } else if (res.statusCode === 422 && !isFallbackRequest) {
        // Invalid GeoJSON - fall back to simple map without overlays (only once)
        let errorBody = '';
        res.on('data', chunk => {
          errorBody += chunk;
        });
        res.on('end', () => {
          console.warn(`    Invalid GeoJSON detected (422), trying minimal overlay (point + circle only)`);
          isFallbackRequest = true;
          // Try minimal overlay (just point + circle)
          // Generate circle points
          const radiusKm = 1.60934;
          const circlePoints = [];
          for (let i = 0; i < 64; i++) {
            const angle = (i / 64) * 2 * Math.PI;
            const latOffset = (radiusKm / 111.0) * Math.cos(angle);
            const lonOffset = (radiusKm / (111.0 * Math.cos(point.lat * Math.PI / 180))) * Math.sin(angle);
            circlePoints.push([point.lon + lonOffset, point.lat + latOffset]);
          }
          circlePoints.push(circlePoints[0]); // Close circle
          
          const minimalOverlay = {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
                properties: { 'marker-color': '#da3d16', 'marker-size': 'large' }
              },
              {
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [circlePoints] },
                properties: { stroke: '#2563eb', 'stroke-width': 3, fill: '#2563eb', 'fill-opacity': 0.15 }
              }
            ]
          };
          const minimalEncoded = encodeURIComponent(JSON.stringify(minimalOverlay));
          const minimalUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${minimalEncoded})/${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;
          
          if (minimalUrl.length <= 8000) {
            console.log(`    Using minimal overlay (point + circle) - URL length: ${minimalUrl.length}`);
            https.get(minimalUrl, handleResponse);
          } else {
            console.warn(`    Minimal overlay also too long, falling back to simple map`);
            const simpleUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;
            https.get(simpleUrl, handleResponse);
          }
        });
      } else {
        let errorBody = '';
        res.on('data', chunk => {
          errorBody += chunk;
        });
        res.on('end', () => {
          const errorMsg = errorBody.substring(0, 200);
          const fullErrorMsg = 'Mapbox API ' + res.statusCode + ': ' + errorMsg;
          console.error('    Mapbox API error:', res.statusCode, errorMsg);
          reject(new Error(fullErrorMsg));
        });
      }
    }
    
    if (token && !token.includes('rJcFIG214AriISLbB6B5aw')) {
      url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${overlayEncoded})/${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;
      
      // Increased URL length limit - Chrome supports up to 2MB, but we'll use 32KB for safety
      // Mapbox Static Images API should handle this, but if it fails we'll fall back
      const MAX_URL_LENGTH = 32000;
      let simplificationAttempts = 0;
      // More gradual tolerance progression to preserve shape better
      // Start with very small tolerance and increase gradually
      const toleranceSteps = [0.0001, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0];
      let currentTolerance = toleranceSteps[0];

      while (url && url.length > MAX_URL_LENGTH && simplificationAttempts < toleranceSteps.length) {
        simplificationAttempts++;
        currentTolerance = toleranceSteps[simplificationAttempts - 1];
        console.warn(`    URL too long (${url.length} chars). Attempting simplification with tolerance: ${currentTolerance}`);

        const simplifiedFeatures = overlay.features.map(feature => {
          if (feature.geometry && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')) {
            // Simplify and fix geometry
            let simplified = simplifyPolygon(feature.geometry, currentTolerance);
            simplified = fixPolygonGeometry(simplified); // Fix any issues introduced by simplification
            return { ...feature, geometry: simplified };
          }
          return feature;
        }).filter(isValidGeoJSONFeature); // Filter out invalid features
        
        if (simplifiedFeatures.length === 0) {
          console.warn(`    All features became invalid after simplification, skipping simplification`);
          break; // Stop simplification attempts
        }
        
        overlay = { type: 'FeatureCollection', features: simplifiedFeatures };
        overlayJson = JSON.stringify(overlay);
        overlayEncoded = encodeURIComponent(overlayJson);
        url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${overlayEncoded})/${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;
      }

      if (url && url.length > MAX_URL_LENGTH) {
        console.warn(`    URL still too long after simplification (${url.length} chars), trying minimal overlay (point + circle + scale)`);
        // Try minimal overlay with just point, circle, and scale bar
        const radiusKm = 1.60934;
        const circlePoints = [];
        for (let i = 0; i < 64; i++) {
          const angle = (i / 64) * 2 * Math.PI;
          const latOffset = (radiusKm / 111.0) * Math.cos(angle);
          const lonOffset = (radiusKm / (111.0 * Math.cos(point.lat * Math.PI / 180))) * Math.sin(angle);
          circlePoints.push([point.lon + lonOffset, point.lat + latOffset]);
        }
        circlePoints.push(circlePoints[0]);
        
        // Scale bar
        const scaleKm = 10;
        const scaleLatDegrees = scaleKm / 111.0;
        const scaleLonDegrees = scaleKm / (111.0 * Math.cos(point.lat * Math.PI / 180));
        const scaleLat = point.lat - 0.15;
        const scaleLon = point.lon - 0.15;
        const tickLength = 0.005;
        
        const minimalOverlay = {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
              properties: { 'marker-color': '#da3d16', 'marker-size': 'large' }
            },
            {
              type: 'Feature',
              geometry: { type: 'Polygon', coordinates: [circlePoints] },
              properties: { stroke: '#2563eb', 'stroke-width': 3, fill: '#2563eb', 'fill-opacity': 0.15 }
            },
            {
              type: 'Feature',
              geometry: {
                type: 'LineString',
                coordinates: [[scaleLon, scaleLat], [scaleLon + scaleLonDegrees, scaleLat]]
              },
              properties: { stroke: '#000000', 'stroke-width': 4, 'stroke-opacity': 0.8 }
            },
            {
              type: 'Feature',
              geometry: {
                type: 'LineString',
                coordinates: [[scaleLon, scaleLat - tickLength], [scaleLon, scaleLat + tickLength]]
              },
              properties: { stroke: '#000000', 'stroke-width': 4, 'stroke-opacity': 0.8 }
            },
            {
              type: 'Feature',
              geometry: {
                type: 'LineString',
                coordinates: [[scaleLon + scaleLonDegrees, scaleLat - tickLength], [scaleLon + scaleLonDegrees, scaleLat + tickLength]]
              },
              properties: { stroke: '#000000', 'stroke-width': 4, 'stroke-opacity': 0.8 }
            }
          ]
        };
        const minimalEncoded = encodeURIComponent(JSON.stringify(minimalOverlay));
        const minimalUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${minimalEncoded})/${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;
        
        if (minimalUrl.length <= 8000) {
          console.log(`    Using minimal overlay (point + circle + scale) - URL length: ${minimalUrl.length}`);
          https.get(minimalUrl, handleResponse);
        } else {
          console.warn(`    Minimal overlay also too long (${minimalUrl.length} chars), using simple map without overlays`);
          const simpleUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;
          https.get(simpleUrl, handleResponse);
        }
      } else {
        // Validate all features before sending
        const invalidFeatures = overlay.features.filter(f => !isValidGeoJSONFeature(f));
        if (invalidFeatures.length > 0) {
          console.warn(`    Found ${invalidFeatures.length} invalid features, filtering them out`);
          overlay.features = overlay.features.filter(f => isValidGeoJSONFeature(f));
          overlayJson = JSON.stringify(overlay);
          overlayEncoded = encodeURIComponent(overlayJson);
          url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${overlayEncoded})/${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;
        }
        
        // Final validation before sending
        if (overlay.features.length === 0) {
          console.warn(`    No valid features remaining, trying minimal overlay (point + circle + scale)`);
          // Build minimal overlay with point, circle, and scale
          const radiusKm = 1.60934;
          const circlePoints = [];
          for (let i = 0; i < 64; i++) {
            const angle = (i / 64) * 2 * Math.PI;
            const latOffset = (radiusKm / 111.0) * Math.cos(angle);
            const lonOffset = (radiusKm / (111.0 * Math.cos(point.lat * Math.PI / 180))) * Math.sin(angle);
            circlePoints.push([point.lon + lonOffset, point.lat + latOffset]);
          }
          circlePoints.push(circlePoints[0]);
          
          const scaleKm = 10;
          const scaleLatDegrees = scaleKm / 111.0;
          const scaleLonDegrees = scaleKm / (111.0 * Math.cos(point.lat * Math.PI / 180));
          const scaleLat = point.lat - 0.15;
          const scaleLon = point.lon - 0.15;
          const tickLength = 0.005;
          
          const minimalOverlay = {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
                properties: { 'marker-color': '#da3d16', 'marker-size': 'large' }
              },
              {
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [circlePoints] },
                properties: { stroke: '#2563eb', 'stroke-width': 3, fill: '#2563eb', 'fill-opacity': 0.15 }
              },
              {
                type: 'Feature',
                geometry: {
                  type: 'LineString',
                  coordinates: [[scaleLon, scaleLat], [scaleLon + scaleLonDegrees, scaleLat]]
                },
                properties: { stroke: '#000000', 'stroke-width': 4, 'stroke-opacity': 0.8 }
              },
              {
                type: 'Feature',
                geometry: {
                  type: 'LineString',
                  coordinates: [[scaleLon, scaleLat - tickLength], [scaleLon, scaleLat + tickLength]]
                },
                properties: { stroke: '#000000', 'stroke-width': 4, 'stroke-opacity': 0.8 }
              },
              {
                type: 'Feature',
                geometry: {
                  type: 'LineString',
                  coordinates: [[scaleLon + scaleLonDegrees, scaleLat - tickLength], [scaleLon + scaleLonDegrees, scaleLat + tickLength]]
                },
                properties: { stroke: '#000000', 'stroke-width': 4, 'stroke-opacity': 0.8 }
              }
            ]
          };
          const minimalEncoded = encodeURIComponent(JSON.stringify(minimalOverlay));
          const minimalUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${minimalEncoded})/${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;
          
          if (minimalUrl.length <= 8000) {
            console.log(`    Using minimal overlay - URL length: ${minimalUrl.length}`);
            https.get(minimalUrl, handleResponse);
          } else {
            console.warn(`    Minimal overlay too long, using simple map without overlays`);
            const simpleUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;
            https.get(simpleUrl, handleResponse);
          }
        } else {
          try {
            const testJson = JSON.parse(overlayJson);
            if (!testJson.type || testJson.type !== 'FeatureCollection' || !Array.isArray(testJson.features) || testJson.features.length === 0) {
              throw new Error('Invalid FeatureCollection structure');
            }
            // If validation passes, send the request
            if (url) {
              https.get(url, handleResponse);
            } else {
              reject(new Error('URL not initialized'));
            }
          } catch (validationError) {
            console.warn(`    GeoJSON validation failed: ${validationError.message}, trying minimal overlay`);
            // Build minimal overlay with point, circle, and scale
            const radiusKm = 1.60934;
            const circlePoints = [];
            for (let i = 0; i < 64; i++) {
              const angle = (i / 64) * 2 * Math.PI;
              const latOffset = (radiusKm / 111.0) * Math.cos(angle);
              const lonOffset = (radiusKm / (111.0 * Math.cos(point.lat * Math.PI / 180))) * Math.sin(angle);
              circlePoints.push([point.lon + lonOffset, point.lat + latOffset]);
            }
            circlePoints.push(circlePoints[0]);
            
            const scaleKm = 10;
            const scaleLatDegrees = scaleKm / 111.0;
            const scaleLonDegrees = scaleKm / (111.0 * Math.cos(point.lat * Math.PI / 180));
            const scaleLat = point.lat - 0.15;
            const scaleLon = point.lon - 0.15;
            const tickLength = 0.005;
            
            const minimalOverlay = {
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
                  properties: { 'marker-color': '#da3d16', 'marker-size': 'large' }
                },
                {
                  type: 'Feature',
                  geometry: { type: 'Polygon', coordinates: [circlePoints] },
                  properties: { stroke: '#2563eb', 'stroke-width': 3, fill: '#2563eb', 'fill-opacity': 0.15 }
                },
                {
                  type: 'Feature',
                  geometry: {
                    type: 'LineString',
                    coordinates: [[scaleLon, scaleLat], [scaleLon + scaleLonDegrees, scaleLat]]
                  },
                  properties: { stroke: '#000000', 'stroke-width': 4, 'stroke-opacity': 0.8 }
                },
                {
                  type: 'Feature',
                  geometry: {
                    type: 'LineString',
                    coordinates: [[scaleLon, scaleLat - tickLength], [scaleLon, scaleLat + tickLength]]
                  },
                  properties: { stroke: '#000000', 'stroke-width': 4, 'stroke-opacity': 0.8 }
                },
                {
                  type: 'Feature',
                  geometry: {
                    type: 'LineString',
                    coordinates: [[scaleLon + scaleLonDegrees, scaleLat - tickLength], [scaleLon + scaleLonDegrees, scaleLat + tickLength]]
                  },
                  properties: { stroke: '#000000', 'stroke-width': 4, 'stroke-opacity': 0.8 }
                }
              ]
            };
            const minimalEncoded = encodeURIComponent(JSON.stringify(minimalOverlay));
            const minimalUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(${minimalEncoded})/${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;
            
            if (minimalUrl.length <= 8000) {
              console.log(`    Using minimal overlay - URL length: ${minimalUrl.length}`);
              https.get(minimalUrl, handleResponse);
            } else {
              console.warn(`    Minimal overlay too long, using simple map without overlays`);
              const simpleUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${point.lon},${point.lat},${zoom}/1200x500@2x?access_token=${token}`;
              https.get(simpleUrl, handleResponse);
            }
          }
        }
      }
    } else {
      const errorMsg = 'Mapbox token required. Set MAPBOX_ACCESS_TOKEN environment variable.';
      console.error(`    Error: ${errorMsg}`);
      reject(new Error(errorMsg));
    }
  });
}

async function generateImage(data, index, total) {
  const { point, polygons = [], adminArea } = data;
  // Get token from main scope (passed via closure) or process.env
  const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN;
  
  if (!mapboxToken) {
    console.error(`    Error: MAPBOX_ACCESS_TOKEN not set. Skipping ${point.id}`);
    console.error(`    Debug: process.env keys: ${Object.keys(process.env).filter(k => k.includes('MAPBOX')).join(', ') || 'none'}`);
    return;
  }
  
  const imageFile = path.join(OUTPUT_DIR, `${point.id}.png`);
  
  console.log(`[${index + 1}/${total}] Generating ${point.id}.png...`);
  
  try {
    await downloadMapboxStaticImage(point, polygons, adminArea, imageFile, mapboxToken);
    console.log(`[${index + 1}/${total}] Generated ${point.id}.png`);
  } catch (error) {
    console.error(`[${index + 1}/${total}] Failed to generate ${point.id}.png:`, error.message);
  }
}

async function main() {
  console.log('Generating Gallery Images\n');
  
  // Check for token early - must be exported in shell environment
  const token = process.env.MAPBOX_ACCESS_TOKEN;
  if (!token) {
    console.error('❌ ERROR: MAPBOX_ACCESS_TOKEN not found in environment');
    console.error('   The token must be exported in your shell before running this script');
    console.error('   Try: export MAPBOX_ACCESS_TOKEN=your_token_here');
    console.error('   Or: MAPBOX_ACCESS_TOKEN=your_token_here node scripts/generate-gallery-images.js\n');
    process.exit(1);
  } else {
    console.log(`✅ MAPBOX_ACCESS_TOKEN found (${token.substring(0, 10)}...)\n`);
  }
  
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`Error: Data file not found: ${DATA_FILE}`);
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
  
  for (let i = 0; i < resultsWithPolygons.length; i++) {
    await generateImage(resultsWithPolygons[i], i, resultsWithPolygons.length);
  }
  
  console.log(`\nGenerated ${resultsWithPolygons.length} images in ${OUTPUT_DIR}`);
  console.log(`\n📄 Next step: Open public/gallery/locate-me/index.html to view the gallery`);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { generateImage };
