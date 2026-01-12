# Installing osmium-tool

osmium-tool is a command-line utility for processing OpenStreetMap data files. It's much faster than using Overpass API for extracting admin boundaries from Geofabrik PBF files.

## Installation

### Ubuntu/Debian

```bash
sudo apt-get update
sudo apt-get install osmium-tool
```

### macOS

```bash
brew install osmium-tool
```

### Windows

1. Download the latest release from: https://github.com/osmcode/osmium-tool/releases
2. Extract the ZIP file
3. Add the `osmium.exe` to your PATH, or use the full path when running commands

### Verify Installation

After installing, verify it works:

```bash
osmium --version
```

You should see output like:
```
osmium version 1.15.0
```

## Usage

Once installed, the `build-geofabrik-packs.js` script will automatically detect and use osmium-tool for faster processing.

### Manual Usage Examples

If you want to use osmium-tool manually:

```bash
# Download a Geofabrik PBF file
wget https://download.geofabrik.de/europe/netherlands-latest.osm.pbf

# Extract admin_level 4 boundaries
osmium tags-filter netherlands-latest.osm.pbf \
  r/boundary=administrative r/admin_level=4 \
  -o netherlands-adm4.osm.pbf

# Convert to GeoJSON
osmium export netherlands-adm4.osm.pbf -o netherlands-adm4.geojson
```

## Benefits

- **Faster**: Local processing is much faster than Overpass API
- **No rate limits**: Process as much data as you need
- **More reliable**: No network issues or timeouts
- **Better for large countries**: Can handle entire countries efficiently

## Troubleshooting

### Command not found

If `osmium` command is not found after installation:

1. **Ubuntu/Debian**: Make sure you ran `sudo apt-get update` first
2. **macOS**: Check that Homebrew is properly configured
3. **Windows**: Verify the executable is in your PATH

### Permission denied

If you get permission errors:

```bash
# Check if osmium is installed
which osmium

# If not found, try with full path
/usr/bin/osmium --version
```

### Out of memory

For very large countries (like US or India), you might need more RAM. Consider:

1. Processing sub-regions instead of entire countries
2. Using a machine with more RAM
3. Using Overpass API fallback (slower but uses less memory)
