cd ~/levante/levante-web-dashboard && mkdir -p scripts/gadm-processing && cat > scripts/gadm-processing/setup.sh << 'SETUP_EOF'
#!/bin/bash
# GADM Processing Setup Script
# Hardcoded for: ~/levante/levante-web-dashboard

REPO_ROOT="$HOME/levante/levante-web-dashboard"
GADM_DIR="$REPO_ROOT/scripts/gadm-processing"

cd "$GADM_DIR"

# 1. download_gadm.sh
cat > download_gadm.sh << 'EOF'
#!/bin/bash
set -e

COUNTRIES=(
  "GBR:Scotland"
  "USA:USA"
  "CAN:Canada"
  "COL:Colombia"
  "IND:India"
  "ARG:Argentina"
  "NLD:Netherlands"
  "GHA:Ghana"
  "CHE:Switzerland"
  "DEU:Germany"
)

GADM_DIR="$HOME/levante/levante-web-dashboard/scripts/gadm-processing"
OUTPUT_DIR="$GADM_DIR/gadm_downloads"
mkdir -p "$OUTPUT_DIR"

echo "📦 Downloading GADM shapefiles for ${#COUNTRIES[@]} countries..."

for country in "${COUNTRIES[@]}"; do
  IFS=':' read -r code name <<< "$country"
  echo ""
  echo "⬇️  Downloading $name ($code)..."
  
  URL="https://geodata.ucdavis.edu/gadm/gadm4.1/shp/gadm41_${code}_shp.zip"
  OUTPUT="$OUTPUT_DIR/gadm41_${code}_shp.zip"
  
  if [ -f "$OUTPUT" ]; then
    echo "   ✓ Already exists: $OUTPUT"
  else
    curl -L -o "$OUTPUT" "$URL" || {
      echo "   ⚠️  Failed to download $name"
      continue
    }
    echo "   ✓ Downloaded: $OUTPUT"
  fi
done

echo ""
echo "✅ Download complete! Files saved to: $OUTPUT_DIR"
EOF

# 2. process_gadm_files.sh
cat > process_gadm_files.sh << 'EOF'
#!/bin/bash
set -e

GADM_DIR="$HOME/levante/levante-web-dashboard/scripts/gadm-processing"
INPUT_DIR="$GADM_DIR/gadm_downloads"
OUTPUT_DIR="$GADM_DIR/gadm_processed"

mkdir -p "$OUTPUT_DIR"

echo "📂 Processing GADM shapefiles..."

