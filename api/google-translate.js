import { GoogleAuth } from 'google-auth-library';

async function getServiceAccountClient() {
    const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '';
    if (!raw || !raw.trim()) return null;
    try {
        const credentials = JSON.parse(raw);
        const auth = new GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });
        return auth.getClient();
    } catch (e) {
        console.warn('⚠️ Invalid service account JSON for google-translate endpoint');
        return null;
    }
}

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

        const envKey = process.env.GOOGLE_TRANSLATE_APIKEY;
        const bearerKey = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.replace('Bearer ', '').trim() : '';
        const apiKey = (envKey && envKey.trim()) || bearerKey || null;
        const serviceClient = await getServiceAccountClient();

        console.log('🔍 Google Translate API request:', {
            textLength: text ? text.length : 0,
            from: from,
            to: to,
            keySource: envKey ? 'GOOGLE_TRANSLATE_APIKEY' : (bearerKey ? 'Authorization' : 'none'),
            authMode: serviceClient ? 'service_account' : (apiKey ? 'api_key' : 'none')
        });

        if (!text || !from || !to) {
            res.status(400).json({ error: 'Missing required parameters: text, from, to' });
            return;
        }

        if (!serviceClient && !apiKey) {
            res.status(401).json({
                error: 'Google Translate authentication required',
                details: 'Provide GCP_SERVICE_ACCOUNT_JSON (preferred) or GOOGLE_TRANSLATE_APIKEY.'
            });
            return;
        }

        // Use form-encoded data instead of JSON (Google Translate API preference)
        const formData = new URLSearchParams();
        formData.append('q', text);
        formData.append('source', from);
        formData.append('target', to);
        formData.append('format', 'text');

        const translateUrl = serviceClient
            ? 'https://translation.googleapis.com/language/translate/v2'
            : `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;

        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
        };
        if (serviceClient) {
            const tokenResponse = await serviceClient.getAccessToken();
            const accessToken = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
            if (!accessToken) {
                res.status(500).json({ error: 'Failed to obtain service account access token' });
                return;
            }
            headers.Authorization = `Bearer ${accessToken}`;
        }

        console.log('🌐 Making Google Translate request:', {
            url: serviceClient ? translateUrl : translateUrl.replace(apiKey, 'API_KEY_HIDDEN'),
            formData: Object.fromEntries(formData)
        });
        
        const response = await fetch(translateUrl, {
            method: 'POST',
            headers,
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
