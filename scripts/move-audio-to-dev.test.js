import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTaskCandidates,
  getLanguageAliases,
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

test('isLikelyTaskTranslationPath matches task JSON for language aliases', () => {
  const taskCandidates = normalizeTaskCandidates('thoughts-feelings');
  const langAliases = getLanguageAliases('es-AR');

  assert.equal(
    isLikelyTaskTranslationPath(
      'translations/es-ar/main/itembank_by_task/thoughts-feelings.json',
      taskCandidates,
      langAliases
    ),
    true
  );

  assert.equal(
    isLikelyTaskTranslationPath(
      'es_ar/main/itembank_by_task/thoughts_feelings.json',
      taskCandidates,
      langAliases
    ),
    true
  );
});

test('isLikelyTaskTranslationPath rejects wrong task, language, or extension', () => {
  const taskCandidates = normalizeTaskCandidates('thoughts-feelings');
  const langAliases = getLanguageAliases('es-AR');

  assert.equal(
    isLikelyTaskTranslationPath(
      'translations/de-de/main/itembank_by_task/thoughts-feelings.json',
      taskCandidates,
      langAliases
    ),
    false
  );
  assert.equal(
    isLikelyTaskTranslationPath(
      'translations/es-ar/main/itembank_by_task/math.json',
      taskCandidates,
      langAliases
    ),
    false
  );
  assert.equal(
    isLikelyTaskTranslationPath(
      'translations/es-ar/main/itembank_by_task/thoughts-feelings.xliff',
      taskCandidates,
      langAliases
    ),
    false
  );
});
