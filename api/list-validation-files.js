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
		console.warn('list-validation-files: failed to init storage client', e.message);
		storageClient = null;
	}
	return storageClient;
}

function getPrefix() {
	return VALIDATION_PREFIX.endsWith('/') ? VALIDATION_PREFIX : `${VALIDATION_PREFIX}/`;
}

async function listFromGcs() {
	const storage = getStorage();
	if (!storage) return null;
	try {
		const bucket = storage.bucket(DATA_BUCKET);
		const [files] = await bucket.getFiles({ prefix: getPrefix(), autoPaginate: true });
		const names = files
			.map(f => f.name || '')
			.filter(n => n.toLowerCase().endsWith('.json'))
			.map(n => n.split('/').pop())
			.filter(Boolean)
			.sort();
		return names;
	} catch (e) {
		console.warn('list-validation-files: GCS list failed', e.message);
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
		// Prefer GCS-backed storage in production so the deployed dashboard can see files.
		const gcsFiles = await listFromGcs();
		if (Array.isArray(gcsFiles) && gcsFiles.length) {
			return res.status(200).json({
				success: true,
				files: gcsFiles,
				source: 'gcs',
				bucket: DATA_BUCKET,
				prefix: getPrefix()
			});
		}

		const dataDir = path.resolve(__dirname, '..', 'data', 'validation');
		let files = [];
		try {
			files = fs.readdirSync(dataDir, { withFileTypes: true })
				.filter(d => d.isFile() && d.name.toLowerCase().endsWith('.json'))
				.map(d => d.name)
				.sort();
		} catch (e) {
			return res.status(200).json({ success: true, files: [], message: 'No validation data directory or no files found.' });
		}

		return res.status(200).json({ success: true, files, source: 'local' });
	} catch (error) {
		console.error('list-validation-files error:', error);
		return res.status(500).json({ success: false, error: 'Internal error', message: error.message });
	}
}
