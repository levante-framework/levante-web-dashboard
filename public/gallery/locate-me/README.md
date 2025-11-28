# Locate Me Gallery

This gallery showcases visual results from processing 100 GPS points through the Locate-Me workflow.

## How to Generate

1. **Install dependencies** (if not already installed):
   ```bash
   npm install
   ```

2. **Generate GPS points and process them**:
   ```bash
   node scripts/generate-locate-me-gallery.js
   ```
   
   This will:
   - Generate 100 GPS points (25 from each: US, Colombia, Canada, Germany)
   - Process each through the reverse-geocode API
   - Fetch polygons for the top 2 results
   - Save data to `public/gallery/locate-me/gallery-data.json`

3. **Generate images**:
   ```bash
   node scripts/generate-gallery-images.js
   ```
   
   This will:
   - Create HTML templates for each result
   - Use Puppeteer to render and screenshot each template
   - Save images to `public/gallery/locate-me/images/`

4. **View the gallery**:
   Open `public/gallery/locate-me/index.html` in a browser

## What Each Image Shows

Each gallery image displays:
- **Two location cards**: Showing the nearest and second-nearest cities with:
  - City name
  - Distance from GPS point
  - Administrative region and country
  - Population (if available)
  
- **Map visualization**: Showing:
  - GPS point (red marker)
  - 150km search radius circle (red dashed)
  - Polygon boundaries for the two nearest cities (blue and green)

## Files

- `gallery-data.json` - Complete data for all processed points
- `images/*.png` - Generated images (one per GPS point)
- `index.html` - Gallery viewer with filtering by country

