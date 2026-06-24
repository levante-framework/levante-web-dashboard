#!/usr/bin/env node
/**
 * Lightweight guardrail test for partner audio approval flow regressions.
 *
 * This is a static "contract" test over `public/partner-audio-dashboard.html`.
 * It prevents reintroducing known failure modes:
 * - fabricated fallback paths for approve/unapprove moves
 * - stale unapproved flags overriding real dev-bucket approved state
 * - missing cache-busting on force-refresh list fetches
 */

const fs = require('fs');
const path = require('path');

const CONTRACTS = [
  {
    kind: 'forbid',
    pattern: /audioPath\s*=\s*`audio\/\$\{this\.currentLangCode\}\/\$\{baseId\}\.mp3`/,
    message: 'Found fabricated fallback audio path assignment. Use real bucket lookup only.'
  },
  {
    kind: 'expect',
    pattern: /findAudioPath\(\s*this\.audioBuckets\.draft\s*,\s*this\.currentLangCode\s*,\s*baseId\s*,\s*\{\s*forceRefresh:\s*true\s*\}\s*\)/,
    message: 'Approve flow must resolve draft path via forceRefresh lookup.'
  },
  {
    kind: 'expect',
    pattern: /findAudioPath\(\s*this\.audioBuckets\.dev\s*,\s*this\.currentLangCode\s*,\s*normalizedBaseId\s*,\s*\{\s*forceRefresh:\s*true\s*\}\s*\)/,
    message: 'Unapprove flow must resolve dev path via forceRefresh lookup.'
  },
  {
    kind: 'expect',
    pattern: /if\s*\(\s*this\.unapprovedItems\.has\(baseId\)\s*\)\s*\{\s*this\.unapprovedItems\.delete\(baseId\);\s*\}/,
    message: 'loadApprovalStatus must clear stale unapproved flags for dev-bucket items.'
  },
  {
    kind: 'expect',
    pattern: /params\.set\('_ts',\s*String\(Date\.now\(\)\)\)/,
    message: 'fetchAudioFileIds forceRefresh must add cache-busting timestamp.'
  },
  {
    kind: 'expect',
    pattern: /cache:\s*options\.forceRefresh\s*\?\s*'no-store'\s*:\s*'default'/,
    message: "fetchAudioFileIds forceRefresh must use fetch cache:'no-store'."
  },
  {
    kind: 'expect',
    pattern: /invalidateAudioCache\(this\.audioBuckets\.draft,\s*this\.currentLangCode,\s*baseId\)/,
    message: 'Approve flow must invalidate draft cache for moved item.'
  },
  {
    kind: 'expect',
    pattern: /invalidateAudioCache\(this\.audioBuckets\.dev,\s*this\.currentLangCode,\s*baseId\)/,
    message: 'Approve flow must invalidate dev cache for moved item.'
  },
  {
    kind: 'expect',
    pattern: /invalidateAudioCache\(this\.audioBuckets\.dev,\s*this\.currentLangCode,\s*normalizedBaseId\)/,
    message: 'Unapprove flow must invalidate dev cache for moved item.'
  },
  {
    kind: 'expect',
    pattern: /invalidateAudioCache\(this\.audioBuckets\.draft,\s*this\.currentLangCode,\s*normalizedBaseId\)/,
    message: 'Unapprove flow must invalidate draft cache for moved item.'
  },
  {
    kind: 'expect',
    pattern: /setLanguageShellState\s*\(/,
    message: 'Language shell must gate main dashboard content until language data is loaded.'
  },
  {
    kind: 'expect',
    pattern: /id="languageSetupPrompt"|id="dashboardMainContent"|id="languageLoadingPanel"/,
    message: 'Language setup prompt, loader panel, and gated main content regions must exist.'
  }
];

function runRegressionChecks(text) {
  for (const { kind, pattern, message } of CONTRACTS) {
    const matched = pattern.test(text);
    if (kind === 'expect' && !matched) {
      throw new Error(message);
    }
    if (kind === 'forbid' && matched) {
      throw new Error(message);
    }
  }
}

function readDashboardSource(cwd = process.cwd()) {
  const target = path.join(cwd, 'public', 'partner-audio-dashboard.html');
  return fs.readFileSync(target, 'utf8');
}

function run() {
  const text = readDashboardSource();
  runRegressionChecks(text);
  console.log('PASS: partner audio approval regression checks');
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  CONTRACTS,
  readDashboardSource,
  runRegressionChecks,
  run
};
