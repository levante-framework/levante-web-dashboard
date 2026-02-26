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

const target = path.join(process.cwd(), 'public', 'partner-audio-dashboard.html');
const text = fs.readFileSync(target, 'utf8');

function expect(pattern, message) {
  if (!pattern.test(text)) {
    throw new Error(message);
  }
}

function forbid(pattern, message) {
  if (pattern.test(text)) {
    throw new Error(message);
  }
}

function run() {
  // 1) No fabricated fallback paths in approve/unapprove move path resolution.
  forbid(
    /audioPath\s*=\s*`audio\/\$\{this\.currentLangCode\}\/\$\{baseId\}\.mp3`/,
    'Found fabricated fallback audio path assignment. Use real bucket lookup only.'
  );

  // 2) Approve must resolve draft path via force-refresh lookup.
  expect(
    /findAudioPath\(\s*this\.audioBuckets\.draft\s*,\s*this\.currentLangCode\s*,\s*baseId\s*,\s*\{\s*forceRefresh:\s*true\s*\}\s*\)/,
    'Approve flow must resolve draft path via forceRefresh lookup.'
  );

  // 3) Unapprove must resolve dev path via force-refresh lookup.
  expect(
    /findAudioPath\(\s*this\.audioBuckets\.dev\s*,\s*this\.currentLangCode\s*,\s*normalizedBaseId\s*,\s*\{\s*forceRefresh:\s*true\s*\}\s*\)/,
    'Unapprove flow must resolve dev path via forceRefresh lookup.'
  );

  // 4) Dev bucket approval status must clear stale unapproved flags.
  expect(
    /if\s*\(\s*this\.unapprovedItems\.has\(baseId\)\s*\)\s*\{\s*this\.unapprovedItems\.delete\(baseId\);\s*\}/,
    'loadApprovalStatus must clear stale unapproved flags for dev-bucket items.'
  );

  // 5) Force-refresh listing should bypass cache.
  expect(
    /params\.set\('_ts',\s*String\(Date\.now\(\)\)\)/,
    'fetchAudioFileIds forceRefresh must add cache-busting timestamp.'
  );
  expect(
    /cache:\s*options\.forceRefresh\s*\?\s*'no-store'\s*:\s*'default'/,
    "fetchAudioFileIds forceRefresh must use fetch cache:'no-store'."
  );

  // 6) Move operations should invalidate both draft/dev caches for the moved base id.
  expect(
    /invalidateAudioCache\(this\.audioBuckets\.draft,\s*this\.currentLangCode,\s*baseId\)/,
    'Approve flow must invalidate draft cache for moved item.'
  );
  expect(
    /invalidateAudioCache\(this\.audioBuckets\.dev,\s*this\.currentLangCode,\s*baseId\)/,
    'Approve flow must invalidate dev cache for moved item.'
  );
  expect(
    /invalidateAudioCache\(this\.audioBuckets\.dev,\s*this\.currentLangCode,\s*normalizedBaseId\)/,
    'Unapprove flow must invalidate dev cache for moved item.'
  );
  expect(
    /invalidateAudioCache\(this\.audioBuckets\.draft,\s*this\.currentLangCode,\s*normalizedBaseId\)/,
    'Unapprove flow must invalidate draft cache for moved item.'
  );

  console.log('PASS: partner audio approval regression checks');
}

try {
  run();
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
}
