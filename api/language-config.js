/**
 * Language Config API
 * GET:  Load language_config.json from GCS bucket
 * PUT:  Save language_config.json to GCS bucket
 *
 * Environment variables expected (configure in Vercel Project Settings):
 * - GCP_SERVICE_ACCOUNT_JSON: JSON string of the GCP service account key
 * - AUDIO_DEV_BUCKET: Bucket name (default: "levante-assets-dev")
 * - LANGUAGE_CONFIG_OBJECT: Object name (default: "language_config.json")
 */

import { Storage } from '@google-cloud/storage';
import crypto from 'crypto';

const BUCKET_NAME = process.env.AUDIO_DEV_BUCKET || 'levante-assets-dev';
const OBJECT_NAME = process.env.LANGUAGE_CONFIG_OBJECT || 'language_config.json';
const HASH_PREFIX = 'scrypt$';
// Number of approver credential slots supported per language. Update this single
// value to change how many approvers each language can have.
const APPROVER_SLOTS = [1, 2, 3, 4];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUserId(value) {
  return String(value || '').trim().toLowerCase();
}

function isHashedApproverPassword(value) {
  return String(value || '').startsWith(HASH_PREFIX);
}

function hashApproverPassword(password) {
  const plain = String(password || '');
  const N = 16384;
  const r = 8;
  const p = 1;
  const keyLength = 64;
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plain, salt, keyLength, { N, r, p }).toString('hex');
  return `${HASH_PREFIX}${N}$${r}$${p}$${salt}$${derived}`;
}

function timingSafeEqualHex(aHex, bHex) {
  const a = Buffer.from(String(aHex || ''), 'hex');
  const b = Buffer.from(String(bHex || ''), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyApproverPassword(candidatePassword, storedPassword) {
  const provided = String(candidatePassword || '');
  const stored = String(storedPassword || '');
  if (!provided || !stored) return false;

  if (!isHashedApproverPassword(stored)) {
    return provided === stored;
  }

  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const expectedHex = parts[5];
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !salt || !expectedHex) {
    return false;
  }
  try {
    const derivedHex = crypto.scryptSync(provided, salt, 64, { N, r, p }).toString('hex');
    return timingSafeEqualHex(derivedHex, expectedHex);
  } catch (_error) {
    return false;
  }
}

function findMatchingApprover(languages, userId, password) {
  const normalized = normalizeUserId(userId);
  const providedPassword = String(password || '');
  if (!normalized || !providedPassword) return null;
  for (const [languageName, cfgRaw] of Object.entries(languages || {})) {
    const cfg = isObject(cfgRaw) ? cfgRaw : {};
    for (const slot of APPROVER_SLOTS) {
      const userKey = `approver${slot}_userid`;
      const passKey = `approver${slot}_password`;
      const candidateUser = normalizeUserId(cfg[userKey]);
      const storedPassword = String(cfg[passKey] || '');
      if (!candidateUser || !storedPassword) continue;
      if (candidateUser === normalized && verifyApproverPassword(providedPassword, storedPassword)) {
        return { languageName, slot, langCode: String(cfg.lang_code || '') };
      }
    }
  }
  return null;
}

async function loadRemoteLanguageConfigObject() {
  const storage = getStorageClient();
  const bucket = storage.bucket(BUCKET_NAME);
  const file = bucket.file(OBJECT_NAME);
  const [exists] = await file.exists();
  if (!exists) return {};
  const [contents] = await file.download();
  return JSON.parse(contents.toString('utf8'));
}

function stripApproverPasswords(languages) {
  const input = isObject(languages) ? languages : {};
  const redacted = {};
  Object.entries(input).forEach(([name, cfgRaw]) => {
    const cfg = isObject(cfgRaw) ? { ...cfgRaw } : {};
    for (const slot of APPROVER_SLOTS) {
      const passKey = `approver${slot}_password`;
      const passwordRaw = String(cfg[passKey] || '');
      delete cfg[passKey];
      cfg[`approver${slot}_password_set`] = Boolean(passwordRaw);
    }
    redacted[name] = cfg;
  });
  return redacted;
}

function mergeAndHashApproverCredentials(nextLanguages, existingLanguages) {
  const next = normalizeLanguageDisplayNames(nextLanguages);
  const existing = normalizeLanguageDisplayNames(existingLanguages);
  const merged = {};

  Object.entries(next).forEach(([name, cfgRaw]) => {
    const cfg = isObject(cfgRaw) ? { ...cfgRaw } : {};
    const previous = isObject(existing[name]) ? { ...existing[name] } : {};

    for (const slot of APPROVER_SLOTS) {
      const userKey = `approver${slot}_userid`;
      const passKey = `approver${slot}_password`;
      const nextUserId = normalizeUserId(cfg[userKey]);
      const prevUserId = normalizeUserId(previous[userKey]);
      const nextPasswordRaw = String(cfg[passKey] || '');
      const prevPasswordRaw = String(previous[passKey] || '');
      const trimmedPassword = nextPasswordRaw.trim();

      if (!nextUserId) {
        delete cfg[userKey];
        delete cfg[passKey];
        continue;
      }

      cfg[userKey] = String(cfg[userKey] || '').trim();

      if (!trimmedPassword || trimmedPassword === '********') {
        if (nextUserId === prevUserId && prevPasswordRaw) {
          cfg[passKey] = prevPasswordRaw;
        } else {
          delete cfg[passKey];
        }
        continue;
      }

      if (isHashedApproverPassword(trimmedPassword)) {
        cfg[passKey] = trimmedPassword;
      } else {
        cfg[passKey] = hashApproverPassword(trimmedPassword);
      }
    }

    for (const slot of APPROVER_SLOTS) {
      delete cfg[`approver${slot}_password_set`];
    }
    merged[name] = cfg;
  });

  return merged;
}

function normalizeLanguageDisplayNames(languages) {
  const input = languages && typeof languages === 'object' ? languages : {};
  const normalized = {};
  Object.entries(input).forEach(([name, cfgRaw]) => {
    const cfg = cfgRaw && typeof cfgRaw === 'object' ? { ...cfgRaw } : {};
    const langCode = String(cfg.lang_code || '').trim().toLowerCase();
    let nextName = String(name || '').trim();
    if (langCode === 'es-co' && (/^spanish$/i.test(nextName) || /spanish\s*\(colombia\)/i.test(nextName))) nextName = 'Spanish (Colombia)';
    if (langCode === 'es-ar' && /^spanish$/i.test(nextName)) nextName = 'Spanish (Argentina)';
    if ((langCode === 'en' || langCode === 'en-us') && /^english$/i.test(nextName)) nextName = 'English (United States)';
    if ((langCode === 'de' || langCode === 'de-de') && /^german$/i.test(nextName)) nextName = 'German (Germany)';
    if (!cfg.display_name) cfg.display_name = nextName;
    if (langCode === 'es-co' && (/^spanish$/i.test(String(cfg.display_name)) || /spanish\s*\(colombia\)/i.test(String(cfg.display_name)))) cfg.display_name = 'Spanish (Colombia)';
    if (langCode === 'es-ar' && /^spanish$/i.test(String(cfg.display_name))) cfg.display_name = 'Spanish (Argentina)';
    if ((langCode === 'en' || langCode === 'en-us') && /^english$/i.test(String(cfg.display_name))) cfg.display_name = 'English (United States)';
    if ((langCode === 'de' || langCode === 'de-de') && /^german$/i.test(String(cfg.display_name))) cfg.display_name = 'German (Germany)';
    // Migrate legacy default voice for Spanish (Argentina) to current Melody voice.
    if (langCode === 'es-ar' && /(malena|melania)\s+tango|sophia|melanie/i.test(String(cfg.voice || ''))) {
      cfg.voice = 'Melody - Ecommerce Voice';
      cfg.voice_id = 'bN1bDXgDIGX5lw0rtY2B';
    }
    normalized[nextName] = cfg;
  });
  return normalized;
}

function getStorageClient() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON is not set');
  }
  let credentials;
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch (e) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  return new Storage({ credentials });
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    switch (req.method) {
      case 'GET':
        return await handleGet(req, res);
      case 'PUT':
        return await handlePut(req, res);
      case 'POST':
        if (String(req.query?.action || '').toLowerCase() === 'verify-approver') {
          return await handleApproverVerify(req, res);
        }
        return res.status(405).json({ success: false, error: 'Method not allowed' });
      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('language-config API error:', error);
    const status = error.message?.includes('not set') ? 500 : 500;
    return res.status(status).json({ success: false, error: error.message });
  }
}

