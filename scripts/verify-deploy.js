#!/usr/bin/env node

const https = require('https');

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`GET ${url} failed (${res.statusCode}) ${body.slice(0, 200)}`));
          }
        });
      })
      .on('error', reject);
  });
}

async function verifyHost(host) {
  const baseUrl = host.startsWith('http') ? host : `https://${host}`;
  const html = await fetchText(`${baseUrl}/preflight-report.html`);
  if (html.includes('id="crowdinAuditSection"')) {
    throw new Error(`preflight-report.html on ${baseUrl} still contains Crowdin section`);
  }
  if (html.includes('id="bucketInfoSection"')) {
    throw new Error(`preflight-report.html on ${baseUrl} still contains Bucket Info section`);
  }
  if (html.includes('visualGifSummary') || html.includes('visualGifSummaryProd')) {
    throw new Error(`preflight-report.html on ${baseUrl} still contains GIF summary markup`);
  }
  if (!html.includes('configValidationInlineIssues') || !html.includes('configValidationInlineIssuesProd')) {
    throw new Error(`preflight-report.html on ${baseUrl} missing inline config validation issue containers`);
  }

  const apiJson = await fetchText(`${baseUrl}/api/visual-audit?env=dev&prefix=visual/`);
  let payload;
  try {
    payload = JSON.parse(apiJson);
  } catch (err) {
    throw new Error(`visual-audit JSON invalid on ${baseUrl}: ${err.message}`);
  }

  const requiredFields = [
    'gifCount',
    'gifSizeBytes',
    'gifWebpCount',
    'gifWebpSizeBytes',
    'gifSavingsBytes',
    'gifMissingCount'
  ];
  for (const field of requiredFields) {
    if (!(field in payload)) {
      throw new Error(`visual-audit response on ${baseUrl} missing ${field}`);
    }
  }
  if (!Array.isArray(payload.missing)) {
    throw new Error(`visual-audit response on ${baseUrl} missing missing[] array`);
  }
  return true;
}

(async () => {
  try {
    const hosts = process.argv.slice(2).filter(Boolean);
    if (!hosts.length) {
      throw new Error('Usage: node scripts/verify-deploy.js <host1> [host2 ...]');
    }
    for (const host of hosts) {
      await verifyHost(host.replace(/\/$/, ''));
      console.log(`✅ Deployment check passed for ${host}`);
    }
  } catch (error) {
    console.error('❌ Deployment verification failed:', error.message);
    process.exit(1);
  }
})();
