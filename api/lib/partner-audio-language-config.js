/**
 * Partner Audio Approval Tool — language_config.json helpers.
 */
import { langCodesMatchForItembank } from './lang-codes.js';

export {
  canonicalizeItembankLangCode,
  langCodesMatchForItembank,
  resolveLangCode,
} from './lang-codes.js';

export function isAudioCapableLanguageEntry(cfg) {
  const hasLang = Boolean(String(cfg?.lang_code || '').trim());
  const hasVoice = Boolean(String(cfg?.voice || '').trim());
  const hasVoiceId = Boolean(String(cfg?.voice_id || '').trim());
  return hasLang && (hasVoice || hasVoiceId);
}

export function filterAudioCapableLanguages(languagesObject) {
  const input = languagesObject && typeof languagesObject === 'object' ? languagesObject : {};
  const filtered = {};
  Object.entries(input).forEach(([name, cfg]) => {
    if (isAudioCapableLanguageEntry(cfg)) filtered[name] = cfg;
  });
  return filtered;
}

export function listAudioCapableLangCodes(languagesObject) {
  const codes = new Set();
  Object.values(filterAudioCapableLanguages(languagesObject)).forEach((cfg) => {
    const code = String(cfg?.lang_code || '').trim();
    if (code) codes.add(code);
  });
  return Array.from(codes).sort((a, b) => a.localeCompare(b));
}

export function isAudioCapableLangCode(languagesObject, langCode) {
  const requested = String(langCode || '').trim();
  if (!requested) return false;
  return Object.values(filterAudioCapableLanguages(languagesObject)).some((cfg) =>
    langCodesMatchForItembank(cfg?.lang_code, requested)
  );
}

export async function loadLanguageConfigLanguages(storage, {
  bucketName = process.env.AUDIO_DEV_BUCKET || 'levante-assets-dev',
  objectName = process.env.LANGUAGE_CONFIG_OBJECT || 'language_config.json',
} = {}) {
  if (!storage) return {};
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(objectName);
  const [exists] = await file.exists();
  if (!exists) return {};
  const [contents] = await file.download();
  const parsed = JSON.parse(contents.toString('utf8'));
  return parsed?.languages && typeof parsed.languages === 'object' ? parsed.languages : {};
}
