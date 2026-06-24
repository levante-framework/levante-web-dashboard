import {
  getReferenceSourceLang,
  isLegacyShortLangFolder,
  langCodesMatch,
  normalizeLangCode,
  REFERENCE_SOURCE_LANG,
  resolveLangCode,
} from './lang-codes.js';

export const ITEM_BANK_TRANSLATIONS_FILE = 'item-bank-translations.json';
export const ITEMBANK_TRANSLATIONS_PREFIX = 'translations/itembank/';

/** Canonical string in item-bank-translations.json when Crowdin has no approved translation. */
export const NO_APPROVED_TRANSLATION_TEXT = 'NO APPROVED TRANSLATION';

export function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').trim();
}

export function filterCanonicalTranslationPaths(paths) {
  return (paths || []).filter((entry) => !isLegacyShortLangFolder(entry.langSegment));
}

export function parseItembankTranslationPath(pathName) {
  const path = normalizePath(pathName);
  const lower = path.toLowerCase();
  if (!lower.endsWith(`/${ITEM_BANK_TRANSLATIONS_FILE}`)) return null;
  if (!lower.includes('/itembank/')) return null;

  const match = path.match(/\/itembank\/([^/]+)\/([^/]+)\/item-bank-translations\.json$/i);
  if (!match) return null;

  return {
    task: String(match[1] || '').trim(),
    langSegment: String(match[2] || '').trim(),
    path,
  };
}

export function isLikelyTaskTranslationPath(pathName, slugCandidates, langAliases) {
  const normalizedPath = String(pathName || '').replace(/\\/g, '/').toLowerCase();
  if (!normalizedPath.endsWith('.json')) return false;
  if (!normalizedPath.includes('/itembank/')) return false;
  if (!slugCandidates.some((slug) => normalizedPath.includes(`/itembank/${slug}/`))) return false;
  if (!langAliases.some((alias) => normalizedPath.includes(`/${alias}/`))) return false;
  return true;
}

export function isPlaceholderText(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  return text.toLowerCase() === NO_APPROVED_TRANSLATION_TEXT.toLowerCase();
}

export function isRealTranslationText(value) {
  return !isPlaceholderText(value);
}

export function classifyTranslationStatus(translationText, { missingKey = false } = {}) {
  if (missingKey) return 'missing_key';
  const raw = String(translationText ?? '').trim();
  if (!raw) return 'missing_key';
  if (isPlaceholderText(raw)) return 'no_approved_translation';
  return 'ok';
}

export function normalizeItemId(rawKey) {
  const raw = String(rawKey || '').trim();
  if (!raw) return '';
  if (raw.includes('::')) {
    const suffix = raw.split('::').pop();
    return String(suffix || raw).trim();
  }
  return raw;
}

function getRecordText(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return '';
  const candidates = [
    record.translation,
    record.target,
    record.text,
    record.value,
    record.message,
    record.content,
  ];
  const found = candidates.find((v) => typeof v === 'string' && String(v).trim());
  return String(found || '').trim();
}

function collectJsonTranslationEntries(node, prefix = '') {
  const out = [];
  if (typeof node === 'string') {
    if (prefix) out.push({ itemId: normalizeItemId(prefix), text: node.trim() });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((entry, idx) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const itemId = normalizeItemId(entry.item_id || entry.itemId || entry.id || '');
        const text = getRecordText(entry);
        if (itemId && text) {
          out.push({ itemId, text });
          return;
        }
      }
      const childPrefix = prefix ? `${prefix}.${idx}` : String(idx);
      out.push(...collectJsonTranslationEntries(entry, childPrefix));
    });
    return out;
  }
  if (node && typeof node === 'object') {
    Object.entries(node).forEach(([key, value]) => {
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      out.push(...collectJsonTranslationEntries(value, childPrefix));
    });
  }
  return out;
}

export function entriesToMap(entries) {
  const map = new Map();
  (entries || []).forEach(({ itemId, text }) => {
    if (!itemId) return;
    const next = String(text ?? '').trim();
    if (!next) return;
    const current = map.get(itemId);
    if (!current || isRealTranslationText(next) || !isRealTranslationText(current)) {
      map.set(itemId, next);
    }
  });
  return map;
}

export function parseItembankTranslationJson(buffer) {
  const parsed = JSON.parse(buffer.toString('utf8'));
  return entriesToMap(collectJsonTranslationEntries(parsed));
}

