/**
 * Configuration file for the Levante Pitwall
 * JavaScript equivalent of utilities/config.py
 */

const CONFIG = {
    // General settings
    playht_stability: 1.2,
    elevenlabs_stability: 0.65,
    
    // API endpoints
    api: {
        playht: {
            baseUrl: 'https://api.play.ht/api/v2',
            ttsUrl: 'https://api.play.ht/api/v2/tts/stream',
            voicesUrl: 'https://api.play.ht/api/v2/voices'
        },
        elevenlabs: {
            baseUrl: 'https://api.elevenlabs.io/v1',
            ttsUrl: 'https://api.elevenlabs.io/v1/text-to-speech',
            voicesUrl: 'https://api.elevenlabs.io/v1/voices'
        }
    },
    
    // Language configuration
    languages: {
        'English': {
            lang_code: 'en',
            service: 'ElevenLabs',
            voice: 'Clara - Children\'s Storyteller',
            display_name: 'English'
        },
        'Spanish': {
            lang_code: 'es-CO',
            service: 'ElevenLabs',
            voice: 'Malena Tango',
            display_name: 'Spanish'
        },
        'German': {
            lang_code: 'de',
            service: 'ElevenLabs',
            voice: 'Julia',
            display_name: 'German'
        },
        'French': {
            lang_code: 'fr-CA',
            service: 'ElevenLabs',
            voice: 'Caroline - Top France - Narrative, warm, sweet',
            display_name: 'French'
        },
        'Dutch': {
            lang_code: 'nl',
            service: 'ElevenLabs',
            voice: 'Emma - Natural conversations in Dutch',
            display_name: 'Dutch'
        },
        'German (Switzerland)': {
            lang_code: 'de-CH',
            service: 'ElevenLabs',
            voice: 'Julia',
            display_name: 'German (Switzerland)'
        }
    },
    
    // Curated voice selections for comparison evaluation
    curatedVoices: {
        playht: {
            'en': [
                'English (US)_Susan (Advertising)',
                'English (US)_Delilah',
                'English (CA)_Charlotte (Narrative)',
                'English (CA)_Olivia (Advertising)',
                'English (IE)_Madison',
                'English (IN)_Navya',
                'English (GB)_Sarah'
            ],
            'es-CO': [
                'Spanish_Violeta Narrative',
                'Spanish_Violeta Conversational',
                'Spanish_Patricia Narrative',
                'Spanish_Patricia Conversational'
            ],
            'de': [
                'German_Anke Narrative',
                'German_Anke Conversational'
            ],
            'fr-CA': [
                'French_Ange Narrative',
                'French_Ange Conversational'
            ],
            'nl': [
                'Dutch_Lotte Narrative',
                'Dutch_Lotte Conversational'
            ]
        },
        elevenlabs: {
            'en': [
                'Yasmine',
                'Alexandra - Conversational and Real',
                'Aunt Annie - calm and professional',
                'Claudia - Credible, Competent & Authentic',
                'Zuri - New Yorker',
                'Nia Davis- Black Female',
                'Juniper',
                'Jessica Anne Bogart - Conversations'
            ],
            'es-CO': [
                'Yasmine',
                'Alexandra - Conversational and Real',
                'Aunt Annie - calm and professional',
                'Claudia - Credible, Competent & Authentic',
                'Zuri - New Yorker',
                'Nia Davis- Black Female'
            ],
            'de': [
                'Yasmine',
                'Alexandra - Conversational and Real',
                'Aunt Annie - calm and professional',
                'Claudia - Credible, Competent & Authentic',
                'Zuri - New Yorker',
                'Nia Davis- Black Female'
            ],
            'fr-CA': [
                'Yasmine',
                'Alexandra - Conversational and Real',
                'Aunt Annie - calm and professional',
                'Claudia - Credible, Competent & Authentic',
                'Zuri - New Yorker',
                'Nia Davis- Black Female'
            ],
            'nl': [
                'Yasmine',
                'Alexandra - Conversational and Real',
                'Aunt Annie - calm and professional',
                'Claudia - Credible, Competent & Authentic',
                'Zuri - New Yorker',
                'Nia Davis- Black Female'
            ]
        }
    },
    
    // Audio settings
    audio: {
        defaultFormat: 'mp3',
        defaultSampleRate: 48000,
        playbackTimeout: 30000 // 30 seconds
    },
    
    // UI settings
    ui: {
        maxRetries: 5,
        retryDelay: 1000,
        cacheTimeout: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
        searchDebounceDelay: 300
    },
    
    // File paths (for potential future use)
    paths: {
        audioFiles: 'audio_files',
        translationMaster: 'translation_master.csv',
        statsFile: 'stats.csv'
    }
};

