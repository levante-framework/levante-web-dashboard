// task-assets.js
// API endpoint to fetch authoritative task asset info from GCS (audio IDs, visual counts, optional corpus checks)

import { Storage } from '@google-cloud/storage';

let storage = null;

async function initializeGCS() {
    if (storage) return storage;
    const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!serviceAccountJson) {
        throw new Error('Missing GCP_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS_JSON');
    }
    let credentials;
    try {
        credentials = JSON.parse(serviceAccountJson);
    } catch (e) {
        throw new Error('Invalid JSON in GCS credentials environment variable');
    }
    storage = new Storage({ credentials, projectId: credentials.project_id });
    return storage;
}

async function readJsonFromGcs(bucketName, filePath) {
    const client = await initializeGCS();
    const file = client.bucket(bucketName).file(filePath);
    const [contents] = await file.download();
    return JSON.parse(contents.toString('utf8'));
}

async function listFiles(bucketName, prefix) {
    const client = await initializeGCS();
    const [files] = await client.bucket(bucketName).getFiles({ prefix });
    return files.map(f => f.name);
}

async function readTextFromGcs(bucketName, filePath) {
    const client = await initializeGCS();
    const file = client.bucket(bucketName).file(filePath);
    const [contents] = await file.download();
    return contents.toString('utf8');
}

function parseCsv(csvText) {
    if (!csvText) return { keys: [], languages: [] };
    // simple CSV parser for header + rows (handles quotes)
    const lines = csvText.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return { keys: [], languages: [] };
    const parseLine = (line) => {
        const result = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
                else { inQuotes = !inQuotes; }
            } else if (ch === ',' && !inQuotes) {
                result.push(cur);
                cur = '';
            } else {
                cur += ch;
            }
        }
        result.push(cur);
        return result.map(s => s.trim());
    };

    const rawHeader = parseLine(lines[0]);
    const header = rawHeader.map(h => h.toLowerCase());
    let keyIdx = header.indexOf('key');
    if (keyIdx === -1) {
        // fallback: some variants may use 'item_id'
        keyIdx = header.indexOf('item_id');
    }
    if (keyIdx === -1) {
        // if unknown header, attempt second column heuristic
        keyIdx = 1;
    }

    const keys = new Set();
    for (let i = 1; i < lines.length; i++) {
        const cols = parseLine(lines[i]);
        if (cols.length <= keyIdx) continue;
        const k = (cols[keyIdx] || '').trim();
        if (k) keys.add(k);
    }
    // detect language columns (e.g., en, es-AR)
    const langPattern = /^[a-z]{2}(?:-[A-Z]{2})?$/;
    const languages = rawHeader.filter(h => langPattern.test(h));
    return { keys: Array.from(keys), languages };
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const task = (req.query.task || '').toString();
    const env = ((req.query.env || 'dev').toString() === 'prod') ? 'prod' : 'dev';
    const corpusFile = (req.query.corpus || '').toString();

    if (!task) {
        res.status(400).json({ error: 'Missing task parameter' });
        return;
    }

    try {
        const assetsBucket = `levante-assets-${env}`;
        const result = { task, env, audio: {}, visual: {}, corpus: {}, translations: {} };

        // Audio: assets-per-task.json
        try {
            const assetsPerTask = await readJsonFromGcs(assetsBucket, 'audio/assets-per-task.json');
            const entry = assetsPerTask && (assetsPerTask[task] || assetsPerTask[task.replace(/-/g, '')] || assetsPerTask[task.replace(/-/g, '_')]);
            const ids = Array.isArray(entry?.audio) ? entry.audio : [];
            result.audio = { requiredIds: ids, count: ids.length };
        } catch (e) {
            result.audio = { requiredIds: [], count: 0, warning: 'Could not read assets-per-task.json' };
        }

        // Visual: count .webp files under visual/<task>/
        try {
            const prefix = `visual/${task}/`;
            const files = await listFiles(assetsBucket, prefix);
            const webpFiles = files.filter(name => name.toLowerCase().endsWith('.webp'));
            result.visual = { count: webpFiles.length, prefix, sample: webpFiles.slice(0, 5) };
        } catch (e) {
            result.visual = { count: 0, prefix: `visual/${task}/`, warning: 'Could not list visual files' };
        }

        // Corpus: optional existence check if provided
        if (corpusFile) {
            try {
                const client = await initializeGCS();
                const path = `corpus/${task}/${corpusFile}`;
                const [exists] = await client.bucket(assetsBucket).file(path).exists();
                result.corpus = { exists, path };
            } catch (e) {
                result.corpus = { exists: false, path: `corpus/${task}/${corpusFile}`, warning: 'Could not check corpus file' };
            }
        }

        // Translations: load all keys from item-bank CSV
        try {
            const csvPath = 'translations/item-bank-translations.csv';
            const csvText = await readTextFromGcs(assetsBucket, csvPath);
            const parsed = parseCsv(csvText);
            result.translations = { count: parsed.keys.length, keys: parsed.keys, languages: parsed.languages }; 
        } catch (e) {
            result.translations = { count: 0, keys: [], warning: 'Could not read item-bank-translations.csv' };
        }

        res.status(200).json(result);
    } catch (error) {
        console.error('task-assets error:', error);
        res.status(500).json({ error: 'Failed to fetch task assets', details: error.message });
    }
}


