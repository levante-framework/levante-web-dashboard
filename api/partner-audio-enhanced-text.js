import { Storage } from '@google-cloud/storage';

const BUCKET_NAME = process.env.VALIDATION_BUCKET || process.env.TOOLS_BUCKET || 'levante-tools';
const PREFIX = process.env.PARTNER_AUDIO_ENHANCED_TEXT_PREFIX || 'partner-audio/enhanced-text';

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) return null;
  try {
    const credentials = JSON.parse(raw);
    return new Storage({ credentials });
  } catch (_) {
    return null;
  }
}

function sanitizeLangCode(langCode) {
  const cleaned = String(langCode || '').trim().toLowerCase().replace(/_/g, '-');
  if (!cleaned) return '';
  return cleaned.replace(/[^a-z0-9._-]/g, '');
}

function alternateLangCode(langCode) {
  const safe = sanitizeLangCode(langCode);
  if (!safe) return '';
  if (safe.includes('-')) return safe.replace(/-/g, '_');
  if (safe.includes('_')) return safe.replace(/_/g, '-');
  return '';
}

function objectPathForLang(langCode) {
  const safe = sanitizeLangCode(langCode);
  if (!safe) return '';
  return `${PREFIX}/${safe}.json`;
}

async function readLangPayload(storage, langCode) {
  const objectPath = objectPathForLang(langCode);
  if (!objectPath) return { entries: {}, objectPath: '' };
  const bucket = storage.bucket(BUCKET_NAME);
  let file = bucket.file(objectPath);
  let [exists] = await file.exists();
  let resolvedPath = objectPath;
  if (!exists) {
    const alt = alternateLangCode(langCode);
    if (alt) {
      const altPath = `${PREFIX}/${alt}.json`;
      const altFile = bucket.file(altPath);
      const [altExists] = await altFile.exists();
      if (altExists) {
        file = altFile;
        exists = true;
        resolvedPath = altPath;
      }
    }
  }
  if (!exists) return { entries: {}, objectPath };
  const [buf] = await file.download();
  let parsed = {};
  try {
    parsed = JSON.parse(buf.toString('utf-8'));
  } catch (_) {
    parsed = {};
  }
  const entries = parsed && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)
    ? parsed.entries
    : {};
  return { entries, objectPath: resolvedPath, metadata: parsed?.metadata || {} };
}

async function writeLangPayload(storage, langCode, entries) {
  const objectPath = objectPathForLang(langCode);
  if (!objectPath) throw new Error('Invalid langCode');
  const bucket = storage.bucket(BUCKET_NAME);
  const file = bucket.file(objectPath);
  const payload = {
    metadata: {
      langCode: sanitizeLangCode(langCode),
      updatedAt: new Date().toISOString(),
      entryCount: Object.keys(entries || {}).length,
    },
    entries,
  };
  await file.save(JSON.stringify(payload, null, 2), {
    contentType: 'application/json',
    resumable: false,
  });
  const alt = alternateLangCode(langCode);
  if (alt) {
    const altFile = bucket.file(`${PREFIX}/${alt}.json`);
    await altFile.save(JSON.stringify(payload, null, 2), {
      contentType: 'application/json',
      resumable: false,
    });
  }
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
      source: 'none',
    });
  }

  try {
    if (req.method === 'GET') {
      const langCode = String(req.query?.langCode || '').trim();
      if (!langCode) return res.status(400).json({ ok: false, error: 'Missing langCode query param' });
      const { entries, objectPath, metadata } = await readLangPayload(storage, langCode);
      return res.status(200).json({
        ok: true,
        langCode: sanitizeLangCode(langCode),
        bucket: BUCKET_NAME,
        objectPath,
        entries,
        metadata,
      });
    }

    if (req.method === 'POST') {
      const langCode = String(req.body?.langCode || '').trim();
      const itemId = String(req.body?.itemId || '').trim();
      const text = String(req.body?.text || '').trim();
      const updatedBy = String(req.body?.updatedBy || '').trim();
      const userEdited = req.body?.userEdited === true;
      const sourceTranslationText = String(req.body?.sourceTranslationText || '').trim();
      if (!langCode || !itemId) {
        return res.status(400).json({ ok: false, error: 'Missing required fields: langCode, itemId' });
      }
      const loaded = await readLangPayload(storage, langCode);
      const entries = { ...(loaded.entries || {}) };
      if (!text) {
        delete entries[itemId];
      } else {
        entries[itemId] = {
          text,
          updatedAt: new Date().toISOString(),
          updatedBy: updatedBy || '',
          userEdited,
          sourceTranslationText,
        };
      }
      const objectPath = await writeLangPayload(storage, langCode, entries);
      return res.status(200).json({
        ok: true,
        langCode: sanitizeLangCode(langCode),
        itemId,
        updated: !!text,
        removed: !text,
        bucket: BUCKET_NAME,
        objectPath,
      });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
}

