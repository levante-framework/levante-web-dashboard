/**
 * API endpoint to fetch untranslated items from Crowdin
 * Returns untranslated items with source file, item_id, and source text
 */

export default async function handler(req, res) {
    // Enable CORS
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
        const { lang, env = 'dev' } = req.query;
        
        if (!lang) {
            res.status(400).json({ error: 'Language parameter is required' });
            return;
        }
        
        // Crowdin API configuration
        const CROWDIN_API_BASE = 'https://api.crowdin.com/api/v2';
        const CROWDIN_PROJECT_ID = process.env.LEVANTE_TRANSLATIONS_PROJECT_ID || '756721';
        const CROWDIN_TOKEN = process.env.CROWDIN_API_TOKEN;
        
        if (!CROWDIN_TOKEN) {
            res.status(500).json({ 
                error: 'Crowdin API token not configured',
                details: 'CROWDIN_API_TOKEN environment variable is required'
            });
            return;
        }

        // Get project information first
        const projectResponse = await fetch(`${CROWDIN_API_BASE}/projects/${CROWDIN_PROJECT_ID}`, {
            headers: {
                'Authorization': `Bearer ${CROWDIN_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!projectResponse.ok) {
            const errorText = await projectResponse.text();
            throw new Error(`Crowdin API error: ${projectResponse.status} ${projectResponse.statusText} - ${errorText}`);
        }

        const projectData = await projectResponse.json();
        
        // Get translation progress for the specific language
        const progressResponse = await fetch(`${CROWDIN_API_BASE}/projects/${CROWDIN_PROJECT_ID}/languages/progress`, {
            headers: {
                'Authorization': `Bearer ${CROWDIN_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!progressResponse.ok) {
            const errorText = await progressResponse.text();
            throw new Error(`Crowdin progress API error: ${progressResponse.status} ${progressResponse.statusText} - ${errorText}`);
        }

        const progressData = await progressResponse.json();
        
        // Find the language progress
        const languageProgress = progressData.data.find(p => p.data.languageId === lang);
        
        if (!languageProgress) {
            res.status(404).json({ 
                error: 'Language not found',
                details: `No progress data found for language: ${lang}`
            });
            return;
        }
        
        // First, get the file ID for item-bank-translations.xlsx
        const filesResponse = await fetch(`${CROWDIN_API_BASE}/projects/${CROWDIN_PROJECT_ID}/files`, {
            headers: {
                'Authorization': `Bearer ${CROWDIN_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        
        let itemBankFileId = null;
        let filesData = null;
        if (filesResponse.ok) {
            filesData = await filesResponse.json();
            if (filesData.data && Array.isArray(filesData.data)) {
                const itemBankFile = filesData.data.find(f => 
                    f.data.name && f.data.name.toLowerCase().includes('item-bank-translations')
                );
                if (itemBankFile) {
                    itemBankFileId = itemBankFile.data.id;
                }
            }
        }
        
        // Use CroQL to get strings by category for this language
        // Filter by item-bank file and exclude duplicates
        // Untranslated: no translations for the language
        const untranslatedCroql = itemBankFileId != null
            ? `id of file = ${itemBankFileId} and count of translations where ( language = @language:"${lang}" ) = 0 and not is duplicate`
            : `count of translations where ( language = @language:"${lang}" ) = 0 and not is duplicate`;
        // Unapproved: has translations for the language, but none of those translations are approved
        const unapprovedCroql = itemBankFileId != null
            ? `id of file = ${itemBankFileId} and count of translations where ( language = @language:"${lang}" ) > 0 and count of translations where ( language = @language:"${lang}" and ( count of approvals > 0 ) ) = 0 and not is duplicate`
            : `count of translations where ( language = @language:"${lang}" ) > 0 and count of translations where ( language = @language:"${lang}" and ( count of approvals > 0 ) ) = 0 and not is duplicate`;
        
        const [untranslatedRes, unapprovedRes] = await Promise.all([
            fetch(`${CROWDIN_API_BASE}/projects/${CROWDIN_PROJECT_ID}/strings?croql=${encodeURIComponent(untranslatedCroql)}`, {
                headers: { 'Authorization': `Bearer ${CROWDIN_TOKEN}`, 'Content-Type': 'application/json' }
            }),
            fetch(`${CROWDIN_API_BASE}/projects/${CROWDIN_PROJECT_ID}/strings?croql=${encodeURIComponent(unapprovedCroql)}`, {
                headers: { 'Authorization': `Bearer ${CROWDIN_TOKEN}`, 'Content-Type': 'application/json' }
            })
        ]);

        if (!untranslatedRes.ok) {
            const errorText = await untranslatedRes.text();
            throw new Error(`Crowdin strings API error (untranslated): ${untranslatedRes.status} ${untranslatedRes.statusText} - ${errorText}`);
        }
        if (!unapprovedRes.ok) {
            const errorText = await unapprovedRes.text();
            throw new Error(`Crowdin strings API error (unapproved): ${unapprovedRes.status} ${unapprovedRes.statusText} - ${errorText}`);
        }

        const untranslatedData = await untranslatedRes.json();
        const unapprovedData = await unapprovedRes.json();
        
        // Build file name map from the files we already fetched
        let filesMap = {};
        if (filesData && filesData.data && Array.isArray(filesData.data)) {
            for (const file of filesData.data) {
                filesMap[file.data.id] = file.data.name || 'Unknown file';
            }
        }
        
        // Get translation details for each string to classify status
        const items = [];
        let untranslatedCount = 0; // no translation at all
        let unapprovedCount = 0;   // has translation but none approved
        
        // Add untranslated items
        if (untranslatedData.data && Array.isArray(untranslatedData.data)) {
            for (const stringItem of untranslatedData.data) {
                untranslatedCount++;
                if (items.length < 20) {
                    const fileId = stringItem.data.fileId;
                    const fileName = filesMap[fileId] || 'Unknown file';
                    const sourceText = stringItem.data.text || stringItem.data.sourceText || 'No text available';
                    items.push({ item_id: stringItem.data.identifier || stringItem.data.id, source_file: fileName, source_text: sourceText, status: 'untranslated' });
                }
            }
        }
        
        // Add unapproved items
        if (unapprovedData.data && Array.isArray(unapprovedData.data)) {
            for (const stringItem of unapprovedData.data) {
                unapprovedCount++;
                if (items.length < 20) {
                    const fileId = stringItem.data.fileId;
                    const fileName = filesMap[fileId] || 'Unknown file';
                    const sourceText = stringItem.data.text || stringItem.data.sourceText || 'No text available';
                    items.push({ item_id: stringItem.data.identifier || stringItem.data.id, source_file: fileName, source_text: sourceText, status: 'unapproved' });
                }
            }
        }
        
        // Add summary if more than we displayed
        const more = untranslatedCount + unapprovedCount - items.length;
        if (more > 0) {
            items.push({ item_id: `... and ${more} more`, source_file: 'Multiple files', source_text: `Additional items not shown`, status: 'summary' });
        }
        
        res.status(200).json({
            language: lang,
            environment: env,
            totals: {
                untranslated: untranslatedCount,
                unapproved: unapprovedCount,
                missing: untranslatedCount + unapprovedCount
            },
            items,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Crowdin untranslated API error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch untranslated items',
            details: error.message
        });
    }
}
