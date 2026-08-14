import { Storage } from '@google-cloud/storage';

const BUCKET_NAME = process.env.PARTNER_AUDIO_STAGED_APPROVALS_BUCKET
  || process.env.VALIDATION_BUCKET
  || process.env.TOOLS_BUCKET
  || process.env.ASSETS_DRAFT_BUCKET
  || 'levante-assets-draft';
const PREFIX = String(process.env.PARTNER_AUDIO_STAGED_APPROVALS_PREFIX || 'partner-audio/staged-approvals')
  .trim()
  .replace(/^\/+|\/+$/g, '');

let storageClient = null;
function getStorageClient() {
  if (storageClient) return storageClient;
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) return null;
  try {
    const credentials = JSON.parse(raw);
    storageClient = new Storage({ credentials });
    return storageClient;
  } catch (_) {
    return null;
  }
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

// Approval baselines: baseId -> draft "updated" timestamp (ms) captured when the
// item was approved. Shared with staged approvals so the reopen logic behaves
// consistently across devices/users.
function normalizeBaselines(baselines) {
  const normalized = {};
  if (!baselines || typeof baselines !== 'object' || Array.isArray(baselines)) return normalized;
  Object.entries(baselines).forEach(([baseId, ts]) => {
    const cleanId = String(baseId || '').trim().toLowerCase();
    const numericTs = Number(ts);
    if (cleanId && Number.isFinite(numericTs) && numericTs > 0) {
      normalized[cleanId] = numericTs;
    }
  });
  return normalized;
}

function normalizeRemovedIds(removedIds) {
  if (!Array.isArray(removedIds)) return [];
  return Array.from(new Set(
    removedIds
      .map((id) => String(id || '').trim().toLowerCase())
      .filter(Boolean)
  ));
}

// Union-merge task maps so concurrent approvers on the same language cannot
// clobber each other's staged tasks. Explicit removals are applied after the
// union so unapprove/reopen still works.
function mergeTasks(existingTasks, incomingTasks, removedIds = []) {
  const removed = new Set(normalizeRemovedIds(removedIds));
  const merged = {};

  const addAll = (source) => {
    Object.entries(source || {}).forEach(([taskName, ids]) => {
      if (!merged[taskName]) merged[taskName] = new Set();
      (ids || []).forEach((id) => {
        const cleanId = String(id || '').trim().toLowerCase();
        if (cleanId && !removed.has(cleanId)) merged[taskName].add(cleanId);
      });
    });
  };

  addAll(existingTasks);
  addAll(incomingTasks);

  const normalized = {};
  Object.entries(merged).forEach(([taskName, idSet]) => {
    const ids = Array.from(idSet);
    if (ids.length > 0) normalized[taskName] = ids;
  });
  return normalized;
}

function mergeBaselines(existingBaselines, incomingBaselines, removedIds = []) {
  const removed = new Set(normalizeRemovedIds(removedIds));
  const merged = { ...(existingBaselines || {}) };

  Object.entries(incomingBaselines || {}).forEach(([baseId, ts]) => {
    const cleanId = String(baseId || '').trim().toLowerCase();
    const numericTs = Number(ts);
    if (!cleanId || !Number.isFinite(numericTs) || numericTs <= 0 || removed.has(cleanId)) return;
    const prev = Number(merged[cleanId] || 0);
    // Keep the newest baseline timestamp when both sides have one.
    merged[cleanId] = Math.max(prev, numericTs);
  });

  removed.forEach((id) => {
    delete merged[id];
  });
  return normalizeBaselines(merged);
}

async function readLangPayload(storage, langCode) {
  const objectPath = objectPathForLang(langCode);
  if (!objectPath) return { tasks: {}, baselines: {}, objectPath: '' };
  const bucket = storage.bucket(BUCKET_NAME);
  const file = bucket.file(objectPath);
  const [exists] = await file.exists();
  if (!exists) return { tasks: {}, baselines: {}, objectPath };
  const [buf] = await file.download();
  let parsed = {};
  try {
    parsed = JSON.parse(buf.toString('utf-8'));
  } catch (_) {
    parsed = {};
  }
  const tasks = normalizeTasks(parsed?.tasks || {});
  const baselines = normalizeBaselines(parsed?.baselines || {});
  return { tasks, baselines, objectPath, metadata: parsed?.metadata || {} };
}

async function writeLangPayload(storage, langCode, tasks, baselines, removedIds = []) {
  const objectPath = objectPathForLang(langCode);
  if (!objectPath) throw new Error('Invalid langCode');
  const bucket = storage.bucket(BUCKET_NAME);
  const file = bucket.file(objectPath);
  const existing = await readLangPayload(storage, langCode);
  const incomingTasks = normalizeTasks(tasks);

  // Always merge with the current server payload. A full replace allowed one
  // client's in-memory snapshot to erase another concurrent approver's tasks.
  const normalizedTasks = mergeTasks(existing.tasks || {}, incomingTasks, removedIds);

  let normalizedBaselines;
  if (baselines === undefined) {
    normalizedBaselines = mergeBaselines(existing.baselines || {}, {}, removedIds);
  } else {
    normalizedBaselines = mergeBaselines(
      existing.baselines || {},
      normalizeBaselines(baselines),
      removedIds
    );
  }

  const payload = {
    metadata: {
      langCode: sanitizeLangCode(langCode),
      updatedAt: new Date().toISOString(),
      taskCount: Object.keys(normalizedTasks).length,
      baselineCount: Object.keys(normalizedBaselines).length,
      mergeMode: 'union-with-removals'
    },
    tasks: normalizedTasks,
    baselines: normalizedBaselines
  };
  await file.save(JSON.stringify(payload, null, 2), {
    contentType: 'application/json',
    resumable: false
  });
  return {
    objectPath,
    tasks: normalizedTasks,
    baselines: normalizedBaselines
  };
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
      const { tasks, baselines, objectPath, metadata } = await readLangPayload(storage, langCode);
      return res.status(200).json({
        ok: true,
        langCode: sanitizeLangCode(langCode),
        bucket: BUCKET_NAME,
        objectPath,
        tasks,
        baselines,
        metadata
      });
    }

    if (req.method === 'POST') {
      const langCode = String(req.body?.langCode || '').trim();
      const tasks = normalizeTasks(req.body?.tasks || {});
      // Only treat baselines as authoritative when the field is present; otherwise
      // leave the stored baselines untouched (aside from explicit removals).
      const hasBaselines = Object.prototype.hasOwnProperty.call(req.body || {}, 'baselines');
      const baselines = hasBaselines ? normalizeBaselines(req.body?.baselines || {}) : undefined;
      const removedIds = normalizeRemovedIds(req.body?.removedIds || req.body?.unstageIds || []);
      if (!langCode) {
        return res.status(400).json({ ok: false, error: 'Missing required field: langCode' });
      }
      const written = await writeLangPayload(storage, langCode, tasks, baselines, removedIds);
      return res.status(200).json({
        ok: true,
        langCode: sanitizeLangCode(langCode),
        taskCount: Object.keys(written.tasks || {}).length,
        baselineCount: Object.keys(written.baselines || {}).length,
        removedCount: removedIds.length,
        bucket: BUCKET_NAME,
        objectPath: written.objectPath,
        mergeMode: 'union-with-removals',
        tasks: written.tasks,
        baselines: written.baselines
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