// Helper functions
const ConfigHelper = {
    getLanguages() {
        return CONFIG.languages;
    },
    
    getLanguage(languageName) {
        return CONFIG.languages[languageName];
    },
    
    getLanguageByCode(langCode) {
        return Object.values(CONFIG.languages).find(lang => lang.lang_code === langCode);
    },
    
    getDefaultVoice(languageName) {
        const language = CONFIG.languages[languageName];
        return language ? language.voice : null;
    },
    
    getLangCode(languageName) {
        const language = CONFIG.languages[languageName];
        return language ? language.lang_code : null;
    },
    
    getService(languageName) {
        const language = CONFIG.languages[languageName];
        return language ? language.service : null;
    },
    
    getCuratedVoices(service, langCode) {
        const voices = CONFIG.curatedVoices[service.toLowerCase()];
        return voices ? voices[langCode] || [] : [];
    },
    
    getApiConfig(service) {
        return CONFIG.api[service.toLowerCase()];
    },
    
    // API key management
    getApiKey(service, keyType = 'apiKey') {
        const storageKey = `${service.toUpperCase()}_${keyType.toUpperCase()}`;
        
        // Try to get from localStorage first
        let key = localStorage.getItem(storageKey);
        
        if (!key) {
            // Try to get from environment variables (if available)
            if (typeof process !== 'undefined' && process.env) {
                key = process.env[storageKey];
            }
        }
        
        return key;
    },
    
    setApiKey(service, keyType, value) {
        const storageKey = `${service.toUpperCase()}_${keyType.toUpperCase()}`;
        localStorage.setItem(storageKey, value);
    },
    
    // Language code mapping for backward compatibility
    mapLanguageCode(langCode) {
        const mapping = {
            'en': 'en-US',
            'es': 'es-CO',
            'de': 'de-DE',
            'fr': 'fr-CA',
            'nl': 'nl-NL'
        };
        
        return mapping[langCode] || langCode;
    },
    
    // SSML processing helpers
    htmlToSSML(html) {
        // Convert HTML tags to SSML tags
        let ssml = html
            .replace(/<\s*bold\s*>/g, '<emphasis>')
            .replace(/<\s*\/\s*bold\s*>/g, '</emphasis>')
            .replace(/<\s*br\s*\/?>/g, '<break time="400ms"/>')
            .replace(/<\s*p\s*\/?>/g, '<break time="400ms"/>');
        
        // Wrap in speak tags if not already wrapped
        if (!ssml.startsWith('<speak>')) {
            ssml = `<speak>${ssml}</speak>`;
        }
        
        return ssml;
    },
    
    // Error handling helpers
    createRetryConfig(maxRetries = CONFIG.ui.maxRetries) {
        return {
            maxRetries,
            currentRetry: 0,
            baseDelay: CONFIG.ui.retryDelay,
            getDelay() {
                return this.baseDelay * Math.pow(2, this.currentRetry);
            },
            canRetry() {
                return this.currentRetry < this.maxRetries;
            },
            incrementRetry() {
                this.currentRetry++;
            }
        };
    },
    
    // Cache management
    createCacheKey(service, langCode, type = 'voices') {
        return `${service}_${langCode}_${type}`;
    },
    
    isCacheExpired(timestamp) {
        return Date.now() - timestamp > CONFIG.ui.cacheTimeout;
    },
    
    // Audio file path generation - simplified structure
    getAudioFilePath(taskName, itemName, langCode) {
        // Use simplified structure: audio_files/<langCode>/<itemName>.mp3
        return `${CONFIG.paths.audioFiles}/${langCode}/${itemName}.mp3`;
    },
    
    // Statistics helpers
    getStatsFilePath() {
        return CONFIG.paths.statsFile;
    },
    
    // Voice filtering helpers
    filterVoicesByGender(voices, gender = 'female') {
        return voices.filter(voice => {
            const voiceGender = voice.gender || voice.labels?.gender;
            return voiceGender && voiceGender.toLowerCase() === gender.toLowerCase();
        });
    },
    
    filterVoicesByLanguage(voices, langCode) {
        return voices.filter(voice => {
            const voiceLang = voice.language || voice.languageCode || voice.labels?.language;
            return voiceLang && (voiceLang === langCode || voiceLang === langCode.split('-')[0]);
        });
    },
    
    // Advertising voice detection
    isAdvertisingVoice(voiceName, voiceType = '', style = '') {
        const advertisingKeywords = [
            'advertising', 'commercial', 'promo', 'marketing', 'sales', 'ad ',
            'promotional', 'business', 'corporate', 'brand'
        ];
        
        const searchText = `${voiceName} ${voiceType} ${style}`.toLowerCase();
        
        return advertisingKeywords.some(keyword => searchText.includes(keyword));
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CONFIG, ConfigHelper };
} else {
    window.CONFIG = CONFIG;
    window.ConfigHelper = ConfigHelper;
} 