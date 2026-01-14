/**
 * Admin Boundary Pack API
 * Serves boundary packs (including geofabrik files) from GCS bucket
 * Falls back to local files for development
 */

import { Storage } from '@google-cloud/storage';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { gunzipSync } from 'zlib';

const BOUNDARY_PACKS_BUCKET = process.env.BOUNDARY_PACKS_BUCKET || 'levante-assets-draft';
const BOUNDARY_PACKS_PREFIX = process.env.BOUNDARY_PACKS_PREFIX || 'maps/boundaries';
const ADM_PACK_DIR = join(process.cwd(), 'public', 'adm-packs');

function getStorageClient() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!serviceAccountJson) {
    // Try default credentials
    try {
      return new Storage();
    } catch (e) {
      return null;
    }
  }
  
  try {
    let json = serviceAccountJson.trim();
    if ((json.startsWith('"') && json.endsWith('"')) ||
        (json.startsWith("'") && json.endsWith("'"))) {
      json = json.slice(1, -1);
    }
    json = json.replace(/\\n/g, '\n');
    
    const credentials = JSON.parse(json);
    return new Storage({ credentials });
  } catch (e) {
    console.warn('GCS credentials env is not valid JSON');
    try {
      return new Storage();
    } catch (e2) {
      return null;
    }
  }
}

async function loadFromGCS(countryCode, fileName) {
  const storage = getStorageClient();
  if (!storage) return null;
  
  const bucket = storage.bucket(BOUNDARY_PACKS_BUCKET);
  // Handle both direct files and subdirectories (e.g., us/adm3/ca.json.gz)
  const remotePath = `${BOUNDARY_PACKS_PREFIX}/${countryCode}/${fileName}`;
  
  try {
    const file = bucket.file(remotePath);
    const [exists] = await file.exists();
    if (!exists) return null;
    
    const [buffer] = await file.download();
    return gunzipSync(buffer).toString('utf8');
  } catch (error) {
    console.warn(`Failed to load from GCS: ${remotePath}`, error.message);
    return null;
  }
}

function loadFromLocal(countryCode, fileName) {
  // For geofabrik files, don't fall back to local (they should be in GCS)
  if (fileName.includes('geofabrik')) {
    return null;
  }
  
  const localPath = join(ADM_PACK_DIR, countryCode, fileName);
  if (!existsSync(localPath)) {
    // Try subdirectory (e.g., us/adm3/ca.json.gz)
    const parts = fileName.split('/');
    if (parts.length > 1) {
      const subDirPath = join(ADM_PACK_DIR, countryCode, ...parts);
      if (existsSync(subDirPath)) {
        try {
          const buffer = readFileSync(subDirPath);
          return gunzipSync(buffer).toString('utf8');
        } catch (e) {
          return null;
        }
      }
    }
    return null;
  }
  
  try {
    const buffer = readFileSync(localPath);
    return gunzipSync(buffer).toString('utf8');
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // 1 year cache
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const countryCode = (req.query.country || req.query.countryCode || '').toString().toLowerCase();
  const fileName = (req.query.file || req.query.fileName || '').toString();
  
  if (!countryCode || !fileName) {
    return res.status(400).json({ error: 'Missing country or file parameter' });
  }

  try {
    // Try GCS first (production)
    const gcsData = await loadFromGCS(countryCode, fileName);
    if (gcsData) {
      try {
        const data = JSON.parse(gcsData);
        return res.status(200).json(data);
      } catch (e) {
        console.error('Failed to parse GCS data:', e.message);
      }
    }
    
    // Fall back to local file (only for non-geofabrik files)
    const localData = loadFromLocal(countryCode, fileName);
    if (localData) {
      try {
        const data = JSON.parse(localData);
        return res.status(200).json(data);
      } catch (e) {
        console.error('Failed to parse local data:', e.message);
      }
    }
    
    return res.status(404).json({ error: 'Boundary pack not found' });
  } catch (error) {
    console.error('Error loading boundary pack:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
