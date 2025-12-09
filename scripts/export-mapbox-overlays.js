#!/usr/bin/env node

/**
 * Export gallery polygons/admin areas into a single GeoJSON file that can be
 * uploaded to Mapbox as a tileset. Once uploaded, reference the resulting
 * tileset in a custom style and set MAPBOX_STYLE_ID=username/styleId so the
 * generator can use Mapbox-rendered overlays instead of embedding them inline.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(process.cwd(), 'public', 'gallery', 'locate-me', 'gallery-data.json');
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'gallery', 'mapbox-overlays.geojson');

function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ Gallery data not found: ${DATA_FILE}`);
    console.error('   Run "node scripts/generate-locate-me-gallery.js" first.');
    process.exit(1);
  }
}

function normalizeGeometry(geometry) {
  if (!geometry || !geometry.coordinates) {
    return null;
  }
  return geometry;
}

function createFeature(geometry, properties) {
  const normalized = normalizeGeometry(geometry);
  if (!normalized) return null;
  return {
    type: 'Feature',
    properties,
    geometry: normalized,
  };
}

function main() {
  ensureDataFile();
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const features = [];

  (raw.results || []).forEach((result) => {
    const locationId = result.point?.id || 'unknown';

    (result.polygons || []).forEach((polyEntry, idx) => {
      const feature = createFeature(polyEntry?.polygon?.geometry, {
        layer: 'city',
        location_id: locationId,
        city_name: polyEntry?.city?.name || null,
        order: idx,
        color: idx === 0 ? '#2563eb' : '#22c55e',
      });
      if (feature) features.push(feature);
    });

    const adminFeature = createFeature(result.adminArea?.polygon?.geometry, {
      layer: 'admin',
      location_id: locationId,
      admin_name: result.adminArea?.name || null,
      admin_level: result.adminArea?.adminLevel || null,
      color: '#dc2626',
    });
    if (adminFeature) features.push(adminFeature);
  });

  if (features.length === 0) {
    console.error('❌ No features found in gallery data.');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify({ type: 'FeatureCollection', features })
  );

  console.log(`✅ Exported ${features.length} features to ${OUTPUT_FILE}`);
  console.log('\nNext steps:');
  console.log('  1. Upload this file to Mapbox (Studio or Uploads API) to create a tileset.');
  console.log('  2. Build a custom style that references the tileset and draws the');
  console.log('     city/admin layers the way you want them rendered.');
  console.log('  3. Set MAPBOX_STYLE_ID=username/styleId so the generator can request');
  console.log('     static images that already include those overlays.');
}

main();
