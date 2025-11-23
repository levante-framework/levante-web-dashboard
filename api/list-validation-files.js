import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	if (req.method === 'OPTIONS') return res.status(200).end();
	if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

	try {
		const dataDir = path.resolve(__dirname, '..', 'data');
		let files = [];
		try {
			files = fs.readdirSync(dataDir, { withFileTypes: true })
				.filter(d => d.isFile() && d.name.toLowerCase().endsWith('.json'))
				.map(d => d.name)
				.sort();
		} catch (e) {
			return res.status(200).json({ success: true, files: [], message: 'No data directory or no files found.' });
		}

		return res.status(200).json({ success: true, files });
	} catch (error) {
		console.error('list-validation-files error:', error);
		return res.status(500).json({ success: false, error: 'Internal error', message: error.message });
	}
}
