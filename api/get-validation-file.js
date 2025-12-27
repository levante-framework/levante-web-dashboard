import fs from 'fs';
import path from 'path';
import { Storage } from '@google-cloud/storage';

const DATA_BUCKET = process.env.DASHBOARD_DATA_BUCKET || 'levante-dashboard-dev';
const VALIDATION_PREFIX = process.env.AUDIO_VALIDATION_FILES_PREFIX || 'pitwall/audio-validation-results';

let storageClient = null;
function getStorage() {
	if (storageClient) return storageClient;
	try {
		const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
		if (raw) {
			const creds = JSON.parse(raw);
			storageClient = new Storage({ credentials: creds, projectId: creds.project_id });
		} else {
			storageClient = new Storage();
		}
	} catch (e) {
		console.warn('get-validation-file: failed to init storage client', e.message);
		storageClient = null;
	}
	return storageClient;
}

function getPrefix() {
	return VALIDATION_PREFIX.endsWith('/') ? VALIDATION_PREFIX : `${VALIDATION_PREFIX}/`;
}

async function loadFromGcs(fileName) {
	const storage = getStorage();
	if (!storage) return null;
	try {
		const bucket = storage.bucket(DATA_BUCKET);
		const objectName = `${getPrefix()}${fileName}`;
		const file = bucket.file(objectName);
		const [exists] = await file.exists();
		if (!exists) return null;
		const [contents] = await file.download();
		return contents;
	} catch (e) {
		console.warn('get-validation-file: GCS download failed', e.message);
		return null;
	}
}

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	if (req.method === 'OPTIONS') return res.status(200).end();
	if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

	try {
		const name = (req.query.name || '').toString();
		if (!name || !name.endsWith('.json') || name.includes('..') || name.includes('/')) {
			return res.status(400).json({ success: false, error: 'invalid_name' });
		}

		// Prefer GCS-backed storage in production.
		const gcsBuf = await loadFromGcs(name);
		if (gcsBuf) {
			res.setHeader('Content-Type', 'application/json');
			return res.status(200).send(gcsBuf);
		}

		const dataDir = path.resolve(__dirname, '..', 'data', 'validation');
		const filePath = path.join(dataDir, name);
		if (!fs.existsSync(filePath)) {
			return res.status(404).json({ success: false, error: 'not_found' });
		}
		const buf = fs.readFileSync(filePath);
		res.setHeader('Content-Type', 'application/json');
		return res.status(200).send(buf);
	} catch (error) {
		console.error('get-validation-file error:', error);
		return res.status(500).json({ success: false, error: 'Internal error', message: error.message });
	}
}
