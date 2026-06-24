import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCanonicalTaskSlug,
  findLanguageOptionsKey,
  appendTaskSlugToLanguageEntry,
  applyTaskSlugToLanguageOptionsDocument,
} from '../api/lib/language-options-task-options.js';

const SAMPLE = {
  'de-DE': {
    languageMenu: 'Deutsch (Deutschland)',
    languageTaskPicker: 'German (Germany)',
    taskOptions: ['intro', 'egma-math'],
  },
  'nl-NL': {
    languageMenu: 'Nederlands',
    languageTaskPicker: 'Dutch',
    testing: true,
  },
};

test('resolveCanonicalTaskSlug maps display labels to itembank slugs', () => {
  assert.equal(resolveCanonicalTaskSlug('Memory'), 'memory-game');
  assert.equal(resolveCanonicalTaskSlug('hearts-and-flowers'), 'hearts-and-flowers');
});

test('findLanguageOptionsKey resolves short dashboard codes to BCP-47 keys', () => {
  assert.equal(findLanguageOptionsKey(SAMPLE, 'de'), 'de-DE');
  assert.equal(findLanguageOptionsKey(SAMPLE, 'nl-NL'), 'nl-NL');
  assert.equal(findLanguageOptionsKey(SAMPLE, 'fr-FR'), null);
});

test('appendTaskSlugToLanguageEntry appends without duplicating', () => {
  const entry = { taskOptions: ['intro'] };
  const first = appendTaskSlugToLanguageEntry(entry, 'memory-game');
  assert.equal(first.changed, true);
  assert.deepEqual(entry.taskOptions, ['intro', 'memory-game']);

  const second = appendTaskSlugToLanguageEntry(entry, 'memory-game');
  assert.equal(second.changed, false);
  assert.equal(second.alreadyPresent, true);
  assert.deepEqual(entry.taskOptions, ['intro', 'memory-game']);
});

test('appendTaskSlugToLanguageEntry creates taskOptions when missing', () => {
  const entry = { languageMenu: 'Nederlands' };
  const result = appendTaskSlugToLanguageEntry(entry, 'trog');
  assert.equal(result.changed, true);
  assert.equal(result.createdTaskOptions, true);
  assert.deepEqual(entry.taskOptions, ['trog']);
});

test('applyTaskSlugToLanguageOptionsDocument only mutates the matching language entry', () => {
  const doc = JSON.parse(JSON.stringify(SAMPLE));
  const result = applyTaskSlugToLanguageOptionsDocument(doc, { langCode: 'de-DE', task: 'vocab' });
  assert.equal(result.changed, true);
  assert.equal(result.languageKey, 'de-DE');
  assert.deepEqual(doc['de-DE'].taskOptions, ['intro', 'egma-math', 'vocab']);
  assert.deepEqual(doc['nl-NL'], SAMPLE['nl-NL']);
});
