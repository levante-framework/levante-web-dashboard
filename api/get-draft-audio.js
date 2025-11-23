import { Storage } from '@google-cloud/storage';

let storageClient = null;
function getStorage() {
    if (storageClient) return storageClient;
    try {
        const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GCP_SERVICE_ACCOUNT_JSON;
        if (!json) throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_JSON');
        const credentials = JSON.parse(json);
        storageClient = new Storage({ credentials, projectId: credentials.project_id });
        return storageClient;
    } catch (error) {
        console.warn('GCS init failed', error);
        return null;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'method_not_allowed' });

    const storage = getStorage();
    if (!storage) {
        return res.status(500).json({ success: false, error: 'gcs_unavailable', message: 'Could not initialize Google Cloud Storage client.' });
    }

    const bucketName = (req.query.bucket && String(req.query.bucket)) || process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';
    const path = req.query.path && String(req.query.path);

    if (!path) {
        return res.status(400).json({ success: false, error: 'bad_request', message: 'path parameter is required' });
    }

    try {
        const bucket = storage.bucket(bucketName);
        const file = bucket.file(path);
        const [exists] = await file.exists();
        if (!exists) {
            return res.status(404).json({ success: false, error: 'not_found', message: `File not found: ${path}` });
        }

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');

        file.createReadStream()
            .on('error', (err) => {
                console.error('Error streaming draft audio', err);
                if (!res.headersSent) {
                    res.status(500).json({ success: false, error: 'stream_error', message: err.message });
                }
            })
            .pipe(res);
    } catch (error) {
        console.error('Error fetching draft audio', error);
        return res.status(500).json({ success: false, error: 'internal_error', message: error.message });
    }
}
