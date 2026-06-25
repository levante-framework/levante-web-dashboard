#!/usr/bin/env node

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  getAudioLangAliases,
  getTranslationAltNames,
  shouldUseEnglishSourceTextFallback,
  shouldUseBaseLanguageFallback,
  sharesEnglishRegionalPool,
} = require(path.join(__dirname, '..', 'public', 'js', 'partner-audio-lang-aliases.js'));

function aliasSet(langCode) {
  return new Set(getAudioLangAliases(langCode).map((v) => String(v).toLowerCase()));
}

test('en-GB aliases stay within en-GB spelling variants', () => {
  const aliases = aliasSet('en-GB');
  assert.ok(aliases.has('en-gb'));
  assert.ok(aliases.has('en_gb'));
  assert.equal(aliases.has('en-us'), false);
  assert.equal(aliases.has('en'), false);
  assert.equal(aliases.has('en-in'), false);
});

test('en-US aliases stay within en-US spelling variants', () => {
  const aliases = aliasSet('en-US');
  assert.ok(aliases.has('en-us'));
  assert.equal(aliases.has('en-gb'), false);
  assert.equal(aliases.has('en'), false);
});

test('en-IN aliases are independent and anticipated', () => {
  const aliases = aliasSet('en-IN');
  assert.ok(aliases.has('en-in'));
  assert.ok(aliases.has('en_in'));
  assert.equal(aliases.has('en-gb'), false);
  assert.equal(aliases.has('en-us'), false);
});

test('legacy bare en maps to en-US variants only', () => {
  const aliases = aliasSet('en');
  assert.ok(aliases.has('en-us'));
  assert.equal(aliases.has('en-gb'), false);
  assert.equal(aliases.has('en-in'), false);
});

test('en-US and en-GB do not share regional audio pools', () => {
  assert.equal(sharesEnglishRegionalPool('en-US', 'en-GB'), false);
  assert.equal(sharesEnglishRegionalPool('en-GB', 'en-IN'), false);
  assert.equal(sharesEnglishRegionalPool('en-US', 'en-US'), true);
});

test('translation alt names avoid cross-locale English columns', () => {
  assert.ok(getTranslationAltNames('en-GB').includes('en_GB'));
  assert.equal(getTranslationAltNames('en-GB').includes('en'), false);
  assert.equal(getTranslationAltNames('en-GB').includes('en-us'), false);
  assert.ok(getTranslationAltNames('en-IN').includes('en_IN'));
});

test('English source-text fallback is disabled for regional locales', () => {
  assert.equal(shouldUseEnglishSourceTextFallback('en-GB'), false);
  assert.equal(shouldUseEnglishSourceTextFallback('en-US'), false);
  assert.equal(shouldUseEnglishSourceTextFallback('en-IN'), false);
});

test('base-language fallback is disabled for English regional codes', () => {
  assert.equal(shouldUseBaseLanguageFallback('en-GB'), false);
  assert.equal(shouldUseBaseLanguageFallback('es-CO'), true);
});
