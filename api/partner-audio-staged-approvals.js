import { Storage } from '@google-cloud/storage';
import { getStorageClientFromEnv, trimEnvValue } from './lib/gcp-credentials.js';

const BUCKET_NAME = trimEnvValue(
  process.env.PARTNER_AUDIO_STAGED_APPROVALS_BUCKET
    || process.env.VALIDATION_BUCKET
    || process.env.TOOLS_BUCKET
    || process.env.ASSETS_DRAFT_BUCKET,
  'levante-assets-draft'
);
const PREFIX = String(process.env.PARTNER_AUDIO_STAGED_APPROVALS_PREFIX || 'partner-audio/staged-approvals')
  .trim()
  .replace(/^\/+|\/+$/g, '');

let storageClient = null;
function getStorageClient() {
  if (storageClient) return storageClient;
  storageClient = getStorageClientFromEnv(Storage);
  return storageClient;
}

function sanitizeLangCode(langCode) {
  const cleaned = String(langCode || '').trim().toLowerCase().replace(/_/g, '-');
  if (!cleaned) return '';
  return cleaned.replace(/[^a-z0-9._-]/g, '');
}

function objectPathForLang(langCode) {
  const safe = sanitizeLangCode(langCode);
  if (!safe) return '';
  return `${PREFIX}/${safe}.json`;
}

function normalizeTasks(tasks) {
  const normalized = {};
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return normalized;
  Object.entries(tasks).forEach(([taskName, ids]) => {
    const cleanTask = String(taskName || '').trim();
    if (!cleanTask || !Array.isArray(ids)) return;
    const cleanIds = ids
      .map((id) => String(id || '').trim().toLowerCase())
      .filter(Boolean);
    if (cleanIds.length > 0) {
      normalized[cleanTask] = Array.from(new Set(cleanIds));
    }
  });
  return normalized;
}

async function readLangPayload(storage, langCode) {
  const objectPath = objectPathForLang(langCode);
  if (!objectPath) return { tasks: {}, objectPath: '' };
  const bucket = storage.bucket(BUCKET_NAME);
  const file = bucket.file(objectPath);
  const [exists] = await file.exists();
  if (!exists) return { tasks: {}, objectPath };
  const [buf] = await file.download();
  let parsed = {};
  try {
    parsed = JSON.parse(buf.toString('utf-8'));
  } catch (_) {
    parsed = {};
  }
  const tasks = normalizeTasks(parsed?.tasks || {});
  return { tasks, objectPath, metadata: parsed?.metadata || {} };
}

async function writeLangPayload(storage, langCode, tasks) {
  const objectPath = objectPathForLang(langCode);
  if (!objectPath) throw new Error('Invalid langCode');
  const bucket = storage.bucket(BUCKET_NAME);
  const file = bucket.file(objectPath);
  const normalizedTasks = normalizeTasks(tasks);
  const payload = {
    metadata: {
      langCode: sanitizeLangCode(langCode),
      updatedAt: new Date().toISOString(),
      taskCount: Object.keys(normalizedTasks).length
    },
    tasks: normalizedTasks
  };
  await file.save(JSON.stringify(payload, null, 2), {
    contentType: 'application/json',
    resumable: false
  });
  return objectPath;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const storage = getStorageClient();
  if (!storage) {
    return res.status(200).json({
      ok: false,
      reason: 'GCS credentials not configured',
      source: 'none'
    });
  }

  try {
    if (req.method === 'GET') {
      const langCode = String(req.query?.langCode || '').trim();
      if (!langCode) return res.status(400).json({ ok: false, error: 'Missing langCode query param' });
      const { tasks, objectPath, metadata } = await readLangPayload(storage, langCode);
      return res.status(200).json({
        ok: true,
        langCode: sanitizeLangCode(langCode),
        bucket: BUCKET_NAME,
        objectPath,
        tasks,
        metadata
      });
    }

    if (req.method === 'POST') {
      const langCode = String(req.body?.langCode || '').trim();
      const tasks = normalizeTasks(req.body?.tasks || {});
      if (!langCode) {
        return res.status(400).json({ ok: false, error: 'Missing required field: langCode' });
      }
      const objectPath = await writeLangPayload(storage, langCode, tasks);
      return res.status(200).json({
        ok: true,
        langCode: sanitizeLangCode(langCode),
        taskCount: Object.keys(tasks).length,
        bucket: BUCKET_NAME,
        objectPath
      });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
}
