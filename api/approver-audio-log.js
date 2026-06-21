import { Storage } from '@google-cloud/storage';
import crypto from 'crypto';

const DEFAULT_BUCKET = String(process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft').trim();
const LOG_PREFIX = 'logs/approver-audio-events';

let storageClient = null;

function getStorage() {
  if (storageClient) return storageClient;
  try {
    const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GCP_SERVICE_ACCOUNT_JSON;
    if (json) {
      const credentials = JSON.parse(json);
      storageClient = new Storage({ credentials, projectId: credentials.project_id });
      return storageClient;
    }
    storageClient = new Storage();
    return storageClient;
  } catch (error) {
    console.warn('approver-audio-log: failed to init storage client', error);
    return null;
  }
}

function safeText(value, maxLen = 500) {
  return String(value || '').trim().slice(0, maxLen);
}

function buildObjectPath(now = new Date()) {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const iso = now.toISOString().replace(/[:.]/g, '-');
  const nonce = crypto.randomBytes(6).toString('hex');
  return `${LOG_PREFIX}/${yyyy}/${mm}/${dd}/${iso}-${nonce}.json`;
}

function normalizePayload(body = {}) {
  const itemId = safeText(body.itemId, 300);
  const baseItemId = safeText(body.baseItemId || body.itemBaseId, 300);
  const langCode = safeText(body.langCode, 32);
  const eventType = safeText(body.eventType, 80).toLowerCase();
  const approver = safeText(body.approver, 160);
  const approvedBy = safeText(body.approved_by || body.approvedBy || body.approver, 160);
  const approvedAtRaw = safeText(body.approved_at || body.approvedAt || '', 64);
  const authMethod = safeText(body.authMethod, 64);
  const task = safeText(body.task, 120);
  const tab = safeText(body.tab, 40);
  const service = safeText(body.service, 80);
  const modelId = safeText(body.modelId, 120);
  const voiceName = safeText(body.voiceName, 200);
  const voiceId = safeText(body.voiceId, 120);
  const savePath = safeText(body.savePath, 600);
  const saveBucket = safeText(body.saveBucket, 120);
  const saveVersion = Number.isFinite(Number(body.saveVersion)) ? Number(body.saveVersion) : null;
  const regenerateCountSinceLastSave = Number.isFinite(Number(body.regenerateCountSinceLastSave))
    ? Math.max(0, Number(body.regenerateCountSinceLastSave))
    : null;
  const totalRegenerationsForItem = Number.isFinite(Number(body.totalRegenerationsForItem))
    ? Math.max(0, Number(body.totalRegenerationsForItem))
    : null;
  const totalSavesForItem = Number.isFinite(Number(body.totalSavesForItem))
    ? Math.max(0, Number(body.totalSavesForItem))
    : null;
  const generatedTextLength = Number.isFinite(Number(body.generatedTextLength))
    ? Math.max(0, Number(body.generatedTextLength))
    : null;
  const originalTranslation = safeText(body.originalTranslation, 4000);
  const audioEnhancedText = safeText(body.audioEnhancedText, 4000);
  const normalizeCompare = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const normalizedOriginal = normalizeCompare(originalTranslation);
  const normalizedEnhanced = normalizeCompare(audioEnhancedText);
  const usedAudioEnhancedText = body.usedAudioEnhancedText === true;
  const enhancedTextChanged = usedAudioEnhancedText
    && !!normalizedEnhanced
    && !!normalizedOriginal
    && normalizedEnhanced !== normalizedOriginal;
  const enhancedTextCharDelta = usedAudioEnhancedText
    ? (normalizedEnhanced.length - normalizedOriginal.length)
    : null;

  return {
    eventType,
    itemId,
    baseItemId,
    langCode,
    task,
    tab,
    approver,
    approved_by: approvedBy,
    approved_at: approvedAtRaw,
    authMethod,
    service,
    modelId,
    voiceName,
    voiceId,
    savePath,
    saveBucket,
    saveVersion,
    regenerateCountSinceLastSave,
    totalRegenerationsForItem,
    totalSavesForItem,
    generatedTextLength,
    usedAudioEnhancedText,
    originalTranslation,
    audioEnhancedText,
    enhancedTextChanged,
    enhancedTextCharDelta,
    hadPendingGeneratedAudio: body.hadPendingGeneratedAudio === true,
    savedGeneratedAudio: body.savedGeneratedAudio === true,
    sessionId: safeText(body.sessionId, 120),
    clientTimestamp: safeText(body.clientTimestamp, 64),
    clientVersion: safeText(body.clientVersion, 80)
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'method_not_allowed' });

  try {
    const payload = normalizePayload(req.body || {});
    if (!payload.eventType || !payload.itemId || !payload.langCode) {
      return res.status(400).json({
        success: false,
        error: 'bad_request',
        message: 'eventType, itemId, and langCode are required'
      });
    }

    const storage = getStorage();
    if (!storage) {
      return res.status(500).json({
        success: false,
        error: 'gcs_unavailable',
        message: 'Could not initialize Google Cloud Storage client.'
      });
    }

    const now = new Date();
    const bucketName = String(DEFAULT_BUCKET || 'levante-assets-draft').trim();
    const objectPath = buildObjectPath(now);
    const ipRaw = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    const ip = String(ipRaw || '').split(',')[0].trim();
    const userAgent = safeText(req.headers['user-agent'] || '', 500);

    const record = {
      ...payload,
      serverTimestamp: now.toISOString(),
      requestMeta: {
        ip,
        userAgent
      }
    };

    // Ensure explicit approval keys are always present in the log payload.
    // If caller did not provide approved_at, default to server time.
    if (!record.approved_by) {
      record.approved_by = String(record.approver || '').trim();
    }
    if (!record.approved_at) {
      record.approved_at = record.serverTimestamp;
    }

    const bucket = storage.bucket(bucketName);
    const file = bucket.file(objectPath);
    await file.save(JSON.stringify(record, null, 2), {
      contentType: 'application/json',
      resumable: false
    });

    return res.status(200).json({
      success: true,
      bucket: bucketName,
      path: objectPath
    });
  } catch (error) {
    console.error('approver-audio-log handler error', error);
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      message: error?.message || String(error)
    });
  }
}

