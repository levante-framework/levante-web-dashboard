export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-KEY');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        // Allow API key from header (for authenticated users) or environment variable (for public partner dashboard).
        // If client key is stale/invalid and returns 401, we retry with server env key.
        const clientApiKey = String(req.headers['x-api-key'] || '').trim();
        const serverApiKey = String(
            process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_LABS_API_KEY || ''
        ).trim();
        const preferredApiKey = clientApiKey || serverApiKey;

        if (!preferredApiKey) {
            return res.status(400).json({ error: 'Missing ElevenLabs API key' });
        }

        const requestWithKey = async (url, method, apiKey, body = null, accept = 'application/json') => {
            const headers = {
                'xi-api-key': apiKey,
                'Accept': accept,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            };
            if (body !== null) {
                headers['Content-Type'] = 'application/json';
            }
            return fetch(url, {
                method,
                headers,
                body: body !== null ? JSON.stringify(body) : undefined
            });
        };

        const shouldRetryWithServerKey = (status, text) => {
            if (status !== 400 && status !== 401) return false;
            return /invalid_api_key|invalid api key|missing elevenlabs api key|unauthorized/i.test(String(text || ''));
        };

        const fetchWithFallback = async (url, method, body = null, accept = 'application/json') => {
            let response = await requestWithKey(url, method, preferredApiKey, body, accept);
            const canRetryWithServerKey = (
                (response.status === 400 || response.status === 401) &&
                Boolean(serverApiKey) &&
                preferredApiKey !== serverApiKey
            );
            if (canRetryWithServerKey) {
                let retry = false;
                try {
                    const firstErrorText = await response.clone().text();
                    retry = shouldRetryWithServerKey(response.status, firstErrorText);
                } catch (_) {
                    retry = response.status === 401;
                }
                if (retry) {
                    console.warn('elevenlabs-proxy: client key rejected, retrying with server key');
                    response = await requestWithKey(url, method, serverApiKey, body, accept);
                }
            }
            return response;
        };

        const formatElevenLabsError = (status, rawText) => {
            const text = String(rawText || '').trim();
            let parsed = null;
            try {
                parsed = JSON.parse(text);
            } catch (_error) {
                parsed = null;
            }
            const detail = parsed?.detail || null;
            const detailStatus = String(detail?.status || '').trim();
            const detailMessage = String(detail?.message || parsed?.message || '').trim();
            const pretty = detailMessage || text || `ElevenLabs API error: ${status}`;
            return {
                error: detailStatus ? `ElevenLabs ${detailStatus}: ${pretty}` : `ElevenLabs API error: ${status}`,
                details: text || null,
                elevenlabs_status: detailStatus || null
            };
        };

        if (req.method === 'GET') {
            // Handle voices list endpoint
            const response = await fetchWithFallback(
                'https://api.elevenlabs.io/v1/voices',
                'GET',
                null,
                'application/json'
            );

            if (!response.ok) {
                const errorText = await response.text();
                return res.status(response.status).json(formatElevenLabsError(response.status, errorText));
            }

            const data = await response.json();
            res.status(200).json(data);
            
        } else if (req.method === 'POST') {
            // Handle TTS endpoint - extract voice_id from URL path
            const { query } = req;
            const voice_id = query.voice_id;
            
            if (!voice_id) {
                return res.status(400).json({ error: 'Missing voice_id in path' });
            }

            const response = await fetchWithFallback(
                `https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`,
                'POST',
                req.body,
                'audio/mpeg'
            );

            if (!response.ok) {
                const errorText = await response.text();
                return res.status(response.status).json(formatElevenLabsError(response.status, errorText));
            }

            // Get the audio data as array buffer
            const audioBuffer = await response.arrayBuffer();
            
            // Set appropriate headers for audio response
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Length', audioBuffer.byteLength);
            
            // Send the audio data
            res.status(200).send(Buffer.from(audioBuffer));
            
        } else {
            res.status(405).json({ error: 'Method not allowed' });
        }
        
    } catch (error) {
        console.error('ElevenLabs proxy error:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
}