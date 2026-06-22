import { Storage } from '@google-cloud/storage';
import NodeID3 from 'node-id3';
import { getStorageClientFromEnv } from './lib/gcp-credentials.js';

let storageClient = null;
function getStorage() {
  if (storageClient) return storageClient;
  storageClient = getStorageClientFromEnv(Storage);
  return storageClient;
}

function getUserDefinedEntries(tags) {
  const raw = tags?.userDefinedText;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return [raw];
  return [];
}

function extractUserDefinedTag(tags, description) {
  const wanted = String(description || '').trim().toLowerCase();
  if (!wanted) return '';
  const entries = getUserDefinedEntries(tags);
  const match = entries.find((entry) => String(entry?.description || '').trim().toLowerCase() === wanted);
  return String(match?.value || '').trim();
}

function extractVoiceFromTags(tags) {
  const voiceTag = extractUserDefinedTag(tags, 'voice');
  if (voiceTag) return voiceTag;

  const modelCommentVoice = String(tags?.comment?.text || '').trim();
  if (!modelCommentVoice) return '';
  const match = modelCommentVoice.match(/ - ([^-]+?) - [a-z]{2}(?:-[A-Z]{2})?$/i);
  return match ? String(match[1] || '').trim() : '';
}

function extractModelIdFromTags(tags) {
  const modelTag = extractUserDefinedTag(tags, 'model_id');
  if (modelTag) return modelTag;
  return '';
}

function extractVoiceIdFromTags(tags) {
  return extractUserDefinedTag(tags, 'voice_id') || extractUserDefinedTag(tags, 'voiceId');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'method_not_allowed' });

  const storage = getStorage();
  if (!storage) {
    return res.status(500).json({
      success: false,
      error: 'gcs_unavailable',
      message: 'Could not initialize Google Cloud Storage client.',
    });
  }

  const bucketName = (req.query.bucket && String(req.query.bucket)) || process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';
  const objectPath = req.query.path && String(req.query.path);
  if (!objectPath) {
    return res.status(400).json({ success: false, error: 'bad_request', message: 'path parameter is required' });
  }

  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(objectPath);
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({ success: false, error: 'not_found', message: `File not found: ${objectPath}` });
    }

    const [buffer] = await file.download();
    const tags = NodeID3.read(buffer) || {};
    const voice = extractVoiceFromTags(tags);
    const voiceId = extractVoiceIdFromTags(tags);
    const modelId = extractModelIdFromTags(tags);
    return res.status(200).json({
      success: true,
      bucket: bucketName,
      path: objectPath,
      voice: voice || '',
      voice_id: voiceId || '',
      model_id: modelId || '',
      tags: {
        artist: tags?.artist || '',
        comment: tags?.comment?.text || '',
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      message: error?.message || String(error),
    });
  }
}