async function handleGet(_req, res) {
  try {
    const json = await loadRemoteLanguageConfigObject();
    if (!json || !json.languages) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      return res.status(200).json({ success: true, languages: null, message: 'No remote language_config.json found' });
    }
    json.languages = stripApproverPasswords(normalizeLanguageDisplayNames(json.languages));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json({ success: true, ...json });
  } catch (error) {
    // If credentials are missing or access denied, return a non-fatal response so clients can fallback
    console.warn('language-config GET warning:', error.message);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json({ success: false, languages: null, error: error.message });
  }
}

async function handleApproverVerify(req, res) {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const userId = String(payload.userId || '').trim();
    const password = String(payload.password || '');
    if (!userId || !password) {
      return res.status(400).json({ success: false, error: 'Missing userId or password' });
    }

    const json = await loadRemoteLanguageConfigObject();
    const languages = normalizeLanguageDisplayNames(json?.languages || {});
    const match = findMatchingApprover(languages, userId, password);
    if (!match) {
      return res.status(401).json({ success: false, error: 'Invalid user ID or password.' });
    }
    return res.status(200).json({
      success: true,
      allowedLanguage: match.languageName,
      langCode: match.langCode,
      slot: match.slot,
    });
  } catch (error) {
    console.error('language-config approver verify error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Authentication failed' });
  }
}

async function handlePut(req, res) {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid JSON body' });
    }

    const { languages, metadata } = payload;
    if (!languages || typeof languages !== 'object') {
      return res.status(400).json({ success: false, error: 'Missing or invalid languages object' });
    }

    const storage = getStorageClient();
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(OBJECT_NAME);

    let existingLanguages = {};
    try {
      const [exists] = await file.exists();
      if (exists) {
        const [contents] = await file.download();
        const parsed = JSON.parse(contents.toString('utf8'));
        if (parsed && isObject(parsed.languages)) {
          existingLanguages = parsed.languages;
        }
      }
    } catch (readError) {
      console.warn('language-config PUT warning: failed to read existing config before merge:', readError?.message || readError);
    }

    const normalizedLanguages = mergeAndHashApproverCredentials(languages, existingLanguages);

    const now = new Date().toISOString();
    const toWrite = JSON.stringify({ languages: normalizedLanguages, metadata: { saved_at: now, ...(metadata || {}) } }, null, 2);
    await file.save(toWrite, { contentType: 'application/json', resumable: false, public: false, cacheControl: 'no-cache' });
    // Ensure the config is publicly readable so local tools (without creds) can fetch it
    try {
      await file.makePublic();
    } catch (e) {
      console.warn('language-config PUT warning: makePublic failed:', e?.message || e);
    }

    return res.status(200).json({ success: true, message: 'language_config saved', saved_at: now });
  } catch (error) {
    console.error('language-config PUT error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}


