import fs from 'fs';
import path from 'path';

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
		const dataDir = path.resolve(__dirname, '..', 'data');
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