for zipfile in "$INPUT_DIR"/*.zip; do
  [ -e "$zipfile" ] || continue
  
  basename=$(basename "$zipfile" .zip)
  country_code=$(echo "$basename" | cut -d'_' -f2)
  
  echo ""
  echo "Processing: $basename"
  
  temp_dir="$OUTPUT_DIR/temp_$country_code"
  mkdir -p "$temp_dir"
  
  unzip -q -o "$zipfile" -d "$temp_dir"
  
  for level in 4 3 2; do
    shp_pattern="$temp_dir/gadm41_${country_code}_${level}.shp"
    if ls $shp_pattern 2>/dev/null; then
      echo "   ✓ Found level $level"
      
      country_dir="$OUTPUT_DIR/${country_code}"
      mkdir -p "$country_dir/level${level}"
      
      cp "$temp_dir/gadm41_${country_code}_${level}".* "$country_dir/level${level}/"
      
      (cd "$country_dir/level${level}" && zip -q "../gadm41_${country_code}_${level}.zip" gadm41_${country_code}_${level}.*)
      
      echo "   ✓ Processed to: $country_dir/level${level}"
      break
    fi
  done
  
  rm -rf "$temp_dir"
done

echo ""
echo "✅ Processing complete! Files in: $OUTPUT_DIR"
EOF

# 3. build-gadm-snippets-batch.js
cat > build-gadm-snippets-batch.js << 'EOF'
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(process.env.HOME, 'levante/levante-web-dashboard');
const GADM_DIR = path.join(REPO_ROOT, 'scripts/gadm-processing');
const PROCESSED_DIR = path.join(GADM_DIR, 'gadm_processed');

const COUNTRY_MAPPING = {
  GBR: 'Scotland',
  USA: 'USA',
  CAN: 'Canada',
  COL: 'Colombia',
  IND: 'India',
  ARG: 'Argentina',
  NLD: 'Netherlands',
  GHA: 'Ghana',
  CHE: 'Switzerland',
  DEU: 'Germany'
};

console.log('🔨 Building GADM snippets...\n');

if (!fs.existsSync(PROCESSED_DIR)) {
  console.error(`Error: ${PROCESSED_DIR} not found. Run process_gadm_files.sh first.`);
  process.exit(1);
}

const countries = fs.readdirSync(PROCESSED_DIR)
  .filter(f => fs.statSync(path.join(PROCESSED_DIR, f)).isDirectory());

for (const countryCode of countries) {
  const countryName = COUNTRY_MAPPING[countryCode] || countryCode;
  const countryDir = path.join(PROCESSED_DIR, countryCode);
  
  const levels = fs.readdirSync(countryDir)
    .filter(f => f.startsWith('level') && fs.statSync(path.join(countryDir, f)).isDirectory());
  
  if (levels.length === 0) continue;
  
  const levelDir = path.join(countryDir, levels[0]);
  const level = levels[0].replace('level', '');
  
  const shpFiles = fs.readdirSync(levelDir).filter(f => f.endsWith('.shp'));
  if (shpFiles.length === 0) continue;
  
  const shpPath = path.join(levelDir, shpFiles[0]);
  const outputDir = path.join(countryDir, 'snippets');
  const outputPath = path.join(outputDir, `gadm_${countryCode}_snippets.json`);
  
  console.log(`Processing ${countryName} (${countryCode}) - Level ${level}`);
  
  fs.mkdirSync(outputDir, { recursive: true });
  
  const tempConfig = path.join(countryDir, 'temp_config.json');
  fs.writeFileSync(tempConfig, JSON.stringify({ countries: [countryName] }));
  
  try {
    const buildScript = path.join(REPO_ROOT, 'scripts/build-gadm-snippets.js');
    execSync(
      `node "${buildScript}" -i "${shpPath}" -o "${outputPath}" -c "${tempConfig}"`,
      { stdio: 'inherit' }
    );
    console.log(`   ✓ Created: ${outputPath}\n`);
  } catch (error) {
    console.error(`   ✗ Failed for ${countryCode}\n`);
  } finally {
    fs.unlinkSync(tempConfig);
  }
}

console.log('✅ Snippet generation complete!');
EOF

# 4. upload_to_gcs.sh
cat > upload_to_gcs.sh << 'EOF'
#!/bin/bash
set -e

GCS_BUCKET="gs://levante-assets-dev/maps/gadm"
GADM_DIR="$HOME/levante/levante-web-dashboard/scripts/gadm-processing"
PROCESSED_DIR="$GADM_DIR/gadm_processed"

echo "☁️  Uploading to GCS: $GCS_BUCKET"

if ! command -v gsutil &> /dev/null; then
  echo "Error: gsutil not found. Install Google Cloud SDK first."
  exit 1
fi

for country_dir in "$PROCESSED_DIR"/*/; do
  [ -d "$country_dir" ] || continue
  
  country_code=$(basename "$country_dir")
  echo ""
  echo "Uploading: $country_code"
  
  for zipfile in "$country_dir"/*.zip; do
    [ -f "$zipfile" ] || continue
    level=$(basename "$zipfile" | grep -oP '_\K[0-9]+(?=\.zip)' || echo "3")
    gsutil cp "$zipfile" "$GCS_BUCKET/${country_code}/level${level}/" || echo "   ⚠️  Failed"
  done
  
  snippets_dir="$country_dir/snippets"
  if [ -d "$snippets_dir" ]; then
    gsutil -m cp "$snippets_dir"/*.json "$GCS_BUCKET/${country_code}/snippets/" || echo "   ⚠️  Failed"
  fi
  
  echo "   ✓ Uploaded $country_code"
done

echo ""
echo "✅ Upload complete!"
EOF

# 5. generate_config.js
cat > generate_config.js << 'EOF'
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(process.env.HOME, 'levante/levante-web-dashboard');
const GADM_DIR = path.join(REPO_ROOT, 'scripts/gadm-processing');
const PROCESSED_DIR = path.join(GADM_DIR, 'gadm_processed');
const OUTPUT_FILE = path.join(GADM_DIR, 'gadm_config.json');

const COUNTRY_NAMES = {
  GBR: 'Scotland',
  USA: 'United States',
  CAN: 'Canada',
  COL: 'Colombia',
  IND: 'India',
  ARG: 'Argentina',
  NLD: 'Netherlands',
  GHA: 'Ghana',
  CHE: 'Switzerland',
  DEU: 'Germany'
};

console.log('⚙️  Generating GADM configuration...\n');

const config = {
  version: '4.1',
  lastUpdated: new Date().toISOString(),
  bucket: 'gs://levante-assets-dev/maps/gadm',
  countries: {}
};

if (!fs.existsSync(PROCESSED_DIR)) {
  console.error(`Error: ${PROCESSED_DIR} not found.`);
  process.exit(1);
}

const countries = fs.readdirSync(PROCESSED_DIR)
  .filter(f => fs.statSync(path.join(PROCESSED_DIR, f)).isDirectory());

for (const code of countries) {
  const countryDir = path.join(PROCESSED_DIR, code);
  
  const levels = fs.readdirSync(countryDir)
    .filter(f => f.startsWith('level') && fs.statSync(path.join(countryDir, f)).isDirectory());
  
  if (levels.length === 0) continue;
  
  const level = parseInt(levels[0].replace('level', ''));
  const levelDir = path.join(countryDir, levels[0]);
  
  const shpFiles = fs.readdirSync(levelDir).filter(f => f.endsWith('.shp'));
  if (shpFiles.length === 0) continue;
  
  const snippetsDir = path.join(countryDir, 'snippets');
  const hasSnippets = fs.existsSync(snippetsDir) && 
    fs.readdirSync(snippetsDir).some(f => f.endsWith('.json'));
  
  config.countries[code] = {
    name: COUNTRY_NAMES[code] || code,
    level,
    shapefile: `${code}/level${level}/gadm41_${code}_${level}.zip`,
    snippets: hasSnippets ? `${code}/snippets/gadm_${code}_snippets.json` : null,
    nameField: `NAME_${level}`,
    admin1Field: level > 1 ? 'NAME_1' : null,
    countryField: 'NAME_0'
  };
  
  console.log(`✓ ${COUNTRY_NAMES[code] || code}: Level ${level}`);
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(config, null, 2));

console.log(`\n✅ Configuration saved to: ${OUTPUT_FILE}`);
console.log(`   Countries configured: ${Object.keys(config.countries).length}`);
EOF

# 6. run_all.sh
cat > run_all.sh << 'EOF'
#!/bin/bash
set -e

GADM_DIR="$HOME/levante/levante-web-dashboard/scripts/gadm-processing"
cd "$GADM_DIR"

echo "╔════════════════════════════════════════════════╗"
echo "║   GADM Processing Pipeline - Complete Workflow ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

echo "STEP 1/5: Downloading GADM files..."
bash download_gadm.sh

echo ""
echo "STEP 2/5: Processing shapefiles..."
bash process_gadm_files.sh

echo ""
echo "STEP 3/5: Building snippets..."
node build-gadm-snippets-batch.js

echo ""
echo "STEP 4/5: Generating configuration..."
node generate_config.js

echo ""
echo "STEP 5/5: Uploading to Google Cloud Storage..."
read -p "Upload to GCS now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  bash upload_to_gcs.sh
else
  echo "Skipping GCS upload. Run upload_to_gcs.sh manually when ready."
fi

echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║   ✅ GADM Processing Complete!                 ║"
echo "╚════════════════════════════════════════════════╝"
EOF

# close setup script
SETUP_EOF

# 7. README.md
cat > README.md << 'EOF'
# GADM Processing Scripts

Automated pipeline for downloading, processing, and uploading GADM shapefiles for 10 countries.

## Location
`~/levante/levante-web-dashboard/scripts/gadm-processing/`

## Quick Start
1. Run `bash scripts/gadm-processing/setup.sh` to generate the helper scripts.
2. Execute `bash scripts/gadm-processing/run_all.sh` to download, process, build snippets, and optionally upload to GCS.
3. Update `config/gadm-bucket-files.json` if you change country sets, then rerun the pipeline.

For debugging look at the generated log files in `scripts/gadm-processing` and rerun any individual step (download/process/build/upload) as needed.
EOF
