#!/usr/bin/env node

const { execSync } = require('child_process');

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8' });
}

function ensureCleanWorkingTree() {
  const status = run('git status --porcelain', { capture: true }).trim();
  if (status.length > 0) {
    console.error('❌ Working tree has uncommitted changes. Commit/stash before deploying.');
    process.exit(1);
  }
}

function pushHead() {
  console.log('📤 Pushing current HEAD to origin…');
  run('git push origin HEAD');
}

function deploy() {
  console.log('🚀 Running `vercel --prod --confirm`…');
  const output = run('vercel --prod --confirm', { capture: true });
  process.stdout.write(output);

  const match = output.match(/https?:\/\/[^\s]+\.vercel\.app[^\s]*/g);
  if (match?.length) {
    const url = match[match.length - 1];
    console.log('\n✅ Deployment URL:');
    console.log(`   ${url}`);
    console.log('\nNext steps:');
    console.log('  1. Open the URL to verify the change.');
    console.log('  2. Purge cache (Deployment → “Purge Cache”) or hit the alias with a new query string.');
  } else {
    console.warn('\n⚠️ Could not detect a deployment URL in the Vercel output. Review logs above.');
  }
}

function main() {
  ensureCleanWorkingTree();
  pushHead();
  deploy();
}

main();
