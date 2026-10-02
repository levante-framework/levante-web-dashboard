#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESOLUTION = Number(process.argv[2] || 5);
const OUT_DIR = path.join(ROOT, 'public', 'gallery', `ghana-h3-r${RESOLUTION}`);
const payload = JSON.parse(
  fs.readFileSync(path.join(OUT_DIR, 'cells.json'), 'utf8')
);
const ranges = [
  { max: 5000, color: '#c5453f', label: 'Under 5,000' },
  { max: 20000, color: '#b5781a', label: '5,000–19,999' },
  { max: 50000, color: '#7aa8b8', label: '20,000–49,999' },
  { max: 100000, color: '#2a93ad', label: '50,000–99,999' },
  { max: 250000, color: '#0c7e9b', label: '100,000–249,999' },
  { max: Infinity, color: '#0a6a82', label: '250,000+' },
];

function colorFor(population) {
  if (population == null) return '#9aa4b2';
  return ranges.find((range) => population < range.max).color;
}

let minX = 180;
let minY = 90;
let maxX = -180;
let maxY = -90;
const polys = [];
for (const feature of payload.features || []) {
  const ring = feature.geometry?.coordinates?.[0];
  if (!ring) continue;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  polys.push({
    pts: ring,
    pop: feature.properties.population,
    id: feature.properties.cellId,
  });
}

const pad = 12;
const width = 720;
const height = 900;
const dx = maxX - minX || 1;
const dy = maxY - minY || 1;
function proj(x, y) {
  return [
    (pad + ((x - minX) / dx) * (width - 2 * pad)).toFixed(1),
    (pad + ((maxY - y) / dy) * (height - 2 * pad)).toFixed(1),
  ];
}

const paths = polys
  .map((poly) => {
    const d =
      poly.pts
        .map(([x, y], index) => {
          const [px, py] = proj(x, y);
          return `${index === 0 ? 'M' : 'L'}${px} ${py}`;
        })
        .join(' ') + ' Z';
    return `<path d="${d}" fill="${colorFor(poly.pop)}" stroke="#51607a" stroke-width="0.4" opacity="0.85"><title>${poly.id} · ${poly.pop == null ? 'n/a' : Number(poly.pop).toLocaleString()}</title></path>`;
  })
  .join('\n');

const legend = ranges
  .map(
    (range, index) =>
      `<rect x="24" y="${24 + index * 22}" width="14" height="14" fill="${range.color}" stroke="#51607a"/><text x="44" y="${35 + index * 22}" font-size="12" fill="#1f2733">${range.label}</text>`
  )
  .join('');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Ghana H3 resolution 5 population">
<rect width="100%" height="100%" fill="#e9edf3"/>
${paths}
<g font-family="system-ui,sans-serif">${legend}</g>
</svg>
`;

const out = path.join(OUT_DIR, `ghana-h3-r${RESOLUTION}.svg`);
fs.writeFileSync(out, svg);
console.log(`wrote ${path.relative(ROOT, out)} (${polys.length} hexes)`);
