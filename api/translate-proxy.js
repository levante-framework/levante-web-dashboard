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

    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const apiKey = req.headers['x-api-key'];
        
        if (!apiKey) {
            return res.status(400).json({ error: 'Missing Google Translate API key' });
        }

        const { original_english, source_text, source_lang, target_lang } = req.body;
        
        if (!original_english || !source_text || !source_lang || !target_lang) {
            return res.status(400).json({ 
                error: 'Missing required fields: original_english, source_text, source_lang, target_lang' 
            });
        }

        // Step 1: Translate source text back to English
        const translateUrl = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;
        
        const response = await fetch(translateUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                q: source_text,
                source: source_lang,
                target: 'en',
                format: 'text'
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            return res.status(response.status).json({ 
                error: 'Google Translate API error',
                details: errorData 
            });
        }

        const data = await response.json();
        const back_translated = data.data.translations[0].translatedText;

        // Calculate similarity score (simple word-based comparison)
        const similarity_score = calculateSimilarity(original_english, back_translated);

        const result = {
            original_english,
            source_text,
            back_translated,
            similarity_score,
            status: similarity_score >= 85 ? 'excellent' : 
                   similarity_score >= 70 ? 'good' : 'needs_review'
        };

        res.status(200).json(result);
        
    } catch (error) {
        console.error('Translate proxy error:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
}

function calculateSimilarity(text1, text2) {
    // Simple similarity calculation based on common words
    const words1 = text1.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const words2 = text2.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    if (words1.length === 0 && words2.length === 0) return 100;
    if (words1.length === 0 || words2.length === 0) return 0;
    
    const commonWords = words1.filter(word => words2.includes(word));
    const similarity = (commonWords.length * 2) / (words1.length + words2.length) * 100;
    
    return Math.round(similarity);
}