export function buildTaskItems({ task, targetMap, sourceMap, requestedLang }) {
  const items = [];
  const counts = {
    ok: 0,
    no_approved_translation: 0,
    missing_key: 0,
  };
  const seen = new Set();

  const pushItem = (itemId, translationText, { missingKey = false } = {}) => {
    const key = `${task}::${itemId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const translationStatus = classifyTranslationStatus(translationText, { missingKey });
    const item = {
      item_id: itemId,
      task,
      lang: normalizeLangCode(requestedLang),
      sourceText: String(sourceMap.get(itemId) || '').trim(),
      translationText: missingKey ? '' : String(translationText ?? '').trim(),
      translationStatus,
    };
    items.push(item);
    counts[translationStatus] = (counts[translationStatus] || 0) + 1;
  };

  targetMap.forEach((translationText, itemId) => {
    pushItem(itemId, translationText);
  });

  sourceMap.forEach((_sourceText, itemId) => {
    if (targetMap.has(itemId)) return;
    pushItem(itemId, '', { missingKey: true });
  });

  items.sort((a, b) => String(a.item_id).localeCompare(String(b.item_id)));
  return { items, counts };
}

export function mergeCounts(total, partial) {
  return {
    ok: (total.ok || 0) + (partial.ok || 0),
    no_approved_translation: (total.no_approved_translation || 0) + (partial.no_approved_translation || 0),
    missing_key: (total.missing_key || 0) + (partial.missing_key || 0),
  };
}

export async function listItembankTranslationPaths(bucket, { maxFiles = 25000 } = {}) {
  const out = [];
  let pageToken;
  do {
    const [files, nextQuery] = await bucket.getFiles({
      prefix: ITEMBANK_TRANSLATIONS_PREFIX,
      autoPaginate: false,
      pageToken,
      maxResults: 1000,
    });
    files.forEach((file) => {
      const parsed = parseItembankTranslationPath(file?.name);
      if (parsed) out.push({ ...parsed, file });
    });
    if (out.length >= maxFiles) break;
    pageToken = nextQuery?.pageToken;
  } while (pageToken);
  return out;
}

export function pathsForTaskAndLang(paths, task, langCodes) {
  const normalizedTask = String(task || '').trim().toLowerCase();
  const langSet = new Set((langCodes || []).map((code) => normalizeLangCode(code).toLowerCase()));
  return (paths || []).filter((entry) => {
    if (String(entry.task || '').toLowerCase() !== normalizedTask) return false;
    return langSet.has(normalizeLangCode(entry.langSegment).toLowerCase());
  });
}

export async function readTranslationMap(file) {
  if (!file) return new Map();
  try {
    const [buf] = await file.download();
    return parseItembankTranslationJson(buf);
  } catch (_) {
    return new Map();
  }
}

export async function buildLanguageBundle(storage, bucketName, requestedLang) {
  const lang = resolveLangCode(requestedLang);
  if (!lang) {
    throw new Error('missing_lang');
  }

  const bucket = storage.bucket(bucketName);
  const allPaths = filterCanonicalTranslationPaths(await listItembankTranslationPaths(bucket));
  const referenceLang = getReferenceSourceLang(lang);
  const targetPaths = allPaths.filter((entry) => langCodesMatch(lang, entry.langSegment, { context: 'exact' }));
  const tasks = Array.from(new Set(targetPaths.map((entry) => entry.task))).sort();

  const items = [];
  let counts = { ok: 0, no_approved_translation: 0, missing_key: 0 };

  for (const task of tasks) {
    const taskTargetPaths = pathsForTaskAndLang(allPaths, task, [lang]);
    const taskSourcePaths = pathsForTaskAndLang(allPaths, task, [referenceLang]);

    let targetMap = new Map();
    for (const entry of taskTargetPaths) {
      const map = await readTranslationMap(entry.file);
      map.forEach((value, key) => {
        const current = targetMap.get(key);
        if (!current || isRealTranslationText(value) || !isRealTranslationText(current)) {
          targetMap.set(key, value);
        }
      });
    }

    let sourceMap = new Map();
    for (const entry of taskSourcePaths) {
      const map = await readTranslationMap(entry.file);
      map.forEach((value, key) => {
        const current = sourceMap.get(key);
        if (!current || isRealTranslationText(value) || !isRealTranslationText(current)) {
          sourceMap.set(key, value);
        }
      });
    }

    const taskBundle = buildTaskItems({
      task,
      targetMap,
      sourceMap,
      requestedLang: lang,
    });
    items.push(...taskBundle.items);
    counts = mergeCounts(counts, taskBundle.counts);
  }

  items.sort((a, b) => {
    const taskCmp = String(a.task).localeCompare(String(b.task));
    if (taskCmp !== 0) return taskCmp;
    return String(a.item_id).localeCompare(String(b.item_id));
  });

  return {
    ok: true,
    lang,
    source: `gcs://${bucketName}/${ITEMBANK_TRANSLATIONS_PREFIX}<task>/{lang}/${ITEM_BANK_TRANSLATIONS_FILE}`,
    tasks,
    items,
    counts,
    fileCount: targetPaths.length,
  };
}
