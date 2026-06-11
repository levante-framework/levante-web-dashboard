import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTaskCandidates,
  getLanguageAliases,
  getTaskSlugCandidates,
  isLikelyTaskTranslationPath,
} from '../api/move-audio-to-dev.js';

test('normalizeTaskCandidates includes raw, slug, and underscored variants', () => {
  const candidates = normalizeTaskCandidates('Thoughts Feelings');
  assert.deepEqual(candidates, ['thoughts feelings', 'thoughts-feelings', 'thoughts_feelings']);
});

test('getLanguageAliases includes canonical and short aliases', () => {
  const aliases = getLanguageAliases('es-AR');
  assert.deepEqual(aliases, ['es-ar', 'es_ar', 'es']);
});

test('getTaskSlugCandidates maps display labels to canonical folder slugs', () => {
  assert.ok(getTaskSlugCandidates('Memory').includes('memory-game'));
  assert.ok(getTaskSlugCandidates('Pattern Matching').includes('matrix-reasoning'));
  assert.ok(getTaskSlugCandidates('Thoughts & Feelings').includes('child-survey'));
  assert.ok(getTaskSlugCandidates('Math').includes('egma-math'));
  // Canonical slugs passed directly resolve to themselves too.
  assert.ok(getTaskSlugCandidates('matrix-reasoning').includes('matrix-reasoning'));
});

test('isLikelyTaskTranslationPath matches real itembank layout for language aliases', () => {
  const slugCandidates = getTaskSlugCandidates('Memory');
  const langAliases = getLanguageAliases('es-AR');

  assert.equal(
    isLikelyTaskTranslationPath(
      'translations/itembank/memory-game/es-AR/item-bank-translations.json',
      slugCandidates,
      langAliases
    ),
    true
  );
  // Short language alias folder also matches.
  assert.equal(
    isLikelyTaskTranslationPath(
      'translations/itembank/memory-game/es/item-bank-translations.json',
      slugCandidates,
      langAliases
    ),
    true
  );
});

test('isLikelyTaskTranslationPath rejects wrong task, language, or extension', () => {
  const slugCandidates = getTaskSlugCandidates('Memory');
  const langAliases = getLanguageAliases('es-AR');

  // Wrong language.
  assert.equal(
    isLikelyTaskTranslationPath(
      'translations/itembank/memory-game/de-DE/item-bank-translations.json',
      slugCandidates,
      langAliases
    ),
    false
  );
  // Wrong task slug.
  assert.equal(
    isLikelyTaskTranslationPath(
      'translations/itembank/matrix-reasoning/es-AR/item-bank-translations.json',
      slugCandidates,
      langAliases
    ),
    false
  );
  // Wrong extension.
  assert.equal(
    isLikelyTaskTranslationPath(
      'translations/itembank/memory-game/es-AR/item-bank-translations.xliff',
      slugCandidates,
      langAliases
    ),
    false
  );
});
