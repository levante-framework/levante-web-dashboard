/**
 * Shared language code normalization and short ↔ BCP-47 resolution.
 *
 * Inputs are either 2-letter config codes (from language_config.json / ElevenLabs)
 * or canonical BCP-47 codes from Crowdin itembank paths (e.g. es-AR, eo-UY).
 */

/** Config shorthand → canonical itembank / dashboard code. */
export const SHORT_TO_CANONICAL = Object.freeze({
  en: 'en-US',
  de: 'de-DE',
  nl: 'nl-NL',
  pt: 'pt-PT',
  eo: 'eo-UY',
});

/** Normalize BCP-47 casing: lang lower, region upper. */
export function normalizeLangCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parts = raw.split('-').filter(Boolean);
  const lang = parts[0].toLowerCase();
  if (parts.length === 1) return lang;
  const region = parts.slice(1).join('-');
  const regionNorm = region.length <= 3 ? region.toUpperCase() : region;
  return `${lang}-${regionNorm}`;
}

/**
 * Resolve config shorthand to canonical code; pass through existing BCP-47 codes.
 * With context 'exact', only normalizes casing (no short-code expansion).
 */
export function resolveLangCode(value, { context = 'itembank' } = {}) {
  const normalized = normalizeLangCode(value);
  if (!normalized) return '';
  if (context === 'exact') return normalized;
  if (!normalized.includes('-')) {
    return SHORT_TO_CANONICAL[normalized] || normalized;
  }
  return normalized;
}

/** @deprecated Prefer resolveLangCode(code). */
export function canonicalizeItembankLangCode(value) {
  return resolveLangCode(value);
}

/**
 * Compare language codes.
 * - exact: casing-normalized equality (es ≠ es-AR)
 * - itembank: resolve shorthand first (nl === nl-NL)
 */
export function langCodesMatch(left, right, { context = 'exact' } = {}) {
  if (context === 'itembank') {
    const a = resolveLangCode(left).toLowerCase();
    const b = resolveLangCode(right).toLowerCase();
    return Boolean(a) && a === b;
  }
  const a = normalizeLangCode(left).toLowerCase();
  const b = normalizeLangCode(right).toLowerCase();
  return Boolean(a) && a === b;
}

/** @deprecated Prefer langCodesMatch(a, b, { context: 'itembank' }). */
export function langCodesMatchForItembank(left, right) {
  return langCodesMatch(left, right, { context: 'itembank' });
}

/** Path lookup variants: canonical lowercase + 2-letter primary (legacy GCS folders). */
export function getLangCodeAliases(value) {
  const resolved = resolveLangCode(value);
  const canonical = normalizeLangCode(resolved).toLowerCase();
  if (!canonical) return [];
  const aliases = new Set([canonical]);
  const primary = canonical.split('-')[0];
  if (primary && primary !== canonical) aliases.add(primary);
  return Array.from(aliases.values());
}

/** Legacy two-letter folders (nl, de) — ignore; canonical paths use full codes. */
export function isLegacyShortLangFolder(langSegment) {
  return /^[a-z]{2}$/i.test(String(langSegment || '').trim());
}

export function isEnglishLangCode(langCode) {
  const normalized = normalizeLangCode(langCode).toLowerCase();
  return normalized === 'en-us' || normalized === 'en-gb' || normalized === 'en-gh';
}

export const REFERENCE_SOURCE_LANG = 'en-US';

export function getReferenceSourceLang(requestedLang) {
  const lang = normalizeLangCode(requestedLang);
  if (lang.toLowerCase() === 'en-us') return lang;
  return REFERENCE_SOURCE_LANG;
}
