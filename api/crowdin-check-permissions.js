/**
 * API endpoint to check if a user has editor permissions for a language in Crowdin
 * Checks if user is superadmin OR has editor access to the selected language (via username lookup)
 */

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const { email, identifier, langCode, projectId = process.env.LEVANTE_TRANSLATIONS_PROJECT_ID || '756721' } = req.body;
        const loginIdentifier = (identifier || email || '').trim();
        
        if (!loginIdentifier) {
            res.status(400).json({ error: 'Crowdin username or email is required' });
            return;
        }

        if (!langCode) {
            res.status(400).json({ error: 'Language code is required' });
            return;
        }

        // Crowdin API configuration
        const CROWDIN_API_BASE = 'https://api.crowdin.com/api/v2';
        const CROWDIN_PROJECT_ID = projectId;
        const CROWDIN_TOKEN = process.env.CROWDIN_API_TOKEN;
        
        if (!CROWDIN_TOKEN) {
            res.status(500).json({ 
                error: 'Crowdin API token not configured',
                details: 'CROWDIN_API_TOKEN environment variable is required'
            });
            return;
        }

        // Map language codes to Crowdin language IDs
        const langCodeToCrowdinId = {
            'pt-PT': 'pt',
            'pt': 'pt',
            'es-CO': 'es-CO',
            'es-AR': 'es-AR',
            'de': 'de',
            'de-CH': 'de-CH',
            'fr-CA': 'fr-CA',
            'nl': 'nl',
            'en': 'en'
        };

        const crowdinLangId = langCodeToCrowdinId[langCode] || langCode;

        const searchParam = encodeURIComponent(loginIdentifier);
        const membersResponse = await fetch(
            `${CROWDIN_API_BASE}/projects/${CROWDIN_PROJECT_ID}/members?limit=50&search=${searchParam}`,
            {
                headers: {
                    'Authorization': `Bearer ${CROWDIN_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!membersResponse.ok) {
            const errorText = await membersResponse.text();
            console.error(`Crowdin API members error: ${membersResponse.status}`, errorText);
            if (membersResponse.status === 500) {
                throw new Error(`Crowdin API error (500): This usually means the API token is invalid, expired, or doesn't have the required permissions. Check CROWDIN_API_TOKEN in Vercel environment variables.`);
            }
            throw new Error(`Crowdin API error: ${membersResponse.status} ${membersResponse.statusText} - ${errorText}`);
        }

        const membersData = await membersResponse.json();
        const memberEntries = (membersData.data || []).map(entry => entry.data || entry);

        if (memberEntries.length === 0) {
            return res.status(200).json({
                hasAccess: false,
                reason: 'Crowdin user not found',
                message: 'No Crowdin member matched that username. Please enter the username shown in Crowdin (not email).',
                identifier: loginIdentifier,
                langCode
            });
        }

        const normalizedIdentifier = loginIdentifier.toLowerCase();
        const directMatch = memberEntries.find(member => {
            const username = (member.username || '').toLowerCase();
            const fullName = (member.fullName || '').toLowerCase();
            return username === normalizedIdentifier || (fullName && fullName === normalizedIdentifier);
        });

        const memberData = directMatch || (memberEntries.length === 1 ? memberEntries[0] : null);

        if (!memberData) {
            return res.status(200).json({
                hasAccess: false,
                reason: 'Crowdin username ambiguous',
                message: 'Multiple Crowdin users matched that search. Please enter the exact Crowdin username.',
                suggestions: memberEntries.map(m => m.username).filter(Boolean),
                identifier: loginIdentifier,
                langCode
            });
        }

        const roles = Array.isArray(memberData.roles) && memberData.roles.length > 0
            ? memberData.roles
            : (memberData.role ? [{ name: memberData.role }] : []);

        const roleNames = roles.map(role => (role.name || '').toLowerCase());
        const isOwner = roleNames.includes('owner');
        const isManager = roleNames.includes('manager');
        const isEditor = roleNames.includes('editor');
        const isTranslator = roleNames.includes('translator');
        let hasAllLanguagesAccess = isOwner || isManager;

        const languageAccessSet = new Set();

        if (!hasAllLanguagesAccess && Array.isArray(memberData.languagesAccess)) {
            memberData.languagesAccess.forEach(lang => {
                const langId = lang?.languageId || lang?.id || lang;
                if (langId) {
                    languageAccessSet.add(langId);
                }
            });
            hasAllLanguagesAccess = languageAccessSet.size === 0;
        }

        if (!hasAllLanguagesAccess && Array.isArray(roles)) {
            roles.forEach(role => {
                if (role?.permissions?.allLanguages) {
                    hasAllLanguagesAccess = true;
                }
                const languagesAccess = role?.permissions?.languagesAccess;
                if (languagesAccess && typeof languagesAccess === 'object') {
                    Object.keys(languagesAccess).forEach(langId => languageAccessSet.add(langId));
                }
            });
        }

        if (!hasAllLanguagesAccess && memberData.permissions && typeof memberData.permissions === 'object') {
            Object.entries(memberData.permissions).forEach(([langId, permission]) => {
                if (permission && permission !== 'denied') {
                    languageAccessSet.add(langId);
                }
            });
        }

        const languagesAccess = hasAllLanguagesAccess ? [] : Array.from(languageAccessSet);
        const accessToAllWorkflowSteps = Boolean(memberData.accessToAllWorkflowSteps || hasAllLanguagesAccess);

        if (isOwner || isManager || accessToAllWorkflowSteps) {
            return res.status(200).json({
                hasAccess: true,
                reason: 'User has owner/manager role or all-language access',
                identifier: loginIdentifier,
                username: memberData.username,
                langCode,
                roles: roles.map(r => r.name).filter(Boolean)
            });
        }

        if (!isEditor && !isTranslator) {
            return res.status(200).json({
                hasAccess: false,
                reason: 'User does not have editor or translator role',
                identifier: loginIdentifier,
                username: memberData.username,
                langCode,
                roles: roles.map(r => r.name).filter(Boolean)
            });
        }

        if (hasAllLanguagesAccess || languagesAccess.length === 0) {
            return res.status(200).json({
                hasAccess: true,
                reason: 'User has editor/translator role with access to all languages',
                identifier: loginIdentifier,
                username: memberData.username,
                langCode,
                roles: roles.map(r => r.name).filter(Boolean)
            });
        }

        const hasLanguageAccess = languagesAccess.some(langId => langId === crowdinLangId || langId === langCode);

        if (hasLanguageAccess) {
            return res.status(200).json({
                hasAccess: true,
                reason: `User has editor/translator access to ${crowdinLangId}`,
                identifier: loginIdentifier,
                username: memberData.username,
                langCode,
                crowdinLangId,
                roles: roles.map(r => r.name).filter(Boolean)
            });
        }

        return res.status(200).json({
            hasAccess: false,
            reason: `User does not have access to language ${crowdinLangId}`,
            identifier: loginIdentifier,
            username: memberData.username,
            langCode,
            crowdinLangId,
            roles: roles.map(r => r.name).filter(Boolean),
            accessibleLanguages: languagesAccess
        });

    } catch (error) {
        console.error('Error checking Crowdin permissions:', error);
        res.status(500).json({
            error: 'Failed to check Crowdin permissions',
            message: error.message,
            troubleshooting: {
                checkToken: 'Verify CROWDIN_API_TOKEN is set in Vercel environment variables',
                checkPermissions: 'Ensure the token has access to project 756721',
                checkProjectId: 'Verify LEVANTE_TRANSLATIONS_PROJECT_ID is correct (default: 756721)'
            }
        });
    }
}


