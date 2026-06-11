/**
 * API: returns the identifiers of Crowdin source strings marked as hidden (isHidden=true).
 * The dashboard uses this to exclude hidden strings after parsing the approved export,
 * without ever exposing the Crowdin token to the browser.
 */

const CROWDIN_API_BASE = 'https://api.crowdin.com/api/v2';
const CACHE_TTL_MS = 10 * 60 * 1000;

let _cache = { at: 0, ids: null, total: 0 };

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }
    try {
        const token = process.env.CROWDIN_API_TOKEN;
        if (!token) {
            res.status(500).json({ error: 'CROWDIN_API_TOKEN is not set in Vercel.' });
            return;
        }
        const projectId = process.env.LEVANTE_TRANSLATIONS_PROJECT_ID || '756721';

        const now = Date.now();
        const bustCache = req.url && (req.url.includes('refresh=1') || req.url.includes('nocache=1'));
        if (!bustCache && _cache.ids && (now - _cache.at) < CACHE_TTL_MS) {
            res.status(200).json({ hiddenIdentifiers: _cache.ids, count: _cache.ids.length, total: _cache.total, cached: true });
            return;
        }

        const headers = { Authorization: `Bearer ${token}` };
        const limit = 500;
        let offset = 0;
        let total = 0;
        const hidden = [];
        for (let page = 0; page < 100; page++) {
            const r = await fetch(`${CROWDIN_API_BASE}/projects/${projectId}/strings?limit=${limit}&offset=${offset}`, { headers });
            if (!r.ok) {
                const text = await r.text();
                throw new Error(`Crowdin strings list failed: ${r.status} ${text.slice(0, 200)}`);
            }
            const body = await r.json();
            const data = Array.isArray(body.data) ? body.data : [];
            for (const item of data) {
                const s = (item && item.data) || {};
                total++;
                if (s.isHidden === true) {
                    const id = String(s.identifier || '').trim();
                    if (id) hidden.push(id);
                }
            }
            if (data.length < limit) break;
            offset += limit;
        }

        _cache = { at: now, ids: hidden, total };
        res.status(200).json({ hiddenIdentifiers: hidden, count: hidden.length, total });
    } catch (err) {
        console.error('crowdin-hidden-strings error:', err);
        res.status(500).json({ error: 'Failed to fetch hidden strings', details: err.message || String(err) });
    }
};
