import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeItembankLangCode,
  filterAudioCapableLanguages,
  isAudioCapableLanguageEntry,
  isAudioCapableLangCode,
  langCodesMatchForItembank,
  listAudioCapableLangCodes,
} from '../api/lib/partner-audio-language-config.js';
import {
  parseItembankTranslationPath,
  isPlaceholderText,
  classifyTranslationStatus,
  buildTaskItems,
  langCodesMatch,
  isLegacyShortLangFolder,
  filterCanonicalTranslationPaths,
  getReferenceSourceLang,
  entriesToMap,
} from '../api/lib/partner-audio-translations-bundle.js';

test('parseItembankTranslationPath matches canonical bucket layout', () => {
  const parsed = parseItembankTranslationPath(
    'translations/itembank/memory-game/es-AR/item-bank-translations.json'
  );
  assert.deepEqual(parsed, {
    task: 'memory-game',
    langSegment: 'es-AR',
    path: 'translations/itembank/memory-game/es-AR/item-bank-translations.json',
  });
});

test('parseItembankTranslationPath rejects non item-bank filenames', () => {
  assert.equal(parseItembankTranslationPath('translations/itembank/memory-game/es-AR/other.json'), null);
  assert.equal(parseItembankTranslationPath('audio/item_bank_translations.csv'), null);
});

test('isPlaceholderText detects NO APPROVED TRANSLATION', () => {
  assert.equal(isPlaceholderText('NO APPROVED TRANSLATION'), true);
  assert.equal(isPlaceholderText('no approved translation'), true);
  assert.equal(isPlaceholderText('Hola'), false);
  assert.equal(isPlaceholderText(''), false);
});

test('classifyTranslationStatus covers ok, placeholder, and missing key', () => {
  assert.equal(classifyTranslationStatus('Hola'), 'ok');
  assert.equal(classifyTranslationStatus('NO APPROVED TRANSLATION'), 'no_approved_translation');
  assert.equal(classifyTranslationStatus('', { missingKey: true }), 'missing_key');
  assert.equal(classifyTranslationStatus(''), 'missing_key');
});

test('buildTaskItems splits valid, placeholder, and en-only keys', () => {
  const targetMap = new Map([
    ['item-a', 'Buenos días'],
    ['item-b', 'NO APPROVED TRANSLATION'],
  ]);
  const sourceMap = new Map([
    ['item-a', 'Good morning'],
    ['item-b', 'Good afternoon'],
    ['item-c', 'Good evening'],
  ]);

  const { items, counts } = buildTaskItems({
    task: 'memory-game',
    targetMap,
    sourceMap,
    requestedLang: 'es-AR',
  });

  assert.equal(items.length, 3);
  assert.equal(counts.ok, 1);
  assert.equal(counts.no_approved_translation, 1);
  assert.equal(counts.missing_key, 1);

  const byId = Object.fromEntries(items.map((item) => [item.item_id, item]));
  assert.equal(byId['item-a'].translationStatus, 'ok');
  assert.equal(byId['item-a'].sourceText, 'Good morning');
  assert.equal(byId['item-b'].translationStatus, 'no_approved_translation');
  assert.equal(byId['item-c'].translationStatus, 'missing_key');
  assert.equal(byId['item-c'].translationText, '');
});

test('langCodesMatch requires exact canonical codes', () => {
  assert.equal(langCodesMatch('es-AR', 'es-AR'), true);
  assert.equal(langCodesMatch('es-AR', 'es-ar'), true);
  assert.equal(langCodesMatch('es-AR', 'es'), false);
  assert.equal(langCodesMatch('es-AR', 'de-DE'), false);
});

test('filterCanonicalTranslationPaths drops legacy short lang folders', () => {
  const paths = [
    { langSegment: 'es-AR' },
    { langSegment: 'nl' },
    { langSegment: 'de' },
    { langSegment: 'de-DE' },
  ];
  assert.equal(isLegacyShortLangFolder('nl'), true);
  assert.equal(isLegacyShortLangFolder('de-DE'), false);
  assert.deepEqual(
    filterCanonicalTranslationPaths(paths).map((entry) => entry.langSegment),
    ['es-AR', 'de-DE']
  );
});

test('getReferenceSourceLang uses en-US for non-US locales', () => {
  assert.equal(getReferenceSourceLang('en-US'), 'en-US');
  assert.equal(getReferenceSourceLang('es-AR'), 'en-US');
  assert.equal(getReferenceSourceLang('en-GB'), 'en-US');
});

test('entriesToMap keeps real translations over placeholders', () => {
  const map = entriesToMap([
    { itemId: 'foo', text: 'NO APPROVED TRANSLATION' },
    { itemId: 'foo', text: 'Hola' },
  ]);
  assert.equal(map.get('foo'), 'Hola');
});

test('isAudioCapableLanguageEntry requires lang_code and voice or voice_id', () => {
  assert.equal(isAudioCapableLanguageEntry({ lang_code: 'es-AR', voice: 'Melody', voice_id: 'abc' }), true);
  assert.equal(isAudioCapableLanguageEntry({ lang_code: 'de-DE', voice: 'Julia' }), true);
  assert.equal(isAudioCapableLanguageEntry({ lang_code: 'de-DE', voice_id: 'id-only' }), true);
  assert.equal(isAudioCapableLanguageEntry({ lang_code: 'de-DE' }), false);
  assert.equal(isAudioCapableLanguageEntry({ voice: 'A' }), false);
  assert.equal(isAudioCapableLanguageEntry({}), false);
});

test('filterAudioCapableLanguages keeps only configured audio languages', () => {
  const languages = {
    Spanish: { lang_code: 'es-AR', voice: 'Melody', voice_id: 'abc' },
    German: { lang_code: 'de-DE', voice: 'Julia' },
    English: { lang_code: 'en-US', voice: 'Clara', voice_id: 'xyz' },
  };
  const filtered = filterAudioCapableLanguages(languages);
  assert.deepEqual(Object.keys(filtered).sort(), ['English', 'German', 'Spanish']);
  assert.deepEqual(listAudioCapableLangCodes(languages), ['de-DE', 'en-US', 'es-AR']);
  assert.equal(isAudioCapableLangCode(languages, 'es-AR'), true);
  assert.equal(isAudioCapableLangCode(languages, 'de-DE'), true);
  assert.equal(isAudioCapableLangCode(languages, 'fr-CA'), false);
});

test('canonicalizeItembankLangCode maps short config codes to itembank folders', () => {
  assert.equal(canonicalizeItembankLangCode('en'), 'en-US');
  assert.equal(canonicalizeItembankLangCode('de'), 'de-DE');
  assert.equal(canonicalizeItembankLangCode('nl'), 'nl-NL');
  assert.equal(canonicalizeItembankLangCode('eo'), 'eo-UY');
});

test('langCodesMatchForItembank treats config shorthand as equivalent to itembank paths', () => {
  assert.equal(langCodesMatchForItembank('nl', 'nl-NL'), true);
  assert.equal(langCodesMatchForItembank('de', 'de-DE'), true);
  assert.equal(langCodesMatchForItembank('en', 'en-US'), true);
  assert.equal(langCodesMatchForItembank('es-AR', 'es-CO'), false);
});
