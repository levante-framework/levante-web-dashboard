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
        // Allow API key from header (for authenticated users) or environment variable (for public partner dashboard)
        const apiKey = req.headers['x-api-key'] || process.env.ELEVENLABS_API_KEY;
        
        if (!apiKey) {
            return res.status(400).json({ error: 'Missing ElevenLabs API key' });
        }

        if (req.method === 'GET') {
            // Handle voices list endpoint
            const response = await fetch('https://api.elevenlabs.io/v1/voices', {
                method: 'GET',
                headers: {
                    'xi-api-key': apiKey,
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                return res.status(response.status).json({ 
                    error: `ElevenLabs API error: ${response.status}`,
                    details: errorText 
                });
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

            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`, {
                method: 'POST',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                },
                body: JSON.stringify(req.body)
            });

            if (!response.ok) {
                const errorText = await response.text();
                return res.status(response.status).json({ 
                    error: `ElevenLabs API error: ${response.status}`,
                    details: errorText 
                });
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