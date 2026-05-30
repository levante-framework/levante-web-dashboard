#!/usr/bin/env node

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadValidationContext() {
  const validationPath = path.join(__dirname, '..', 'public', 'js', 'validation.js');
  const source = fs.readFileSync(validationPath, 'utf8');

  const context = {
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => {
      throw new Error('fetch should not be called in manual approval tests');
    },
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null
    },
    window: {
      CONFIG: {},
      localStorage: { getItem: () => null, setItem: () => null, removeItem: () => null },
      dashboard: {
        validation_results: {},
        currentLanguage: 'Spanish',
        languages: { Spanish: { lang_code: 'es' } },
        resolvePreferredLangCode(code) {
          return code;
        },
        saveValidationResults() {
          return Promise.resolve();
        }
      }
    }
  };

  context.globalThis = context;
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'validation.js' });

  // Keep tests focused on state mutation rather than DOM updates.
  context.applyValidationUiFromResult = () => {};
  context.updateValidationSummary = () => {};

  return context;
}

test('manual unapprove clears stale "Manually approved" marker', () => {
  const context = loadValidationContext();
  const itemId = 'sample-item-1';
  const langCode = 'es';

  context.window.dashboard.validation_results[itemId] = {
    [langCode]: {}
  };

  context.setManualApprovalForValidation(itemId, langCode, true, null);
  context.setManualApprovalForValidation(itemId, langCode, false, null);

  const result = context.window.dashboard.validation_results[itemId][langCode];
  assert.equal(result.manualApproved, false);
  assert.equal(String(result.notes || '').toLowerCase(), '');
  assert.equal(String(result.scoreSource || '').toLowerCase(), '');
});

test('manual unapprove restores previous notes and score source', () => {
  const context = loadValidationContext();
  const itemId = 'sample-item-2';
  const langCode = 'es';

  context.window.dashboard.validation_results[itemId] = {
    [langCode]: {
      score: 0.87,
      scoreSource: 'ai',
      notes: 'Needs terminology follow-up',
      aiUsed: true
    }
  };

  context.setManualApprovalForValidation(itemId, langCode, true, null);
  context.setManualApprovalForValidation(itemId, langCode, false, null);

  const result = context.window.dashboard.validation_results[itemId][langCode];
  assert.equal(result.manualApproved, false);
  assert.equal(result.notes, 'Needs terminology follow-up');
  assert.equal(result.score, 0.87);
  assert.equal(result.scoreSource, 'ai');
  assert.equal(result.manualOverridePreviousNotes, undefined);
});
