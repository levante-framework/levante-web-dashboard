#!/usr/bin/env node

const { exec } = require('child_process');

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

(async () => {
  try {
    console.log('🚀 Deploying to Vercel (production)...');
    const { stdout: deployOut } = await run('npx -y vercel --prod --yes');
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

    const aliases = [
      'audio-dashboard-levante.vercel.app',
      'levante-audio-dashboard.vercel.app',
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

    console.log('🎉 Deployment and aliasing complete.');
  } catch (err) {
    console.error('❌ Deployment failed:', err.message);
    process.exit(1);
  }
})();
