import { canonicalizeItembankLangCode } from './partner-audio-language-config.js';
import { getTaskSlugCandidates } from '../move-audio-to-dev.js';

const DEFAULT_BUCKET = String(
  process.env.ASSETS_DEV_BUCKET || process.env.AUDIO_DEV_BUCKET || 'levante-assets-dev'
).trim();
const DEFAULT_OBJECT = String(
  process.env.LANGUAGE_OPTIONS_OBJECT || 'translations/dashboard-consolidated-flat/languageoptions.json'
).trim().replace(/^\/+/, '');

export function resolveCanonicalTaskSlug(taskName) {
  const candidates = getTaskSlugCandidates(taskName);
  if (candidates.length) return candidates[0];
  const raw = String(taskName || '').trim().toLowerCase();
  if (!raw) return '';
  return raw
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function findLanguageOptionsKey(optionsRoot, langCode) {
  const root = optionsRoot && typeof optionsRoot === 'object' ? optionsRoot : {};
  const canonical = canonicalizeItembankLangCode(langCode);
  if (!canonical) return null;
  const keys = Object.keys(root);
  const exact = keys.find((key) => key === canonical);
  if (exact) return exact;
  const lower = canonical.toLowerCase();
  return keys.find((key) => key.toLowerCase() === lower) || null;
}

export function appendTaskSlugToLanguageEntry(entry, taskSlug) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { changed: false, reason: 'invalid_entry' };
  }
  const slug = String(taskSlug || '').trim();
  if (!slug) return { changed: false, reason: 'empty_task_slug' };

  const existing = Array.isArray(entry.taskOptions) ? entry.taskOptions : null;
  if (existing) {
    if (existing.some((value) => String(value) === slug)) {
      return { changed: false, alreadyPresent: true, taskSlug: slug };
    }
    existing.push(slug);
    return { changed: true, taskSlug: slug };
  }

  entry.taskOptions = [slug];
  return { changed: true, taskSlug: slug, createdTaskOptions: true };
}

function detectJsonIndent(rawText) {
  const match = String(rawText || '').match(/\n( +)"/);
  return match ? match[1].length : 2;
}

export function applyTaskSlugToLanguageOptionsDocument(doc, { langCode, task }) {
  const root = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  if (!root) {
    return { changed: false, reason: 'invalid_document' };
  }

  const languageKey = findLanguageOptionsKey(root, langCode);
  if (!languageKey) {
    return { changed: false, reason: 'language_not_found', langCode: canonicalizeItembankLangCode(langCode) };
  }

  const taskSlug = resolveCanonicalTaskSlug(task);
  const result = appendTaskSlugToLanguageEntry(root[languageKey], taskSlug);
  return {
    ...result,
    languageKey,
    langCode: canonicalizeItembankLangCode(langCode),
    objectPath: DEFAULT_OBJECT,
    bucket: DEFAULT_BUCKET,
  };
}

export async function appendTaskToLanguageOptions(storage, {
  langCode,
  task,
  bucketName = DEFAULT_BUCKET,
  objectName = DEFAULT_OBJECT,
} = {}) {
  if (!storage) {
    return { updated: false, reason: 'storage_unavailable' };
  }

  const bucket = storage.bucket(bucketName);
  const file = bucket.file(objectName);
  const [exists] = await file.exists();
  if (!exists) {
    return { updated: false, reason: 'file_not_found', bucket: bucketName, objectPath: objectName };
  }

  const [buf] = await file.download();
  const rawText = buf.toString('utf8');
  const hadTrailingNewline = rawText.endsWith('\n');
  const indent = detectJsonIndent(rawText);

  let doc;
  try {
    doc = JSON.parse(rawText);
  } catch (error) {
    return {
      updated: false,
      reason: 'invalid_json',
      message: String(error?.message || error),
      bucket: bucketName,
      objectPath: objectName,
    };
  }

  const change = applyTaskSlugToLanguageOptionsDocument(doc, { langCode, task });
  if (!change.changed) {
    return {
      updated: false,
      bucket: bucketName,
      objectPath: objectName,
      ...change,
    };
  }

  const serialized = `${JSON.stringify(doc, null, indent)}${hadTrailingNewline ? '\n' : ''}`;
  await file.save(serialized, {
    contentType: 'application/json',
    resumable: false,
  });

  return {
    updated: true,
    bucket: bucketName,
    objectPath: objectName,
    ...change,
  };
}
