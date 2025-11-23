/**
 * Validation Storage API Endpoint (GCS-backed)
 * Saves and loads validation results to/from Google Cloud Storage.
 * Falls back to in-memory storage if GCS is not available.
 */

import { Storage } from '@google-cloud/storage';

// In-memory fallback storage
let inMemoryValidationData = {
  validation_results: {},
  metadata: {
    created: new Date().toISOString(),
    version: '1.0',
    item_count: 0,
    validation_count: 0,
    description: 'Fallback in-memory validation results for Levante Translation Dashboard'
  }
};

// GCS configuration (aligned with language-config API)
const BUCKET_NAME = process.env.AUDIO_DEV_BUCKET || process.env.VALIDATION_BUCKET || 'levante-audio-dev';
const FILE_PATH = process.env.VALIDATION_RESULTS_OBJECT || 'validations/validation_results.json';

function getStorageClient() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!serviceAccountJson) return null;
  let credentials;
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch (e) {
    console.warn('GCS credentials env is not valid JSON');
    return null;
  }
  return new Storage({ credentials });
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    switch (req.method) {
      case 'GET':
        return await getValidationResults(req, res);
      case 'POST':
        return await saveValidationResults(req, res);
      case 'PUT':
        return await updateValidationResults(req, res);
      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Validation storage error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}

async function loadFromGCS() {
  const storage = getStorageClient();
  if (!storage) return null;
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(FILE_PATH);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [data] = await file.download();
    const validationData = JSON.parse(data.toString());
    console.log(`☁️ Loaded validation results from GCS: ${Object.keys(validationData.validation_results || {}).length} items`);
    return validationData;
  } catch (e) {
    console.warn('Failed to load validation results from GCS:', e.message);
    return null;
  }
}

async function saveToGCS(validationData) {
  const storage = getStorageClient();
  if (!storage) return false;
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(FILE_PATH);
    await file.save(JSON.stringify(validationData, null, 2), { contentType: 'application/json', resumable: false });
    console.log(`☁️ Saved validation results to GCS: ${validationData.metadata.item_count} items, ${validationData.metadata.validation_count} validations`);
    return true;
  } catch (e) {
    console.warn('Failed to save validation results to GCS:', e.message);
    return false;
  }
}

async function getValidationResults(_req, res) {
  try {
    let validationData = await loadFromGCS();
    if (!validationData) validationData = inMemoryValidationData;
    return res.status(200).json({
      success: true,
      data: validationData,
      source: validationData === inMemoryValidationData ? 'memory' : 'gcs',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    throw new Error(`Failed to load validation results: ${error.message}`);
  }
}

async function saveValidationResults(req, res) {
  try {
    const { validation_results, metadata } = req.body || {};
    if (!validation_results) {
      return res.status(400).json({ error: 'Missing validation_results in request body' });
    }

    // Count total validations
    let totalValidations = 0;
    Object.keys(validation_results).forEach(itemId => {
      totalValidations += Object.keys(validation_results[itemId] || {}).length;
    });

    const validationData = {
      validation_results,
      metadata: {
        ...metadata,
        saved: new Date().toISOString(),
        version: '1.0',
        item_count: Object.keys(validation_results).length,
        validation_count: totalValidations
      }
    };

    const gcsSuccess = await saveToGCS(validationData);
    inMemoryValidationData = validationData; // always keep memory copy
    return res.status(200).json({
      success: true,
      message: `Validation results saved successfully (${gcsSuccess ? 'gcs' : 'memory'})`,
      source: gcsSuccess ? 'gcs' : 'memory',
      metadata: validationData.metadata,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    throw new Error(`Failed to save validation results: ${error.message}`);
  }
}

async function updateValidationResults(req, res) {
  try {
    const { item_id, language, validation_data } = req.body || {};
    if (!item_id || !language || !validation_data) {
      return res.status(400).json({ error: 'Missing required fields: item_id, language, validation_data' });
    }

    let currentData = await loadFromGCS();
    if (!currentData) currentData = inMemoryValidationData;

    if (!currentData.validation_results[item_id]) currentData.validation_results[item_id] = {};
    currentData.validation_results[item_id][language] = {
      ...validation_data,
      updated: new Date().toISOString()
    };

    currentData.metadata.last_updated = new Date().toISOString();
    currentData.metadata.item_count = Object.keys(currentData.validation_results).length;
    let totalValidations = 0;
    Object.keys(currentData.validation_results).forEach(i => { totalValidations += Object.keys(currentData.validation_results[i] || {}).length; });
    currentData.metadata.validation_count = totalValidations;

    const gcsSuccess = await saveToGCS(currentData);
    inMemoryValidationData = currentData;
    return res.status(200).json({
      success: true,
      message: `Validation entry updated successfully (${gcsSuccess ? 'gcs' : 'memory'})`,
      source: gcsSuccess ? 'gcs' : 'memory',
      item_id,
      language,
      metadata: currentData.metadata,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    throw new Error(`Failed to update validation results: ${error.message}`);
  }
}