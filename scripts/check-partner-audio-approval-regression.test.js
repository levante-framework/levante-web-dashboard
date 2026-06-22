#!/usr/bin/env node

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTRACTS,
  readDashboardSource,
  runRegressionChecks
} = require('./check-partner-audio-approval-regression');

test('partner audio dashboard satisfies approval regression contracts', () => {
  const dashboardSource = readDashboardSource();
  assert.doesNotThrow(() => runRegressionChecks(dashboardSource));
});

test('regression contracts cover expected approval safeguards', () => {
  assert.ok(CONTRACTS.length >= 16, 'Expected at least 16 approval contract checks.');
});

test('fails when approve force-refresh lookup contract is removed', () => {
  const dashboardSource = readDashboardSource();
  const approveLookupPattern =
    /findAudioPath\(\s*this\.audioBuckets\.draft\s*,\s*this\.currentLangCode\s*,\s*baseId\s*,\s*\{\s*forceRefresh:\s*true\s*\}\s*\)/;
  const sourceWithoutApproveLookup = dashboardSource.replace(
    new RegExp(approveLookupPattern.source, 'g'),
    '/* removed for test */'
  );

  assert.throws(
    () => runRegressionChecks(sourceWithoutApproveLookup),
    /Approve flow must resolve draft path via forceRefresh lookup\./
  );
});

test('fails when fabricated fallback audio path is introduced', () => {
  const dashboardSource = readDashboardSource();
  const sourceWithFallback = `${dashboardSource}\naudioPath = \`audio/\${this.currentLangCode}/\${baseId}.mp3\`;`;

  assert.throws(
    () => runRegressionChecks(sourceWithFallback),
    /Found fabricated fallback audio path assignment/
  );
});
