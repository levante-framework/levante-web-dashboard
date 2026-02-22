/**
 * API: creates Crowdin build (approved only), polls until ready, returns the ZIP download URL.
 * The client fetches the ZIP from that URL and unzips/parses in the browser.
 * We do not download the ZIP on the server to avoid 504 (function timeout) and stay under 60s.
 */

const CROWDIN_API_BASE = 'https://api.crowdin.com/api/v2';

function sendError(res, message, status = 500) {
    if (!res.headersSent) {
        res.status(status).json({
            error: 'Failed to fetch Crowdin approved translations',
            details: message
        });
    }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }
    if (req.url && (req.url.includes('?ping') || req.url.includes('&ping'))) {
        res.status(200).json({ ok: true, message: 'Crowdin API route is running' });
        return;
    }
    try {
        await runHandler(req, res);
    } catch (err) {
        console.error('Crowdin approved translations API error:', err);
        sendError(res, err.message || String(err));
    }
};

async function runHandler(req, res) {
    const CROWDIN_PROJECT_ID = process.env.LEVANTE_TRANSLATIONS_PROJECT_ID || '756721';
    const CROWDIN_TOKEN = process.env.CROWDIN_API_TOKEN;
    if (!CROWDIN_TOKEN) {
        sendError(res, 'CROWDIN_API_TOKEN is not set in Vercel. Add it in Project → Settings → Environment Variables (Production), then redeploy.');
        return;
    }

    const authHeader = { Authorization: `Bearer ${CROWDIN_TOKEN}`, 'Content-Type': 'application/json' };

    const buildRes = await fetch(`${CROWDIN_API_BASE}/projects/${CROWDIN_PROJECT_ID}/translations/builds`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({ exportApprovedOnly: true })
    });
    if (!buildRes.ok) {
        const errText = await buildRes.text();
        throw new Error(`Crowdin build failed: ${buildRes.status} ${errText}`);
    }
    const buildBody = await buildRes.json();
    const buildId = buildBody.data?.id;
    if (!buildId) throw new Error('No build id in response');

    const maxAttempts = 28;
    const pollMs = 2000;
    let buildStatus = 'building';
    let buildData = null;
    for (let i = 0; i < maxAttempts; i++) {
        const statusRes = await fetch(`${CROWDIN_API_BASE}/projects/${CROWDIN_PROJECT_ID}/translations/builds/${buildId}`, {
            headers: authHeader
        });
        if (!statusRes.ok) throw new Error(`Build status failed: ${statusRes.status}`);
        const statusBody = await statusRes.json();
        buildData = statusBody.data;
        buildStatus = buildData?.status;
        if (buildStatus === 'finished') break;
        if (buildStatus === 'failed' || buildStatus === 'cancelled') {
            throw new Error(`Build ${buildStatus}`);
        }
        await new Promise(r => setTimeout(r, pollMs));
    }
    if (buildStatus !== 'finished' || !buildData) {
        throw new Error('Build did not finish in time (Crowdin is busy). Try again in a minute.');
    }

    const downloadRes = await fetch(`${CROWDIN_API_BASE}/projects/${CROWDIN_PROJECT_ID}/translations/builds/${buildId}/download`, {
        headers: authHeader
    });
    if (!downloadRes.ok) throw new Error(`Download link failed: ${downloadRes.status}`);
    const downloadBody = await downloadRes.json();
    const zipUrl = downloadBody.data?.url;
    if (!zipUrl) throw new Error('No download URL');

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ zipUrl, source: 'Crowdin (approved only)' });
}
