/**
 * Partner audio locale aliases — format variants within one locale only.
 * English regional locales (en-US, en-GB, en-GH, en-IN) must stay independent.
 */
(function initPartnerAudioLangAliases(root) {
  function normalizeLangToken(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return { raw: '', canonical: '', lower: '' };
    const cleaned = trimmed.replace(/_/g, '-');
    const parts = cleaned.split('-').filter(Boolean);
    const canonical =
      parts.length < 2
        ? parts[0].toLowerCase()
        : `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
    return { raw: trimmed, canonical, lower: canonical.toLowerCase() };
  }

  function addFormatVariants(aliases, canonical) {
    const cleaned = String(canonical || '').trim().replace(/_/g, '-');
    if (!cleaned) return;
    aliases.add(cleaned);
    aliases.add(cleaned.replace(/-/g, '_'));
    const parts = cleaned.split('-').filter(Boolean);
    if (parts.length < 2) {
      aliases.add(parts[0].toLowerCase());
      return;
    }
    const lang = parts[0].toLowerCase();
    const region = parts[1];
    aliases.add(`${lang}-${region.toUpperCase()}`);
    aliases.add(`${lang}-${region.toLowerCase()}`);
    aliases.add(`${lang}_${region.toUpperCase()}`);
    aliases.add(`${lang}_${region.toLowerCase()}`);
  }

  const ENGLISH_REGIONAL = new Set(['en-us', 'en-gb', 'en-gh', 'en-in']);

  function getAudioLangAliases(langCode) {
    const { raw, canonical, lower } = normalizeLangToken(langCode);
    if (!raw) return [];

    const aliases = new Set([raw, canonical, canonical.replace(/-/g, '_')]);

    if (ENGLISH_REGIONAL.has(lower)) {
      addFormatVariants(aliases, canonical);
      return Array.from(aliases).filter(Boolean);
    }

    // Legacy bare "en" -> en-US spelling variants only (not en-GB/en-IN folders).
    if (lower === 'en') {
      addFormatVariants(aliases, 'en-US');
      return Array.from(aliases).filter(Boolean);
    }

    // Non-English locale families (folder/column spelling variants within family).
    if (lower === 'de' || lower === 'de-de') {
      aliases.add('de');
      addFormatVariants(aliases, 'de-DE');
    } else if (lower === 'de-ch') {
      addFormatVariants(aliases, 'de-CH');
    } else if (lower === 'nl' || lower === 'nl-nl') {
      aliases.add('nl');
      addFormatVariants(aliases, 'nl');
    } else if (lower === 'pt' || lower === 'pt-br' || lower === 'pt-pt') {
      aliases.add('pt');
      aliases.add('pt-BR');
      aliases.add('pt_BR');
      aliases.add('pt-PT');
      aliases.add('pt_PT');
    } else if (lower.includes('-')) {
      addFormatVariants(aliases, canonical);
    }

    return Array.from(aliases).filter(Boolean);
  }

  function getTranslationAltNames(langCode) {
    const { lower } = normalizeLangToken(langCode);
    const byLower = {
      en: ['en-us', 'en_US', 'en_us', 'enus'],
      'en-us': ['en-us', 'en_US', 'en_us', 'enus'],
      'en-gb': ['en-gb', 'en_GB', 'en_gb', 'engb'],
      'en-gh': ['en-gh', 'en_GH', 'en_gh', 'engh'],
      'en-in': ['en-in', 'en_IN', 'en_in', 'enin'],
      de: ['de-de', 'de_DE', 'de_de', 'dede'],
      'de-de': ['de-de', 'de_DE', 'de_de', 'dede', 'de'],
      'es-co': ['es-co', 'es_CO', 'es_co', 'esco'],
      'es-ar': ['es-ar', 'es_AR', 'es_ar', 'esar'],
      'de-ch': ['de-ch', 'de_CH', 'de_ch', 'dech'],
      'fr-ca': ['fr-ca', 'fr_CA', 'fr_ca', 'frca'],
      'pt-pt': ['pt-pt', 'pt_PT', 'pt_pt', 'ptpt'],
      'pt-br': ['pt-br', 'pt_BR', 'pt_br', 'ptbr', 'pt-pt', 'pt_PT', 'pt_pt', 'ptpt'],
    };
    return byLower[lower] || [];
  }

  function shouldUseEnglishSourceTextFallback(langCode) {
    // Source `text` columns are not locale-specific translations for regional English.
    return false;
  }

  function shouldUseBaseLanguageFallback(langCode) {
    const base = String(langCode || '').split('-')[0].toLowerCase();
    return base !== 'en';
  }

  function sharesEnglishRegionalPool(langCodeA, langCodeB) {
    const a = normalizeLangToken(langCodeA).lower;
    const b = normalizeLangToken(langCodeB).lower;
    if (a === b) return true;
    if (!ENGLISH_REGIONAL.has(a) || !ENGLISH_REGIONAL.has(b)) return false;
    return getAudioLangAliases(a).some((alias) => getAudioLangAliases(b).includes(alias));
  }

  const api = {
    normalizeLangToken,
    getAudioLangAliases,
    getTranslationAltNames,
    shouldUseEnglishSourceTextFallback,
    shouldUseBaseLanguageFallback,
    sharesEnglishRegionalPool,
    ENGLISH_REGIONAL,
  };

  root.PartnerAudioLangAliases = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
