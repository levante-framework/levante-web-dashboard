/**
 * Proxy: fetches a Crowdin ZIP from the given URL and streams it to the client.
 * Used when the client cannot fetch the ZIP directly (e.g. CORS). Kept minimal to avoid timeout.
 */

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const zipUrl = body.zipUrl;
        if (!zipUrl || typeof zipUrl !== 'string') {
            res.status(400).json({ error: 'Missing zipUrl in body' });
            return;
        }
        const zipRes = await fetch(zipUrl);
        if (!zipRes.ok) {
            res.status(zipRes.status).json({ error: `ZIP fetch failed: ${zipRes.status}` });
            return;
        }
        const zipBuffer = await zipRes.arrayBuffer();
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="crowdin-export.zip"');
        res.status(200).send(Buffer.from(zipBuffer));
    } catch (err) {
        console.error('Crowdin download zip proxy error:', err);
        res.status(500).json({ error: 'Proxy failed', details: err.message || String(err) });
    }
};
