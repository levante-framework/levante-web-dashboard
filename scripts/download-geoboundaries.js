#!/usr/bin/env node

/**
 * Pre-download GeoBoundaries data for supported countries
 * This avoids Vercel serverless function limitations
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const GEOBOUNDARIES_BASE_URL = 'https://www.geoboundaries.org/api/current/gbOpen';
const CACHE_DIR = path.join(process.cwd(), 'data', 'geoboundaries');

// Countries we need (ISO3 codes)
const COUNTRIES = ['USA', 'CAN', 'COL', 'DEU', 'GBR', 'NLD', 'GHA', 'CHE', 'IND', 'ARG'];
// Download ADM2, ADM3, and ADM4
// ADM4 only available for IND, ADM3 available for CAN/DEU/GBR/CHE
// We'll use the highest available level for each country
const LEVELS = [2, 3, 4]; // ADM2, ADM3, ADM4

function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`  Downloading: ${url}`);
    https.get(url, { followRedirect: true }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // Follow redirect
        return downloadFile(res.headers.location, outputPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      
      const file = fs.createWriteStream(outputPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        const stats = fs.statSync(outputPath);
        console.log(`  ✅ Saved: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
        resolve();
      });
    }).on('error', reject);
  });
}

async function downloadGeoBoundaries(iso3, level) {
  const metadataUrl = `${GEOBOUNDARIES_BASE_URL}/${iso3}/ADM${level}/`;
  
  return new Promise((resolve, reject) => {
    https.get(metadataUrl, (res) => {
      if (res.statusCode === 404) {
        // ADM4 may not be available for some countries - that's OK
        reject(new Error(`ADM${level} not available for ${iso3} (404)`));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Metadata HTTP ${res.statusCode}`));
        return;
      }
      
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const metadata = JSON.parse(data);
          const downloadUrl = metadata?.gjDownloadURL;
          
          if (!downloadUrl) {
            reject(new Error('No download URL in metadata'));
            return;
          }
          
          console.log(`  📥 Downloading ${iso3} ADM${level} from ${downloadUrl}`);
          const outputPath = path.join(CACHE_DIR, `${iso3}_ADM${level}.json.gz`);
          const tempPath = outputPath + '.tmp';
          
          downloadFile(downloadUrl, tempPath)
            .then(() => {
              // Check file size
              const stats = fs.statSync(tempPath);
              const sizeMB = stats.size / 1024 / 1024;
              console.log(`  📦 Downloaded: ${sizeMB.toFixed(2)}MB`);
              
              // Compress and save
              console.log(`  🗜️  Compressing...`);
              const geojson = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
              const compressed = zlib.gzipSync(JSON.stringify(geojson));
              fs.writeFileSync(outputPath, compressed);
              fs.unlinkSync(tempPath);
              
              const compressedSizeMB = fs.statSync(outputPath).size / 1024 / 1024;
              console.log(`  ✅ Compressed and saved: ${iso3} ADM${level} (${compressedSizeMB.toFixed(2)}MB)`);
              resolve();
            })
            .catch(reject);
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('📥 Downloading GeoBoundaries data...\n');
  
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  
  for (const country of COUNTRIES) {
    console.log(`\n🌍 ${country}:`);
    for (const level of LEVELS) {
      const cachePath = path.join(CACHE_DIR, `${country}_ADM${level}.json.gz`);
      if (fs.existsSync(cachePath)) {
        console.log(`  ⏭️  Skipping ${country} ADM${level} (already exists)`);
        continue;
      }
      
      try {
        await downloadGeoBoundaries(country, level);
      } catch (error) {
        if (error.message.includes('not available') || error.message.includes('404')) {
          console.warn(`  ⚠️  ${country} ADM${level} not available (this is OK for some countries)`);
        } else {
          console.error(`  ❌ Failed ${country} ADM${level}: ${error.message}`);
        }
      }
    }
  }
  
  console.log('\n✅ Download complete!');
}

main().catch(console.error);
