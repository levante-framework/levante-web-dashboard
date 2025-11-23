export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const { text, from, to } = req.query;
        const authHeader = req.headers.authorization;

        console.log('🔍 Google Translate API request:', {
            textLength: text ? text.length : 0,
            from: from,
            to: to,
            hasAuthHeader: !!authHeader,
            authHeaderStart: authHeader ? authHeader.substring(0, 10) + '...' : 'none'
        });

        if (!text || !from || !to) {
            res.status(400).json({ error: 'Missing required parameters: text, from, to' });
            return;
        }

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing or invalid Authorization header' });
            return;
        }

        const apiKey = authHeader.replace('Bearer ', '');

        // Call Google Translate API
        const translateUrl = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;
        
        // Use form-encoded data instead of JSON (Google Translate API preference)
        const formData = new URLSearchParams();
        formData.append('q', text);
        formData.append('source', from);
        formData.append('target', to);
        formData.append('format', 'text');

        console.log('🌐 Making Google Translate request:', {
            url: translateUrl.replace(apiKey, 'API_KEY_HIDDEN'),
            formData: Object.fromEntries(formData)
        });
        
        const response = await fetch(translateUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Google Translate API error:', {
                status: response.status,
                statusText: response.statusText,
                errorText: errorText,
                requestUrl: translateUrl,
                requestBody: {
                    q: text,
                    source: from,
                    target: to,
                    format: 'text'
                }
            });
            res.status(response.status).json({ 
                error: `Google Translate API error: ${response.status}`,
                details: errorText,
                requestInfo: {
                    from: from,
                    to: to,
                    textLength: text.length
                }
            });
            return;
        }

        const data = await response.json();
        
        if (!data.data || !data.data.translations || data.data.translations.length === 0) {
            res.status(500).json({ error: 'Invalid response from Google Translate API' });
            return;
        }

        const translatedText = data.data.translations[0].translatedText;

        res.status(200).json({
            translatedText: translatedText,
            originalText: text,
            fromLanguage: from,
            toLanguage: to
        });

    } catch (error) {
        console.error('Translation endpoint error:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            details: error.message
        });
    }
}
