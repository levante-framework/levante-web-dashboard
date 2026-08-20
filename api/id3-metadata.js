/**
 * ID3 metadata browser for levante-assets-{draft,dev,prod}.
 *
 * GET  ?action=tasks&bucket=
 * GET  ?action=locales&bucket=&task=
 * GET  ?action=files&bucket=&task=&locale=
 * GET  ?action=tags&bucket=&path=
 * POST { action: 'tags', bucket, paths: string[] }  — batch, max 20
 */

import { Storage } from '@google-cloud/storage';
import NodeID3 from 'node-id3';

const ALLOWED_BUCKETS = {
  draft: 'levante-assets-draft',
  dev: 'levante-assets-dev',
  prod: 'levante-assets-prod',
};

const SKIP_AUDIO_FOLDERS = new Set([
  'shared',
  'validations',
  '_gsdata_',
  'child-survey',
  'child_survey',
  'corpus',
  'translations',
  'visual',
]);

const KNOWN_CUSTOM_KEYS = [
  'service',
  'voice',
  'voice_id',
  'voiceId',
  'model_id',
  'lang_code',
  'text',
  'original_translation_text',
  'audio_enhanced_text',
  'used_audio_enhanced_text',
  'created',
  'source',
  'approved_by',
  'approved_at',
  'LEVANTE',
  'levante',
];

const MAX_TAG_BATCH = 20;
const ID3_HEAD_BYTES = 131071;
const LIST_CONCURRENCY = 8;

let storageClient = null;

function getStorageClient() {
  if (storageClient) return storageClient;
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!serviceAccountJson) {
    try {
      storageClient = new Storage();
      return storageClient;
    } catch {
      return null;
    }
  }
  try {
    let json = serviceAccountJson.trim();
    if ((json.startsWith('"') && json.endsWith('"')) || (json.startsWith("'") && json.endsWith("'"))) {
      json = json.slice(1, -1);
    }
    json = json.replace(/\\n/g, '\n');
    const credentials = JSON.parse(json);
    storageClient = new Storage({ credentials, projectId: credentials.project_id });
    return storageClient;
  } catch (e) {
    console.warn('id3-metadata: GCS credentials not valid JSON:', e.message);
    try {
      storageClient = new Storage();
      return storageClient;
    } catch {
      return null;
    }
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-cache');
}

function resolveBucket(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return ALLOWED_BUCKETS.dev;
  if (ALLOWED_BUCKETS[raw]) return ALLOWED_BUCKETS[raw];
  const short = raw.replace(/^levante-assets-/, '').replace(/^-assets-/, '');
  if (ALLOWED_BUCKETS[short]) return ALLOWED_BUCKETS[short];
  const allowed = new Set(Object.values(ALLOWED_BUCKETS));
  if (allowed.has(raw)) return raw;
  return null;
}

