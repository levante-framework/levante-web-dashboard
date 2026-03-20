export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'method_not_allowed' });

  const deploymentUrl = String(process.env.VERCEL_URL || '').trim();
  const commitSha = String(process.env.VERCEL_GIT_COMMIT_SHA || '').trim();
  const deploymentId = String(process.env.VERCEL_DEPLOYMENT_ID || '').trim();
  const fallback = String(process.env.VERCEL_ENV || 'local').trim();
  const version = deploymentId || deploymentUrl || commitSha || fallback;

  return res.status(200).json({
    success: true,
    version,
    deploymentUrl,
    commitSha,
    deploymentId,
    checkedAt: new Date().toISOString()
  });
}

