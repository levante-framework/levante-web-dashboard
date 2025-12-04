#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PREVIEW_FILE = path.join('.vercel', 'latest-preview-url.txt');
const STAGING_ALIAS = process.env.VERCEL_STAGING_ALIAS || '';
const PROD_ALIAS = process.env.VERCEL_PROD_ALIAS || 'levante-web-dashboard.vercel.app';

const args = process.argv.slice(2);
const promoteMode = args.includes('--promote') || args.includes('--alias');
const fromArg = args.find(arg => arg.startsWith('--from=')) || '';
const overrideDeploymentUrl = fromArg ? fromArg.split('=').slice(1).join('=') : '';

function run(cmd, opts = {}) {
  return execSync(cmd, {
    stdio: opts.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
}

function ensureCleanWorkingTree() {
  const status = run('git status --porcelain', { capture: true }).trim();
  if (status.length > 0) {
    console.error('❌ Working tree has uncommitted changes. Commit or stash before deploying.');
    process.exit(1);
  }
}

function pushHead() {
  console.log('📤 Pushing current HEAD to origin…');
  run('git push origin HEAD');
}

function parseDeploymentUrl(output) {
  if (!output) return '';
  const match = output.match(/https?:\/\/[^\s]+\.vercel\.app[^\s]*/g);
  return match && match.length ? match[match.length - 1].trim() : '';
}

function createPreviewDeployment() {
  console.log('🚀 Running `vercel --confirm`…');
  const output = run('vercel --confirm', { capture: true });
  process.stdout.write(output);
  const url = parseDeploymentUrl(output);
  if (!url) {
    console.warn('⚠️ Could not detect a deployment URL in the Vercel output.');
  }
  return url;
}

function writePreviewUrl(url) {
  fs.mkdirSync(path.dirname(PREVIEW_FILE), { recursive: true });
  fs.writeFileSync(PREVIEW_FILE, `${url}\n`, 'utf8');
}

function readPreviewUrl() {
  try {
    return fs.readFileSync(PREVIEW_FILE, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function aliasDeployment(url, alias) {
  if (!alias) return false;
  console.log(`🔗 Setting alias ${alias} → ${url}`);
  try {
    run(`vercel alias set ${url} ${alias} --yes`);
    console.log('   Alias updated successfully.');
    return true;
  } catch (error) {
    console.warn(`⚠️ Failed to set alias ${alias}: ${error.message || error}`);
    return false;
  }
}

function main() {
  if (!promoteMode) {
    ensureCleanWorkingTree();
    pushHead();
    const deploymentUrl = createPreviewDeployment();
    if (!deploymentUrl) {
      process.exit(1);
    }
    writePreviewUrl(deploymentUrl);

    const staged = aliasDeployment(deploymentUrl, STAGING_ALIAS);

    console.log('\n✅ Preview deployment ready:');
    console.log(`   ${deploymentUrl}`);
    if (staged) {
      console.log(`   ↳ ${STAGING_ALIAS}`);
    } else if (STAGING_ALIAS) {
      console.log(`   (Alias ${STAGING_ALIAS} was not updated; see warning above.)`);
    }
    console.log('\nNext steps:');
    console.log('  1. Open the URL above (or the staging alias) to test the build.');
    console.log('  2. When ready, run `npm run deploy:prod` to promote this exact deployment.');
    return;
  }

  const deploymentUrl = overrideDeploymentUrl || readPreviewUrl();
  if (!deploymentUrl) {
    console.error('❌ No cached preview deployment found. Run `npm run deploy:test` first or pass --from=<deployment-url>.');
    process.exit(1);
  }

  const targetAlias = PROD_ALIAS;
  if (!targetAlias) {
    console.error('❌ Set VERCEL_PROD_ALIAS before promoting to production.');
    process.exit(1);
  }

  console.log(`🔁 Promoting ${deploymentUrl} → ${targetAlias}…`);
  const success = aliasDeployment(deploymentUrl, targetAlias);
  if (!success) {
    console.error('❌ Failed to update the production alias.');
    process.exit(1);
  }

  console.log('\n✅ Production alias updated.');
  console.log(`   ${targetAlias} now serves ${deploymentUrl}`);
}

main();
