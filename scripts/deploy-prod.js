#!/usr/bin/env node

/**
 * Deploy helper used by:
 *   npm run deploy:test  → create a fresh preview + (optional) staging alias
 *   npm run deploy:prod  → promote the cached preview to all production aliases
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PREVIEW_FILE = path.join('.vercel', 'latest-preview-url.txt');
const STAGING_ALIAS = process.env.VERCEL_STAGING_ALIAS || '';
const PRIMARY_PROD_ALIAS = process.env.VERCEL_PROD_ALIAS || 'levante-pitwall.vercel.app';
const LEGACY_PROD_ALIASES = (process.env.VERCEL_PROD_ALIASES
  ? process.env.VERCEL_PROD_ALIASES.split(',').map(alias => alias.trim()).filter(Boolean)
  : [
      'levante-pitwall.vercel.app',
    ]
);

function resolveVercelBin() {
  if (process.env.VERCEL_BIN) return process.env.VERCEL_BIN;

  const appData = process.env.APPDATA;
  if (appData) {
    const candidate = path.join(appData, 'npm', 'vercel');
    if (fs.existsSync(candidate)) return candidate;
  }

  const userProfile = process.env.USERPROFILE;
  if (userProfile) {
    const candidate = path.join(userProfile, 'AppData', 'Roaming', 'npm', 'vercel');
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fall back to npx so the script works without a pinned local CLI dependency.
  return 'npx -y vercel';
}

const VERCEL_BIN = resolveVercelBin();
console.log(`ℹ️ Using Vercel CLI binary: ${VERCEL_BIN}`);

const args = process.argv.slice(2);
const promoteMode = args.includes('--promote') || args.includes('--alias');
const fromArg = args.find(arg => arg.startsWith('--from='));
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
  console.log(`🚀 Running \`${VERCEL_BIN} --confirm\`…`);
  const output = run(`${VERCEL_BIN} --confirm`, { capture: true });
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
    run(`${VERCEL_BIN} alias set ${url} ${alias}`);
    console.log('   Alias updated successfully.');
    return true;
  } catch (error) {
    console.warn(`⚠️ Failed to set alias ${alias}: ${error.message || error}`);
    return false;
  }
}

function promoteDeployment(deploymentUrl) {
  const aliasSet = new Set([PRIMARY_PROD_ALIAS, ...LEGACY_PROD_ALIASES.filter(Boolean)]);
  if (!aliasSet.size) {
    console.error('❌ No production aliases configured. Set VERCEL_PROD_ALIAS or VERCEL_PROD_ALIASES.');
    process.exit(1);
  }

  console.log(`🔁 Promoting ${deploymentUrl} to ${aliasSet.size} production alias(es)…`);
  let failures = 0;
  aliasSet.forEach(alias => {
    const success = aliasDeployment(deploymentUrl, alias);
    if (!success) failures += 1;
  });

  if (failures > 0) {
    console.error(`❌ Failed to update ${failures} production alias(es).`);
    process.exit(1);
  }

  console.log('\n✅ Production aliases updated:');
  aliasSet.forEach(alias => console.log(`   ${alias} now serves ${deploymentUrl}`));
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

    const staged = STAGING_ALIAS ? aliasDeployment(deploymentUrl, STAGING_ALIAS) : false;

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

  promoteDeployment(deploymentUrl);
}

main();

