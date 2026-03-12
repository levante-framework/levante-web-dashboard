#!/usr/bin/env node
/* eslint-disable no-console */

function parseArgs(argv) {
  const args = { url: process.env.CROWDIN_SCREENSHOT_ARTIFACT_URL || '' };
  for (let i = 2; i < argv.length; i += 1) {
    const part = String(argv[i] || '').trim();
    if (part === '--url') {
      args.url = String(argv[i + 1] || '').trim();
      i += 1;
    }
  }
  return args;
}

function isCachedShot(shot) {
  const cachedFlag = String(shot?.cached || '').toLowerCase() === 'true';
  const cachedUrl = String(shot?.cachedUrl || '').trim();
  const url = String(shot?.url || '').trim();
  return (
    cachedFlag
    || /storage\.googleapis\.com/i.test(cachedUrl)
    || /storage\.googleapis\.com/i.test(url)
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const artifactUrl = args.url || 'https://levante-pitwall.vercel.app/api/crowdin-screenshot-artifact';
  console.log(`Checking screenshot artifact cache coverage: ${artifactUrl}`);
  const response = await fetch(artifactUrl, { headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) {
    throw new Error(`Artifact request failed: ${response.status}`);
  }
  const payload = await response.json();
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  let totalShots = 0;
  let cachedShots = 0;
  entries.forEach((entry) => {
    const shots = Array.isArray(entry?.screenshots) ? entry.screenshots : [];
    shots.forEach((shot) => {
      totalShots += 1;
      if (isCachedShot(shot)) cachedShots += 1;
    });
  });
  const pct = totalShots ? ((cachedShots / totalShots) * 100).toFixed(2) : '0.00';
  console.log(`Generated at: ${payload?.generatedAt || 'unknown'}`);
  console.log(`Entries: ${entries.length}`);
  console.log(`Screenshots: ${totalShots}`);
  console.log(`Cached screenshots: ${cachedShots} (${pct}%)`);
  if (!totalShots) {
    console.log('No screenshots found in artifact.');
    return;
  }
  if (Number(pct) < 90) {
    console.warn('⚠️ Cache coverage is below 90%. Run screenshot rebuild to refresh cache URLs.');
  } else {
    console.log('✅ Cache coverage looks healthy.');
  }
}

main().catch((error) => {
  console.error('❌ Cache coverage check failed:', error?.message || error);
  process.exit(1);
});

