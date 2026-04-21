#!/usr/bin/env node

const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runInDir(command, cwd) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableVercelDeployError(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('invalid json response body') ||
    text.includes('internal server error') ||
    text.includes("unexpected token 'i'") ||
    text.includes('fetcherror') ||
    text.includes('socket hang up') ||
    text.includes('ecconnreset') ||
    text.includes('etimedout')
  );
}

async function runVercelDeployWithRetry(cwd, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        console.log(`🔁 Retrying Vercel deploy (${attempt}/${maxAttempts})...`);
      }
      const { stdout } = await runInDir(
        'npx -y vercel --prod --yes --archive=tgz -b PUPPETEER_SKIP_DOWNLOAD=1 -b PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1',
        cwd
      );
      return stdout;
    } catch (err) {
      lastError = err;
      const retryable = isRetryableVercelDeployError(err?.message || err);
      if (!retryable || attempt === maxAttempts) {
        throw err;
      }
      const waitMs = 2000 * Math.pow(2, attempt - 1);
      console.warn(`⚠️  Vercel API transient failure (attempt ${attempt}/${maxAttempts}): ${err.message}`);
      console.warn(`⏳ Waiting ${Math.round(waitMs / 1000)}s before retry...`);
      await sleep(waitMs);
    }
  }
  throw lastError || new Error('Vercel deployment failed.');
}

(async () => {
  let deployCwd = process.cwd();
  let tempDeployDir = null;
  try {
    // Deploy from tracked files only to avoid Vercel upload hangs on large local dirs.
    tempDeployDir = fs.mkdtempSync(path.join(os.tmpdir(), 'levante-deploy-'));
    await run(`git archive --format=tar HEAD | tar -x -C ${shellEscape(tempDeployDir)}`);
    // Overlay local tracked changes so hotfixes can be deployed without committing.
    const { stdout: changedTrackedFilesRaw } = await run('git diff --name-only HEAD');
    const changedTrackedFiles = changedTrackedFilesRaw
      .split('\n')
      .map((file) => file.trim())
      .filter(Boolean);
    const { stdout: untrackedFilesRaw } = await run('git ls-files --others --exclude-standard');
    const untrackedFiles = untrackedFilesRaw
      .split('\n')
      .map((file) => file.trim())
      .filter(Boolean);
    const filesToOverlay = Array.from(new Set([...changedTrackedFiles, ...untrackedFiles]));
    const overlayIgnorePrefixes = [
      'node_modules/',
      '.venv/',
      '.venv-emb/',
      'venv/',
    ];
    filesToOverlay.forEach((relativePath) => {
      const normalizedPath = String(relativePath || '').replace(/\\/g, '/');
      if (overlayIgnorePrefixes.some((prefix) => normalizedPath.startsWith(prefix))) {
        return;
      }
      const sourcePath = path.join(process.cwd(), relativePath);
      const targetPath = path.join(tempDeployDir, relativePath);
      if (fs.existsSync(sourcePath)) {
        const stats = fs.statSync(sourcePath);
        if (stats.isDirectory()) return;
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
      } else if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { force: true });
      }
    });

    // Include generated geo-strategy overlay datasets even when untracked.
    // These are static public assets required by runtime URL params (e.g. ?overlay=20000).
    const geoStrategyDir = path.join(process.cwd(), 'public', 'gallery', 'geo-strategy');
    if (fs.existsSync(geoStrategyDir)) {
      const generatedOverlayFiles = fs
        .readdirSync(geoStrategyDir)
        .filter((name) => /^gallery-data-\d+\.json$/i.test(String(name || '').trim()));
      generatedOverlayFiles.forEach((fileName) => {
        const relPath = path.join('public', 'gallery', 'geo-strategy', fileName);
        const sourcePath = path.join(process.cwd(), relPath);
        const targetPath = path.join(tempDeployDir, relPath);
        if (!fs.existsSync(sourcePath)) return;
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
      });
    }
    deployCwd = tempDeployDir;

    const localProjectJson = path.join(process.cwd(), '.vercel', 'project.json');
    if (fs.existsSync(localProjectJson)) {
      const vercelDir = path.join(tempDeployDir, '.vercel');
      fs.mkdirSync(vercelDir, { recursive: true });
      fs.copyFileSync(localProjectJson, path.join(vercelDir, 'project.json'));
    }

    console.log('🚀 Deploying to Vercel (production)...');
    await runInDir('node scripts/apply-version.js', deployCwd);
    // Avoid pulling large optional binaries during the Vercel build (keeps serverless bundles under size limits).
    const deployOut = await runVercelDeployWithRetry(deployCwd, 3);
    process.stdout.write(deployOut);

    // Try to extract the production deployment URL from the CLI output
    let deploymentUrl = null;
    const prodLine = deployOut.match(/Production:\s*(https:\/\/[^\s]+)/);
    if (prodLine && prodLine[1]) {
      deploymentUrl = prodLine[1];
    }
    if (!deploymentUrl) {
      const urls = deployOut.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/g) || [];
      if (urls.length) {
        deploymentUrl = urls[urls.length - 1];
      }
    }
    if (!deploymentUrl) {
      throw new Error('Could not extract deployment URL from Vercel output.');
    }
    console.log(`✅ Deployment URL: ${deploymentUrl}`);

    const deploymentHost = new URL(deploymentUrl).host;
    const aliases = [
      'levante-pitwall.vercel.app',
      'levante-partner-tools.vercel.app'
    ];

    for (const alias of aliases) {
      console.log(`🔗 Setting alias: ${alias}`);
      try {
        const { stdout: aliasOut } = await run(`npx -y vercel alias set ${deploymentUrl} ${alias}`);
        process.stdout.write(aliasOut);
      } catch (e) {
        console.warn(`⚠️  Failed to set alias ${alias}: ${e.message}`);
      }
    }

    const hostsToVerify = [deploymentHost, ...aliases];
    console.log('🔎 Verifying deployment across aliases...');
    await run(`node scripts/verify-deploy.js ${hostsToVerify.map((host) => `https://${host}`).join(' ')}`);

    console.log('🎉 Deployment and aliasing complete.');
  } catch (err) {
    console.error('❌ Deployment failed:', err.message);
    process.exit(1);
  } finally {
    if (tempDeployDir && fs.existsSync(tempDeployDir)) {
      try {
        fs.rmSync(tempDeployDir, { recursive: true, force: true });
      } catch (_) {
        // non-fatal cleanup failure
      }
    }
  }
})();
