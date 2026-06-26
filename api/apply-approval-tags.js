import { Storage } from '@google-cloud/storage';
import NodeID3 from 'node-id3';

const DEFAULT_BUCKET = process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';

let storageClient = null;
function getStorage() {
  if (storageClient) return storageClient;
  try {
    const json = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (json) {
      const credentials = JSON.parse(json);
      storageClient = new Storage({ credentials, projectId: credentials.project_id });
    } else {
      storageClient = new Storage();
    }
  } catch (error) {
    console.warn('apply-approval-tags: failed to init storage client', error);
    storageClient = null;
  }
  return storageClient;
}

function sanitizePath(value) {
  return (value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

function safeTagValue(value, maxLen = 512) {
  return String(value || '').trim().slice(0, maxLen);
}

function normalizeUserDefinedTextEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries
    .map((entry) => ({
      description: safeTagValue(entry?.description, 120),
      value: safeTagValue(entry?.value, 4000)
    }))
    .filter((entry) => entry.description && entry.value);
}

function upsertUserDefinedTag(entries, description, value) {
  const cleanDescription = safeTagValue(description, 120);
  const cleanValue = safeTagValue(value, 4000);
  if (!cleanDescription) return entries;
  const filtered = entries.filter((entry) => entry.description !== cleanDescription);
  if (cleanValue) {
    filtered.push({ description: cleanDescription, value: cleanValue });
  }
  return filtered;
}

// Writes approved_by / approved_at ID3 tags into the file in place, preserving
// any existing user-defined text frames (e.g. text, audio_enhanced_text).
async function applyApprovalId3Tags(file, { approver, approvedAt }) {
  const approverTag = safeTagValue(approver, 160);
  const approvedAtTag = safeTagValue(approvedAt, 80);
  if (!approverTag && !approvedAtTag) return false;

  const [rawAudio] = await file.download();
  let existingTags = {};
  try {
    existingTags = NodeID3.read(rawAudio) || {};
  } catch (_) {
    existingTags = {};
  }

  let userDefinedText = normalizeUserDefinedTextEntries(existingTags.userDefinedText);
  userDefinedText = upsertUserDefinedTag(userDefinedText, 'approved_by', approverTag);
  userDefinedText = upsertUserDefinedTag(userDefinedText, 'approved_at', approvedAtTag);

  let taggedAudio = rawAudio;
  try {
    taggedAudio = NodeID3.update({ userDefinedText }, rawAudio);
  } catch (error) {
    console.warn('apply-approval-tags: failed updating ID3 approval tags, keeping original bytes', error?.message || error);
    return false;
  }

  if (!Buffer.isBuffer(taggedAudio)) return false;
  await file.save(taggedAudio, { contentType: 'audio/mpeg', resumable: false, public: false });
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }

  try {
    const { bucket, path: objectPath, approver, approvedAt } = req.body || {};

    if (!objectPath) {
      res.status(400).json({ success: false, error: 'Missing path parameter' });
      return;
    }

    const approverTag = safeTagValue(approver, 160);
    const approvedAtTag = safeTagValue(approvedAt, 80) || new Date().toISOString();
    if (!approverTag && !approvedAtTag) {
      res.status(400).json({ success: false, error: 'Missing approver/approvedAt' });
      return;
    }

    const storage = getStorage();
    if (!storage) {
      res.status(500).json({ success: false, error: 'gcs_unavailable' });
      return;
    }

    const bucketName = bucket || DEFAULT_BUCKET;
    const sanitizedPath = sanitizePath(objectPath);
    const file = storage.bucket(bucketName).file(sanitizedPath);

    const [exists] = await file.exists();
    if (!exists) {
      res.status(404).json({ success: false, error: `File not found: ${sanitizedPath}` });
      return;
    }

    const tagsWritten = await applyApprovalId3Tags(file, {
      approver: approverTag,
      approvedAt: approvedAtTag
    });

    // Return the file's current "updated" timestamp so the client can record an
    // accurate approval baseline (used to detect later audio regenerations).
    let updatedAt = '';
    try {
      const [metadata] = await file.getMetadata();
      updatedAt = String(metadata?.updated || '');
    } catch (_) {
      updatedAt = '';
    }

    res.status(200).json({
      success: true,
      bucket: bucketName,
      path: sanitizedPath,
      tagsWritten,
      updatedAt,
      approver: approverTag,
      approvedAt: approvedAtTag
    });
  } catch (error) {
    console.error('apply-approval-tags error:', error);
    res.status(500).json({ success: false, error: 'internal_error', message: error?.message || String(error) });
  }
}