function kebabToCamel(str) {
  return String(str || '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToKebab(str) {
  return String(str || '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function taskKeyVariants(task) {
  const raw = String(task || '').trim();
  if (!raw) return [];
  const set = new Set([
    raw,
    raw.replace(/-/g, ''),
    raw.replace(/-/g, '_'),
    raw.replace(/_/g, '-'),
    kebabToCamel(raw),
    camelToKebab(raw),
  ]);
  return [...set];
}

function findTaskEntry(assetsPerTask, task) {
  if (!assetsPerTask || typeof assetsPerTask !== 'object') return null;
  for (const key of taskKeyVariants(task)) {
    if (Object.prototype.hasOwnProperty.call(assetsPerTask, key)) {
      return { key, entry: assetsPerTask[key] };
    }
  }
  const compact = String(task || '').toLowerCase().replace(/[-_]/g, '');
  for (const [key, entry] of Object.entries(assetsPerTask)) {
    if (String(key).toLowerCase().replace(/[-_]/g, '') === compact) {
      return { key, entry };
    }
  }
  return null;
}

function getAudioIds(entry) {
  if (Array.isArray(entry)) return entry.map(String);
  if (Array.isArray(entry?.audio)) return entry.audio.map(String);
  if (Array.isArray(entry?.requiredAudioIds)) return entry.requiredAudioIds.map(String);
  return [];
}

function normalizeItemId(name) {
  return String(name || '')
    .split('/')
    .pop()
    .replace(/\.mp3$/i, '')
    .replace(/_v\d{3}$/i, '')
    .trim()
    .toLowerCase();
}

function isLikelyLocale(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (SKIP_AUDIO_FOLDERS.has(n.toLowerCase())) return false;
  return /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,2}$/i.test(n);
}

function commentText(tags) {
  if (!tags?.comment) return '';
  if (typeof tags.comment === 'string') return tags.comment;
  return String(tags.comment.text || '');
}

function userDefinedEntries(tags) {
  const raw = tags?.userDefinedText;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return [raw];
  return [];
}

function customMap(tags) {
  const map = {};
  for (const entry of userDefinedEntries(tags)) {
    const description = String(entry?.description || '').trim();
    if (!description) continue;
    map[description] = String(entry?.value ?? '').trim();
  }
  return map;
}

function flattenTags(tags) {
  const custom = customMap(tags);
  const pick = (...keys) => {
    for (const key of keys) {
      const value = custom[key];
      if (value) return value;
    }
    return '';
  };
  const known = new Set(KNOWN_CUSTOM_KEYS.map((k) => k.toLowerCase()));
  const extra = {};
  for (const [key, value] of Object.entries(custom)) {
    if (!known.has(key.toLowerCase())) extra[key] = value;
  }
  return {
    title: tags?.title || '',
    artist: tags?.artist || '',
    album: tags?.album || '',
    genre: tags?.genre || '',
    comment: commentText(tags),
    copyright: tags?.copyright || '',
    year: tags?.year || tags?.date || '',
    service: pick('service') || tags?.service || '',
    voice: pick('voice') || tags?.voice || '',
    voice_id: pick('voice_id', 'voiceId'),
    model_id: pick('model_id'),
    lang_code: pick('lang_code') || tags?.lang_code || '',
    text: pick('text') || tags?.text || '',
    original_translation_text: pick('original_translation_text'),
    audio_enhanced_text: pick('audio_enhanced_text'),
    used_audio_enhanced_text: pick('used_audio_enhanced_text'),
    created: pick('created'),
    source: pick('source'),
    approved_by: pick('approved_by'),
    approved_at: pick('approved_at'),
    levante: pick('LEVANTE', 'levante', 'Levante'),
    extra,
  };
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        results[index] = { error: error?.message || String(error) };
      }
    }
  }
  const workers = Math.min(Math.max(1, limit), Math.max(1, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

async function listPrefixes(bucket, prefix) {
  const prefixes = [];
  let query = { prefix, delimiter: '/', autoPaginate: false };
  do {
    const [, nextQuery, apiResponse] = await bucket.getFiles(query);
    (apiResponse?.prefixes || []).forEach((p) => prefixes.push(p));
    query = nextQuery || null;
  } while (query);
  return prefixes;
}

async function readJsonFromGcs(storage, bucketName, filePath) {
  const file = storage.bucket(bucketName).file(filePath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return JSON.parse(contents.toString('utf8'));
}

async function loadAssetsPerTask(storage, bucketName) {
  const primary = await readJsonFromGcs(storage, bucketName, 'audio/assets-per-task.json');
  if (primary) return { data: primary, source: bucketName };
  if (bucketName !== ALLOWED_BUCKETS.dev) {
    const fallback = await readJsonFromGcs(storage, ALLOWED_BUCKETS.dev, 'audio/assets-per-task.json');
    if (fallback) return { data: fallback, source: ALLOWED_BUCKETS.dev };
  }
  return { data: null, source: null };
}

async function listMp3Files(bucket, prefix) {
  const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
  return (files || [])
    .filter((file) => String(file.name || '').toLowerCase().endsWith('.mp3'))
    .map((file) => {
      const metadata = file.metadata || {};
      return {
        path: file.name,
        itemId: String(file.name).split('/').pop().replace(/\.mp3$/i, ''),
        fileName: String(file.name).split('/').pop(),
        size: Number(metadata.size || 0),
        updated: metadata.updated || metadata.timeCreated || null,
      };
    });
}

async function collectTaskFiles(bucket, task, locale, idSet) {
  const localeSafe = String(locale || '').trim();
  const taskSafe = String(task || '').trim();
  const seen = new Set();
  const files = [];

  const prefixes = [
    `audio/${taskSafe}/${localeSafe}/`,
    `audio/${localeSafe}/`,
  ];
  if (taskSafe.toLowerCase() === 'child-survey' || taskSafe.toLowerCase() === 'child_survey') {
    prefixes.unshift(`audio/child-survey/${localeSafe}/`);
  }
  if (taskSafe.toLowerCase() === 'shared') {
    prefixes.unshift('audio/shared/');
  }

  for (const prefix of prefixes) {
    const listed = await listMp3Files(bucket, prefix);
    for (const file of listed) {
      if (seen.has(file.path)) continue;
      const inTaskFolder = prefix.startsWith(`audio/${taskSafe}/`) || prefix.startsWith('audio/child-survey/') || prefix === 'audio/shared/';
      const matchesId = idSet.size === 0 ? inTaskFolder : idSet.has(normalizeItemId(file.path));
      if (!matchesId && !inTaskFolder) continue;
      seen.add(file.path);
      files.push(file);
    }
  }
  files.sort((a, b) => String(a.itemId).localeCompare(String(b.itemId)));
  return files;
}

async function localesForTask(bucket, task, idSet) {
  const locales = new Set();
  const taskSafe = String(task || '').trim();

  const nested = await listPrefixes(bucket, `audio/${taskSafe}/`);
  for (const prefix of nested) {
    const locale = prefix.replace(`audio/${taskSafe}/`, '').replace(/\/$/, '');
    if (locale) locales.add(locale);
  }

  if (taskSafe.toLowerCase() === 'child-survey' || taskSafe.toLowerCase() === 'child_survey') {
    const child = await listPrefixes(bucket, 'audio/child-survey/');
    for (const prefix of child) {
      const locale = prefix.replace('audio/child-survey/', '').replace(/\/$/, '');
      if (locale) locales.add(locale);
    }
  }

  const top = await listPrefixes(bucket, 'audio/');
  const langFolders = top
    .map((p) => p.replace(/^audio\//, '').replace(/\/$/, ''))
    .filter(isLikelyLocale);

  if (idSet.size > 0) {
    await mapPool(langFolders, LIST_CONCURRENCY, async (lang) => {
      const listed = await listMp3Files(bucket, `audio/${lang}/`);
      const hasMatch = listed.some((file) => idSet.has(normalizeItemId(file.path)));
      if (hasMatch) locales.add(lang);
      return true;
    });
  }

  return [...locales].sort((a, b) => a.localeCompare(b));
}

async function readId3ForPath(bucket, objectPath) {
  const file = bucket.file(objectPath);
  const [exists] = await file.exists();
  if (!exists) {
    return { path: objectPath, error: 'not_found' };
  }
  try {
    const [headBuffer] = await file.download({ start: 0, end: ID3_HEAD_BYTES });
    let tags = NodeID3.read(headBuffer);
    const useful = tags && (tags.title || tags.artist || tags.album || userDefinedEntries(tags).length);
    if (!useful) {
      try {
        const [meta] = await file.getMetadata();
        const size = Number(meta.size || 0);
        if (size > 0) {
          const tailStart = Math.max(0, size - 131072);
          const [tailBuffer] = await file.download({ start: tailStart });
          const tailTags = NodeID3.read(tailBuffer);
          if (tailTags && (tailTags.title || tailTags.artist || userDefinedEntries(tailTags).length)) {
            tags = tailTags;
          }
        }
      } catch (e) {
        console.warn('id3-metadata: tail read failed', e.message);
      }
    }
    return {
      path: objectPath,
      itemId: String(objectPath).split('/').pop().replace(/\.mp3$/i, ''),
      tags: flattenTags(tags || {}),
    };
  } catch (error) {
    return { path: objectPath, error: error?.message || String(error) };
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  }

  const storage = getStorageClient();
  if (!storage) {
    return res.status(500).json({ success: false, error: 'gcs_unavailable' });
  }

  const body = req.method === 'POST' ? (req.body || {}) : {};
  const query = req.query || {};
  const action = String(body.action || query.action || '').trim().toLowerCase();
  const bucketName = resolveBucket(body.bucket || query.bucket);
  if (!bucketName) {
    return res.status(400).json({
      success: false,
      error: 'invalid_bucket',
      allowed: Object.values(ALLOWED_BUCKETS),
    });
  }

  const bucket = storage.bucket(bucketName);

  try {
    if (action === 'tasks') {
      const loaded = await loadAssetsPerTask(storage, bucketName);
      const tasks = loaded.data ? Object.keys(loaded.data).sort((a, b) => a.localeCompare(b)) : [];
      return res.status(200).json({
        success: true,
        bucket: bucketName,
        tasks,
        source: loaded.source,
        warning: loaded.source && loaded.source !== bucketName
          ? `assets-per-task.json not in ${bucketName}; using ${loaded.source}`
          : (tasks.length ? null : 'assets-per-task.json not found'),
      });
    }

    if (action === 'locales') {
      const task = String(body.task || query.task || '').trim();
      if (!task) return res.status(400).json({ success: false, error: 'missing_task' });
      const loaded = await loadAssetsPerTask(storage, bucketName);
      const match = findTaskEntry(loaded.data, task);
      const ids = getAudioIds(match?.entry);
      const idSet = new Set(ids.map(normalizeItemId).filter(Boolean));
      const locales = await localesForTask(bucket, match?.key || task, idSet);
      return res.status(200).json({
        success: true,
        bucket: bucketName,
        task: match?.key || task,
        locales,
        itemCount: ids.length,
        source: loaded.source,
      });
    }

    if (action === 'files') {
      const task = String(body.task || query.task || '').trim();
      const locale = String(body.locale || query.locale || '').trim();
      if (!task || !locale) {
        return res.status(400).json({ success: false, error: 'missing_task_or_locale' });
      }
      const loaded = await loadAssetsPerTask(storage, bucketName);
      const match = findTaskEntry(loaded.data, task);
      const ids = getAudioIds(match?.entry);
      const idSet = new Set(ids.map(normalizeItemId).filter(Boolean));
      const files = await collectTaskFiles(bucket, match?.key || task, locale, idSet);
      return res.status(200).json({
        success: true,
        bucket: bucketName,
        task: match?.key || task,
        locale,
        files,
        expectedCount: ids.length,
      });
    }

    if (action === 'tags') {
      const singlePath = String(body.path || query.path || '').trim();
      let paths = [];
      if (Array.isArray(body.paths)) {
        paths = body.paths.map((p) => String(p || '').trim()).filter(Boolean);
      } else if (query.paths) {
        paths = String(query.paths).split(',').map((p) => p.trim()).filter(Boolean);
      }
      if (singlePath) paths.unshift(singlePath);
      paths = [...new Set(paths)].slice(0, MAX_TAG_BATCH);
      if (!paths.length) {
        return res.status(400).json({ success: false, error: 'missing_path' });
      }
      const unsafe = paths.find((p) => p.includes('..') || p.startsWith('/') || !p.toLowerCase().endsWith('.mp3'));
      if (unsafe) {
        return res.status(400).json({ success: false, error: 'invalid_path', path: unsafe });
      }
      const results = await mapPool(paths, 6, (objectPath) => readId3ForPath(bucket, objectPath));
      return res.status(200).json({
        success: true,
        bucket: bucketName,
        results,
      });
    }

    return res.status(400).json({
      success: false,
      error: 'unknown_action',
      allowed: ['tasks', 'locales', 'files', 'tags'],
    });
  } catch (error) {
    console.error('id3-metadata error:', error);
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      message: error?.message || String(error),
    });
  }
}
