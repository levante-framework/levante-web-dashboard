import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeItembankLangCode,
  getLangCodeAliases,
  getReferenceSourceLang,
  isLegacyShortLangFolder,
  langCodesMatch,
  langCodesMatchForItembank,
  normalizeLangCode,
  resolveLangCode,
} from '../api/lib/lang-codes.js';

test('normalizeLangCode formats BCP-47 casing', () => {
  assert.equal(normalizeLangCode('ES-ar'), 'es-AR');
  assert.equal(normalizeLangCode('de'), 'de');
  assert.equal(normalizeLangCode('en-US'), 'en-US');
});

test('resolveLangCode maps 2-letter config codes to canonical BCP-47', () => {
  assert.equal(resolveLangCode('en'), 'en-US');
  assert.equal(resolveLangCode('de'), 'de-DE');
  assert.equal(resolveLangCode('nl'), 'nl-NL');
  assert.equal(resolveLangCode('pt'), 'pt-PT');
  assert.equal(resolveLangCode('eo'), 'eo-UY');
});

test('resolveLangCode passes through existing BCP-47 codes', () => {
  assert.equal(resolveLangCode('es-AR'), 'es-AR');
  assert.equal(resolveLangCode('de-CH'), 'de-CH');
  assert.equal(resolveLangCode('en', { context: 'exact' }), 'en');
});

test('canonicalizeItembankLangCode matches resolveLangCode', () => {
  assert.equal(canonicalizeItembankLangCode('nl'), 'nl-NL');
  assert.equal(canonicalizeItembankLangCode('en'), 'en-US');
});

test('langCodesMatch exact mode requires full code equality', () => {
  assert.equal(langCodesMatch('es-AR', 'es-AR'), true);
  assert.equal(langCodesMatch('es-AR', 'es-ar'), true);
  assert.equal(langCodesMatch('es-AR', 'es'), false);
  assert.equal(langCodesMatch('es-AR', 'de-DE'), false);
});

test('langCodesMatch itembank mode treats shorthand as equivalent', () => {
  assert.equal(langCodesMatchForItembank('nl', 'nl-NL'), true);
  assert.equal(langCodesMatchForItembank('de', 'de-DE'), true);
  assert.equal(langCodesMatchForItembank('en', 'en-US'), true);
  assert.equal(langCodesMatchForItembank('es-AR', 'es-CO'), false);
});

test('getLangCodeAliases includes lowercase and 2-letter primary', () => {
  assert.deepEqual(getLangCodeAliases('es-AR'), ['es-ar', 'es']);
});

test('isLegacyShortLangFolder detects two-letter folders only', () => {
  assert.equal(isLegacyShortLangFolder('nl'), true);
  assert.equal(isLegacyShortLangFolder('de-DE'), false);
});

test('getReferenceSourceLang uses en-US for non-US locales', () => {
  assert.equal(getReferenceSourceLang('en-US'), 'en-US');
  assert.equal(getReferenceSourceLang('es-AR'), 'en-US');
  assert.equal(getReferenceSourceLang('en-GB'), 'en-US');
});
