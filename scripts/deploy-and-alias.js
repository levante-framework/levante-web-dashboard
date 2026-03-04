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
    const overlayIgnorePrefixes = [
      'node_modules/',
      '.venv/',
      '.venv-emb/',
      'venv/',
    ];
    changedTrackedFiles.forEach((relativePath) => {
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
    const { stdout: deployOut } = await runInDir(
      'npx -y vercel --prod --yes --archive=tgz -b PUPPETEER_SKIP_DOWNLOAD=1 -b PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1',
      deployCwd
    );
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
      'levante-pitwall.vercel.app'
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
