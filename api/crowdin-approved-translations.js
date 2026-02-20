/**
 * API endpoint to fetch source and translated strings from Crowdin (approved translations only).
 * Creates a project build with exportApprovedOnly, downloads the ZIP, parses CSVs and returns JSON
 * in the same shape the dashboard expects (array of { item_id, labels, en, [langCode]: ... }).
 */

import { Readable } from 'stream';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const unzipper = require('unzipper');

const CROWDIN_API_BASE = 'https://api.crowdin.com/api/v2';
const LANG_ID_TO_CODE = {
    en: 'en',
    'es-CO': 'es-CO',
    es: 'es-CO',
    de: 'de',
    'fr-CA': 'fr-CA',
    fr: 'fr-CA',
    nl: 'nl',
    'de-CH': 'de-CH',
    'es-AR': 'es-AR',
    'en-GH': 'en-GH'
};

function parseCSVSimple(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];
        if (c === '"') {
            if (inQuotes && next === '"') {
                field += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if ((c === ',' && !inQuotes) || ((c === '\n' || c === '\r') && !inQuotes)) {
            row.push(field.trim());
            field = '';
            if (c === '\n' || c === '\r') {
                if (row.some(cell => cell.length > 0)) rows.push(row);
                row = [];
                if (c === '\r' && next === '\n') i++;
            }
        } else {
            field += c;
        }
    }
    if (field.trim() || row.length > 0) {
        row.push(field.trim());
        if (row.some(cell => cell.length > 0)) rows.push(row);
    }
    return rows;
}

function rowsToObjects(rows) {
    if (rows.length < 2) return [];
    const headers = rows[0].map(h => (h || '').trim());
    const result = [];
    for (let i = 1; i < rows.length; i++) {
        const values = rows[i];
        const obj = {};
        headers.forEach((h, j) => {
            let v = values[j];
            if (v !== undefined && typeof v === 'string') {
                v = v.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
            }
            obj[h] = v ?? '';
        });
        result.push(obj);
    }
    return result;
}

function normalizeItem(item) {
    const itemId = item.identifier || item.item_id || item.id || item.ID || item.Item_ID || null;
    const task = item.task || item.labels || item.category || item.type || 'general';
    const en = (item.en || item.source || item.source_phrase || item.english || item['en-US'] || item['en_US'] || item.text || '').trim();
    return { ...item, item_id: itemId, labels: task, en: en || item.en || '' };
}

export default async function handler(req, res) {
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

    const CROWDIN_PROJECT_ID = process.env.LEVANTE_TRANSLATIONS_PROJECT_ID || '756721';
    const CROWDIN_TOKEN = process.env.CROWDIN_API_TOKEN;
    if (!CROWDIN_TOKEN) {
        res.status(500).json({ error: 'Crowdin API token not configured', details: 'CROWDIN_API_TOKEN is required' });
        return;
    }

    const authHeader = { Authorization: `Bearer ${CROWDIN_TOKEN}`, 'Content-Type': 'application/json' };

    try {
        // 1. Create build (approved only)
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

        await pollAndDownload(buildId, res, authHeader, CROWDIN_PROJECT_ID);
    } catch (error) {
        console.error('Crowdin approved translations API error:', error);
        res.status(500).json({
            error: 'Failed to fetch Crowdin approved translations',
            details: error.message
        });
    }
}

async function pollAndDownload(buildId, res, authHeader, projectId) {
    const maxAttempts = 45;
    const pollMs = 2000;
    let buildStatus = 'building';
    let buildData = null;
    for (let i = 0; i < maxAttempts; i++) {
        const statusRes = await fetch(`${CROWDIN_API_BASE}/projects/${projectId}/translations/builds/${buildId}`, {
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
        throw new Error('Build did not finish in time');
    }

    const downloadRes = await fetch(`${CROWDIN_API_BASE}/projects/${projectId}/translations/builds/${buildId}/download`, {
        headers: authHeader
    });
    if (!downloadRes.ok) throw new Error(`Download link failed: ${downloadRes.status}`);
    const downloadBody = await downloadRes.json();
    const zipUrl = downloadBody.data?.url;
    if (!zipUrl) throw new Error('No download URL');

    const zipResponse = await fetch(zipUrl);
    if (!zipResponse.ok) throw new Error(`ZIP fetch failed: ${zipResponse.status}`);
    const zipBuffer = Buffer.from(await zipResponse.arrayBuffer());

    const merged = await parseZipAndMerge(zipBuffer);
    res.status(200).json({
        data: merged,
        source: 'Crowdin (approved only)',
        timestamp: new Date().toISOString()
    });
}

async function parseZipAndMerge(zipBuffer) {
    const stream = Readable.from(zipBuffer);
    const entries = [];
    await new Promise((resolve, reject) => {
        stream
            .pipe(unzipper.Parse())
            .on('entry', (entry) => {
                const path = entry.path;
                const chunks = [];
                entry.on('data', (c) => chunks.push(c));
                entry.on('end', () => {
                    entries.push({ path, buffer: Buffer.concat(chunks) });
                });
                entry.autodrain();
            })
            .on('close', resolve)
            .on('error', reject);
    });

    // Find CSV files (and language from path, e.g. "item-bank-translations/de/item-bank-translations.csv" -> de)
    const byLang = {};
    for (const { path, buffer } of entries) {
        if (!path.endsWith('.csv') && !path.toLowerCase().endsWith('.csv')) continue;
        const text = buffer.toString('utf-8');
        const rows = parseCSVSimple(text);
        if (rows.length < 2) continue;
        const parts = path.replace(/\\/g, '/').split('/');
        let lang = 'en';
        for (let i = 0; i < parts.length - 1; i++) {
            const p = parts[i];
            if (LANG_ID_TO_CODE[p] || p === 'en') {
                lang = LANG_ID_TO_CODE[p] || p;
                break;
            }
        }
        const objects = rowsToObjects(rows);
        byLang[lang] = { headers: rows[0], objects };
    }

    // Merge: use source language as base (prefer 'en'), then add translation columns from others
    const baseLang = byLang.en ? 'en' : Object.keys(byLang)[0];
    if (!baseLang || !byLang[baseLang]) return [];
    const base = byLang[baseLang].objects;
    const headers = byLang[baseLang].headers || [];
    const idKey = headers.find(h => /identifier|item_id|id|ID/i.test(h)) || headers[0] || 'identifier';
    const merged = base.map((row, idx) => {
        const id = row[idKey] || row.item_id || row.identifier || String(idx);
        const out = { ...row, item_id: row[idKey] || row.item_id || row.identifier, labels: row.task || row.labels || 'general', en: row.en || row.source || row.english || row.text || '' };
        Object.keys(byLang).forEach(lang => {
            if (lang === baseLang) return;
            const arr = byLang[lang].objects;
            const other = arr.find(r => (r[idKey] || r.item_id || r.identifier || '') === id);
            if (other) {
                const otherHeaders = byLang[lang].headers || Object.keys(other);
                const textKey = otherHeaders.find(h => h && h !== idKey && (h === lang || h.replace(/_/g, '-') === lang || h.toLowerCase() === lang.toLowerCase()));
                if (textKey) out[lang] = other[textKey] ?? '';
                else out[lang] = other.en || other.source || other.english || other.text || '';
            }
        });
        return normalizeItem(out);
    });
    return merged;
}
