import { Storage } from '@google-cloud/storage';
import NodeID3 from 'node-id3';

const DEFAULT_AUDIO_COPYRIGHT = 'This file was created for the LEVANTE project and is released under a Creative Commons BY-NC-SA 4.0 license';

let storageClient = null;
function getStorage() {
	if (storageClient) return storageClient;
	try {
		const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GCP_SERVICE_ACCOUNT_JSON;
		if (!json) throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_JSON');
		const credentials = JSON.parse(json);
		storageClient = new Storage({ credentials, projectId: credentials.project_id });
		return storageClient;
	} catch (e) {
		console.warn('GCS init failed', e);
		return null;
	}
}

// Audio assets use regional locale folders (en-US, de-DE, nl-NL, ...).
// Normalize legacy generic codes so dashboard writes always land in the
// canonical folder and the stored lang_code tag matches the path.
function toRegionalAudioLangCode(code) {
	const c = String(code || '').trim();
	const map = { 'en': 'en-US', 'en-us': 'en-US', 'de': 'de-DE', 'de-de': 'de-DE', 'nl': 'nl-NL', 'nl-nl': 'nl-NL' };
	return map[c.toLowerCase()] || c;
}

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	if (req.method === 'OPTIONS') return res.status(200).end();
	if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

	try {
		const { audioBase64, langCode, itemId, bucket, tags, versioning } = req.body || {};
		if (!audioBase64 || typeof audioBase64 !== 'string') {
			return res.status(400).json({ success: false, error: 'bad_request', message: 'audioBase64 missing or invalid' });
		}
		if (!langCode || !itemId) {
			return res.status(400).json({ success: false, error: 'bad_request', message: 'langCode and itemId are required' });
		}
		const audioLangCode = toRegionalAudioLangCode(langCode);

		const b64 = audioBase64.replace(/^data:audio\/\w+;base64,/, '');
		let audioBuffer;
		try { audioBuffer = Buffer.from(b64, 'base64'); }
		catch(e) { return res.status(400).json({ success:false, error:'bad_audio', message:'Could not decode audio base64' }); }

		const userDefinedText = [];
		const pushCustomTag = (description, value) => {
			if (value === undefined || value === null) return;
			const trimmed = `${value}`.trim();
			if (!trimmed) return;
			userDefinedText.push({ description, value: trimmed });
		};

		const storage = getStorage();
		if (!storage) {
			return res.status(500).json({ success: false, error: 'gcs_unavailable', message: 'Could not initialize GCS. Check GOOGLE_APPLICATION_CREDENTIALS_JSON.' });
		}

		// Audio writes go to draft assets bucket under audio/<lang>/<item>.mp3
		const bucketName = bucket || process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';
		let objectPath = `audio/${audioLangCode}/${itemId}.mp3`;
		let version = null;
		const enableVersioning = versioning === true || versioning === 'true';

		try {
			const gcsBucket = storage.bucket(bucketName);
			if (enableVersioning) {
				const prefix = `audio/${audioLangCode}/${itemId}`;
				const [existingFiles] = await gcsBucket.getFiles({ prefix });
				let maxVersion = 0;
				existingFiles.forEach(file => {
					const match = file.name.match(/_v(\d{3})\.mp3$/);
					if (match) {
						const parsed = parseInt(match[1], 10);
						if (!Number.isNaN(parsed)) {
							maxVersion = Math.max(maxVersion, parsed);
						}
					} else if (file.name === `${prefix}.mp3`) {
						maxVersion = Math.max(maxVersion, 0);
					}
				});
				version = maxVersion + 1;
				objectPath = `${prefix}_v${String(version).padStart(3, '0')}.mp3`;
			}
		} catch (e) {
			return res.status(500).json({ success:false, error:'version_scan_failed', message:e.message, bucket: bucketName, path: objectPath });
		}

		const serviceValue = tags?.service || 'ElevenLabs';
		const commentValue = tags?.comment || `Generated audio for ${itemId}`;
		const versionTag = version !== null ? `v${String(version).padStart(3, '0')}` : '';

		pushCustomTag('service', serviceValue);
		pushCustomTag('voice', tags?.voice);
		const resolvedVoiceId = tags?.voice_id || tags?.voiceId;
		pushCustomTag('voice_id', resolvedVoiceId);
		pushCustomTag('voiceId', resolvedVoiceId);
		pushCustomTag('model_id', tags?.model_id);
		pushCustomTag('lang_code', toRegionalAudioLangCode(tags?.lang_code || langCode));
		pushCustomTag('text', tags?.text);
		pushCustomTag('original_translation_text', tags?.original_translation_text);
		pushCustomTag('audio_enhanced_text', tags?.audio_enhanced_text);
		pushCustomTag('used_audio_enhanced_text', tags?.used_audio_enhanced_text);
		pushCustomTag('created', tags?.created || new Date().toISOString());
		pushCustomTag('source', tags?.source);
		pushCustomTag('version', versionTag);

		const id3 = {
			title: tags?.title || itemId,
			artist: tags?.artist || 'Levante Project',
			album: tags?.album || audioLangCode,
			genre: tags?.genre || 'Speech Synthesis'
		};
		if (commentValue) {
			id3.comment = { language: 'eng', text: commentValue };
		}
		id3.copyright = String(tags?.copyright || DEFAULT_AUDIO_COPYRIGHT).trim() || DEFAULT_AUDIO_COPYRIGHT;
		if (userDefinedText.length) {
			id3.userDefinedText = userDefinedText;
		}

		try { audioBuffer = NodeID3.write(id3, audioBuffer); }
		catch (e) { console.warn('ID3 write failed', e.message); }

		try {
			const gcsBucket = storage.bucket(bucketName);
			const file = gcsBucket.file(objectPath);
			await file.save(audioBuffer, { contentType: 'audio/mpeg', resumable: false, public: false });
			return res.status(200).json({ success: true, bucket: bucketName, path: objectPath, version });
		} catch (e) {
			return res.status(500).json({ success:false, error:'upload_failed', message:e.message, bucket: bucketName, path: objectPath || `audio/${audioLangCode}/${itemId}.mp3` });
		}
	} catch (error) {
		return res.status(500).json({ success: false, error: 'internal_error', message: error.message });
	}
}
