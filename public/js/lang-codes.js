/**
 * Browser mirror of api/lib/lang-codes.js — keep in sync when server helpers change.
 */
(function (global) {
  const SHORT_TO_CANONICAL = Object.freeze({
    en: 'en-US',
    de: 'de-DE',
    nl: 'nl-NL',
    pt: 'pt-PT',
    eo: 'eo-UY',
  });

  function normalizeLangCode(value) {
    const raw = String(value || '').trim().replace(/_/g, '-');
    if (!raw) return '';
    const parts = raw.split('-').filter(Boolean);
    const lang = parts[0].toLowerCase();
    if (parts.length === 1) return lang;
    const region = parts.slice(1).join('-');
    const regionNorm = region.length <= 3 ? region.toUpperCase() : region;
    return `${lang}-${regionNorm}`;
  }

  function resolveLangCode(value, options) {
    const context = options && options.context ? options.context : 'itembank';
    const normalized = normalizeLangCode(value);
    if (!normalized) return '';
    if (context === 'exact') return normalized;
    if (!normalized.includes('-')) {
      return SHORT_TO_CANONICAL[normalized] || normalized;
    }
    return normalized;
  }

  function langCodesMatch(left, right, options) {
    const context = options && options.context ? options.context : 'exact';
    if (context === 'itembank') {
      const a = resolveLangCode(left).toLowerCase();
      const b = resolveLangCode(right).toLowerCase();
      return Boolean(a) && a === b;
    }
    const a = normalizeLangCode(left).toLowerCase();
    const b = normalizeLangCode(right).toLowerCase();
    return Boolean(a) && a === b;
  }

  function getLangCodeAliases(value) {
    const resolved = resolveLangCode(value);
    const canonical = normalizeLangCode(resolved).toLowerCase();
    if (!canonical) return [];
    const aliases = new Set([canonical]);
    const primary = canonical.split('-')[0];
    if (primary && primary !== canonical) aliases.add(primary);
    return Array.from(aliases.values());
  }

  global.LevanteLangCodes = {
    SHORT_TO_CANONICAL,
    normalizeLangCode,
    resolveLangCode,
    langCodesMatch,
    getLangCodeAliases,
  };
})(typeof window !== 'undefined' ? window : globalThis);
