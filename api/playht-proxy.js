export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-USER-ID');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { body, headers } = req;
        
        // Extract PlayHT credentials from headers
        const authorization = headers.authorization;
        const userId = headers['x-user-id'];
        
        if (!authorization || !userId) {
            return res.status(400).json({ error: 'Missing PlayHT credentials' });
        }

        // Make the request to PlayHT API
        const response = await fetch('https://api.play.ht/api/v2/tts/stream', {
            method: 'POST',
            headers: {
                'AUTHORIZATION': authorization,
                'X-USER-ID': userId,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorText = await response.text();
            return res.status(response.status).json({ 
                error: `PlayHT API error: ${response.status}`,
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
        
    } catch (error) {
        console.error('PlayHT proxy error:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
} 