const DEFAULT_AUDIO_COPYRIGHT = 'This file was created for the LEVANTE project and is released under a Creative Commons BY-NC-SA 4.0 license';

        class Dashboard {
            constructor() {
                // Load languages from external config if available; fallback to defaults
                this.languages = (window.CONFIG && window.CONFIG.languages) ? window.CONFIG.languages : {
                    'English': { lang_code: 'en', service: 'ElevenLabs', voice: 'Clara - Children\'s Storyteller' },
                    'Spanish': { lang_code: 'es-CO', service: 'ElevenLabs', voice: 'Malena Tango' },
                    'German': { lang_code: 'de', service: 'ElevenLabs', voice: 'Julia' },
                    'French': { lang_code: 'fr-CA', service: 'ElevenLabs', voice: 'Caroline - Top France - Narrative, warm, sweet' },
                    'Dutch': { lang_code: 'nl', service: 'ElevenLabs', voice: 'Emma - Natural conversations in Dutch' },
                    'German (Switzerland)': { lang_code: 'de-CH', service: 'ElevenLabs', voice: 'Julia' }
                };
                
                this.data = [];
                this.currentLanguage = 'English';
                this.selectedRow = null;
                this.voices = { playht: [], elevenlabs: [] };
                
                // Persistent validation results dictionary
                // Structure: { item_id: { lang_code: { score: number, notes: string } } }
                this.validation_results = {};
                this.latestGeneratedAudio = null;
                this.audioCopyright = DEFAULT_AUDIO_COPYRIGHT;
                this.audioMetadataCache = new Map();
                this.draftPublicBaseUrl = (window.CONFIG && window.CONFIG.draftBucketPublicBase) || 'https://storage.googleapis.com/levante-assets-draft/';
                const origin = (typeof window !== 'undefined' && window.location && window.location.origin)
                    ? window.location.origin.replace(/\/+$/, '')
                    : '';
                const defaultShareBase = origin ? `${origin}/draft-share.html` : '';
                this.draftSharePageBase = (window.CONFIG && window.CONFIG.draftSharePageBase) || defaultShareBase;
                this.selectedDraftAudio = null;
                this.approvedDrafts = new Set();
                this.deployingDrafts = false;
                this.pendingSaveKey = null;
                
                this.setupGlobalActions();
                this.init();
            }

            refreshLanguagesFromConfig() {
                try {
                    if (window.CONFIG && window.CONFIG.languages) {
                        this.languages = window.CONFIG.languages;
                    }
                } catch (e) {
                    // ignore
                }
            }

            setupGlobalActions() {
                setTimeout(() => this.bindCopyDraftLinkButton(), 0);
            }

            bindCopyDraftLinkButton(root = document) {
                const copyBtn = root.querySelector('#copyDraftBucketLink');
                if (copyBtn && !copyBtn.dataset.bound) {
                    copyBtn.addEventListener('click', () => this.copyDraftBucketLink());
                    copyBtn.dataset.bound = 'true';
                }
            }

            copyDraftBucketLink() {
                const button = document.getElementById('copyDraftBucketLink');
                const bucketName = this.selectedDraftAudio?.bucketName || this.currentDraftBucketName;
                const folder = this.selectedDraftAudio?.folder;
                const link = this.buildDraftFolderLink(folder, bucketName);
                if (!link) {
                    this.setStatus('Draft bucket link is not configured', 'warning');
                    this.showButtonFeedback(button, 'Link unavailable', 'error', 'fa-times');
                    return;
                }
                if (!folder) {
                    this.setStatus('No draft selected — copied base bucket link.', 'warning');
                }
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(link)
                        .then(() => {
                            this.setStatus(`Copied draft link${folder ? '' : ' (base only)'}`, 'success');
                            const label = folder ? 'Copied!' : 'Copied base link';
                            this.showButtonFeedback(button, label, 'success', 'fa-check');
                        })
                        .catch((error) => {
                            console.warn('Clipboard copy failed', error);
                            this.setStatus('Unable to copy link automatically. Please copy manually.', 'warning');
                            window.prompt('Copy draft bucket link:', link);
                            this.showButtonFeedback(button, 'Copy failed', 'error', 'fa-times');
                        });
                } else {
                    this.setStatus('Clipboard API unavailable. Showing link to copy manually.', 'warning');
                    window.prompt('Copy draft bucket link:', link);
                    this.showButtonFeedback(button, 'Copy manually', 'warning', 'fa-exclamation-triangle');
                }
            }

            buildDraftFolderLink(folder = '', bucketName = '') {
                const normalizedFolder = folder ? folder.replace(/^\/+/, '').replace(/\/+$/, '') : '';
                const bucket = bucketName || this.currentDraftBucketName || 'levante-assets-draft';

                if (this.draftSharePageBase) {
                    try {
                        const shareUrl = this.draftSharePageBase.startsWith('http')
                            ? new URL(this.draftSharePageBase)
                            : new URL(this.draftSharePageBase, window.location.origin);
                        if (bucket) {
                            shareUrl.searchParams.set('bucket', bucket);
                        }
                        if (normalizedFolder) {
                            const folderParam = normalizedFolder.endsWith('/') ? normalizedFolder : `${normalizedFolder}/`;
                            shareUrl.searchParams.set('folder', folderParam);
                        }
                        shareUrl.searchParams.set('mode', 'site');
                        return shareUrl.toString();
                    } catch (error) {
                        console.warn('Failed to build draft share link, falling back to bucket URL', error);
                    }
                }

                if (!this.draftPublicBaseUrl) return null;
                const base = this.draftPublicBaseUrl.replace(/\/+$/, '');
                const bucketSegment = bucket ? bucket.replace(/\/+$/, '') : '';
                const parts = [base];
                if (bucketSegment) {
                    const normalizedBase = base.replace(/\/+$/, '');
                    const baseHasBucket = normalizedBase.endsWith(`/${bucketSegment}`) || normalizedBase === bucketSegment;
                    if (!baseHasBucket) {
                        parts.push(bucketSegment);
                    }
                }
                if (normalizedFolder) parts.push(normalizedFolder);
                return `${parts.join('/')}/`;
            }

            getDisplayName(languageKey) {
                const lang = this.languages[languageKey];
                return (lang && lang.display_name) ? lang.display_name : languageKey;
            }

            getFlagForLanguage(language) {
                // Use small flag images (50% bigger than before)
                const flagMap = {
                    'English': '<img src="https://flagcdn.com/24x18/us.png" alt="US" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'Spanish': '<img src="https://flagcdn.com/24x18/co.png" alt="CO" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'German': '<img src="https://flagcdn.com/24x18/de.png" alt="DE" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'French': '<img src="https://flagcdn.com/24x18/ca.png" alt="CA" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'Dutch': '<img src="https://flagcdn.com/24x18/nl.png" alt="NL" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    // Regional variants
                    'German (Switzerland)': '<img src="https://flagcdn.com/24x18/ch.png" alt="CH" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'Spanish (Argentina)': '<img src="https://flagcdn.com/24x18/ar.png" alt="AR" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'English (Ghana)': '<img src="https://flagcdn.com/24x18/gh.png" alt="GH" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">'
                };
                return flagMap[language] || '🌐'; // fallback to globe emoji
            }

            async init() {
                this.setStatus('Loading translation data...', 'loading');
                
                try {
                    // Load translation data
                    await this.loadData();
                    // Pick up any remote language config loaded by bootstrap
                    this.refreshLanguagesFromConfig();
                    
                    // Create tabs
                    this.createTabs();
                    
                    // Setup event listeners
                    this.setupEventListeners();
                    
                    // Load comprehensive voices
                    await this.loadComprehensiveVoices();
                    
                    // Load validation results from previous sessions (but don't apply yet)
                    await this.loadValidationResults();
                    
                    // Setup auto-save on page unload
                    this.setupAutoSave();
                    
                    this.setStatus('Dashboard ready - Select a language to begin', 'success');
                } catch (error) {
                    console.error('Dashboard initialization error:', error);
                    this.setStatus('Error loading dashboard', 'error');
                }
            }

            async loadData() {
                try {
                    // Try loading in order of preference:
                    // 1. Local complete CSV (if downloaded)
                    // 2. GitHub CSV (complete dataset)
                    // 3. localStorage cache
                    // 4. Sample data fallback
                    
                    let csvText = null;
                    let source = '';
                    
                    // Prefer remote CSV first (same URL as fetch_latest_translations.py)
                    const primaryUrl = (window.CONFIG && window.CONFIG.dataSources && window.CONFIG.dataSources.remoteCSV) 
                        ? window.CONFIG.dataSources.remoteCSV 
                        : 'https://raw.githubusercontent.com/levante-framework/levante_translations/l10n_pending/item-bank-translations.csv';
                    const fallbackUrl = 'https://raw.githubusercontent.com/levante-framework/levante_translations/l10n_pending/text/translated_prompts.csv';

                    try {
                        this.setStatus('Loading complete translation data from GitHub...', 'loading');
                        let githubResponse = await fetch(primaryUrl);
                        if (!githubResponse.ok) {
                            githubResponse = await fetch(fallbackUrl);
                        }
                        if (githubResponse.ok) {
                            csvText = await githubResponse.text();
                            source = 'GitHub';
                        }
                    } catch (e) {
                        console.warn('Remote CSV fetch failed, will try local fallback...', e);
                    }

                    // Fallback to local complete CSV if remote not available
                    if (!csvText) {
                        try {
                            this.setStatus('Checking for local complete CSV...', 'loading');
                            const localResponse = await fetch('./translation_text/complete_translations.csv');
                            if (localResponse.ok) {
                                csvText = await localResponse.text();
                                source = 'local complete CSV';
                            }
                        } catch (localError) {
                            console.log('Local complete CSV not found.');
                        }
                    }
                    
                    if (csvText) {
                        console.log(`🔍 DEBUG: CSV text length: ${csvText.length} characters`);
                        console.log(`🔍 DEBUG: CSV lines: ${csvText.split('\n').length}`);
                        
                    this.data = this.parseCSV(csvText);
                        console.log(`🔍 DEBUG: Parsed data length: ${this.data.length}`);
                        console.log(`🔍 DEBUG: First few items:`, this.data.slice(0, 3));
                        console.log(`🔍 DEBUG: Unique identifiers:`, new Set(this.data.map(item => item.item_id)).size);
                        
                        console.log(`Loaded ${this.data.length} complete translation items from ${source}`);
                        this.setStatus(`Loaded ${this.data.length} items from ${source} (complete dataset)`, 'success');
                        
                        // Cache for offline use
                        this.cacheDataLocally(csvText);
                    } else {
                        throw new Error('No CSV data source available');
                    }
                    
                } catch (error) {
                    console.warn('Could not load CSV data, trying cache...', error);
                    
                    // Try to load from localStorage cache if all else fails
                    try {
                        const cachedData = localStorage.getItem('levante_translations_cache');
                        if (cachedData) {
                            this.data = JSON.parse(cachedData);
                            console.log(`🔍 DEBUG: Loaded ${this.data.length} items from cache`);
                            console.log(`🔍 DEBUG: Cache unique identifiers:`, new Set(this.data.map(item => item.item_id)).size);
                            this.setStatus(`Loaded ${this.data.length} items from cache (offline)`, 'success');
                        } else {
                            throw new Error('No cached data available');
                        }
                    } catch (cacheError) {
                        console.warn('Cache also failed, using sample data:', cacheError);
                    this.data = this.loadSampleData();
                        this.setStatus('Using sample data - all sources failed', 'error');
                    }
                }
            }
            
            cacheDataLocally(csvText) {
                try {
                    // Cache the parsed data in localStorage for offline use
                    localStorage.setItem('levante_translations_cache', JSON.stringify(this.data));
                    console.log('Translation data cached locally for offline use');
                } catch (error) {
                    console.warn('Could not cache data locally:', error);
                }
            }

            parseCSV(csvText) {
                if (!csvText || !csvText.trim()) return [];
                
                console.log('🔧 Robust CSV Parser: Starting parse...');
                
                // First, try to parse with proper CSV logic that handles embedded newlines
                const rows = this.parseCSVWithEmbeddedNewlines(csvText);
                
                if (rows.length === 0) return [];
                
                const headers = rows[0];
                console.log('CSV Headers:', headers);
                
                const data = [];
                
                // Parse data rows (skip header)
                for (let i = 1; i < rows.length; i++) {
                    const values = rows[i];
                    
                    if (values.length >= headers.length) {
                        const row = {};
                        headers.forEach((header, index) => {
                            let value = values[index] || '';
                            
                            // Clean up embedded newlines in the value
                            if (typeof value === 'string') {
                                // Replace literal \n characters with <br> for display
                                value = value.replace(/\n/g, '<br>');
                                // Clean up extra whitespace
                                value = value.replace(/\s+/g, ' ').trim();
                            }
                            
                            row[header] = value;
                        });
                        data.push(row);
                    } else {
                        console.warn(`Row ${i} has ${values.length} columns, expected ${headers.length}:`, values);
                    }
                }
                
                console.log(`🔧 Robust CSV Parser: Parsed ${data.length} rows successfully`);
                console.log('Sample parsed data:', data.slice(0, 3));
                
                // Normalize data to ensure consistent field names
                const normalizedData = data.map(item => {
                    // Handle different possible column names for ID
                    const itemId = item.identifier || item.item_id || item.id || item.ID || item.Item_ID || null;
                    
                    // Handle different possible column names for task/labels
                    const task = item.task || item.labels || item.category || item.type || 'general';
                    
                    return {
                        ...item,
                        item_id: itemId,
                        labels: task
                    };
                });
                
                console.log('Normalized data sample:', normalizedData.slice(0, 3));
                return normalizedData;
            }

            parseCSVWithEmbeddedNewlines(csvText) {
                // Robust CSV parser that properly handles quoted fields with embedded newlines
                const rows = [];
                let currentRow = [];
                let currentField = '';
                let inQuotes = false;
                let i = 0;
                
                while (i < csvText.length) {
                    const char = csvText[i];
                    const nextChar = i + 1 < csvText.length ? csvText[i + 1] : null;
                    
                    if (char === '"') {
                        if (inQuotes && nextChar === '"') {
                            // Escaped quote - add literal quote to field
                            currentField += '"';
                            i += 2; // Skip both quotes
                        } else {
                            // Toggle quote state
                            inQuotes = !inQuotes;
                            i++;
                        }
                    } else if (char === ',' && !inQuotes) {
                        // Field separator outside quotes
                        currentRow.push(currentField.trim());
                        currentField = '';
                        i++;
                    } else if ((char === '\n' || char === '\r') && !inQuotes) {
                        // Row separator outside quotes
                        if (currentField.trim() || currentRow.length > 0) {
                            currentRow.push(currentField.trim());
                            if (currentRow.some(field => field.length > 0)) {
                                rows.push(currentRow);
                            }
                            currentRow = [];
                            currentField = '';
                        }
                        // Skip \r\n combinations
                        if (char === '\r' && nextChar === '\n') {
                            i += 2;
                        } else {
                            i++;
                        }
                    } else {
                        // Regular character or newline inside quotes
                        currentField += char;
                        i++;
                    }
                }
                
                // Handle final field/row
                if (currentField.trim() || currentRow.length > 0) {
                    currentRow.push(currentField.trim());
                    if (currentRow.some(field => field.length > 0)) {
                        rows.push(currentRow);
                    }
                }
                
                console.log(`🔧 Robust CSV Parser: Found ${rows.length} rows`);
                
                // Filter out empty rows
                const validRows = rows.filter(row => 
                    row.length > 0 && row.some(field => field && field.trim().length > 0)
                );
                
                console.log(`🔧 Robust CSV Parser: ${validRows.length} valid rows after filtering`);
                return validRows;
            }

            parseCSVLine(line) {
                const result = [];
                let current = '';
                let inQuotes = false;
                let i = 0;
                
                while (i < line.length) {
                    const char = line[i];
                    
                    if (char === '"') {
                        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
                            // Handle escaped quotes
                            current += '"';
                            i += 2;
                        } else {
                            // Toggle quote state
                            inQuotes = !inQuotes;
                            i++;
                        }
                    } else if (char === ',' && !inQuotes) {
                        result.push(current.trim());
                        current = '';
                        i++;
                    } else {
                        current += char;
                        i++;
                    }
                }
                
                result.push(current.trim());
                return result;
            }

            loadSampleData() {
                return [
                    { item_id: 'sample_1', labels: 'general', en: 'Hello, welcome to the test.', 'es-CO': 'Hola, bienvenido a la prueba.', de: 'Hallo, willkommen zum Test.', 'fr-CA': 'Bonjour, bienvenue au test.', nl: 'Hallo, welkom bij de test.' },
                    { item_id: 'sample_2', labels: 'math', en: 'Count the numbers.', 'es-CO': 'Cuenta los números.', de: 'Zähle die Zahlen.', 'fr-CA': 'Comptez les nombres.', nl: 'Tel de nummers.' },
                    { item_id: 'sample_3', labels: 'vocab', en: 'What is this word?', 'es-CO': '¿Qué es esta palabra?', de: 'Was ist dieses Wort?', 'fr-CA': 'Quel est ce mot?', nl: 'Wat is dit woord?' }
                ];
            }

            async loadRealElevenLabsVoices() {
                const credentials = getCredentials();
                const elevenKey = credentials.elevenlabs_api_key || credentials.elevenlabsApiKey;
                if (!elevenKey) {
                    console.warn('No ElevenLabs API key - skipping real voice loading');
                    return {}; // Return empty object if no API key
                }

                try {
                    // Create a proxy endpoint to get ElevenLabs voices
                        const response = await fetch('/api/elevenlabs-proxy', {
                        method: 'GET',
                        headers: {
                            'X-API-KEY': elevenKey
                        }
                    });

                    if (!response.ok) {
                        throw new Error(`Failed to load ElevenLabs voices: ${response.status}`);
                    }

                    const voicesData = await response.json();
                    
                    // Process voices and organize by languages present in dashboard (and their base codes)
                    const organizedVoices = {};
                    const configuredCodes = Object.values(this.languages).map(cfg => cfg.lang_code);
                    const uniqueCodes = Array.from(new Set(configuredCodes.concat(configuredCodes.map(c => c.split('-')[0]))));

                    for (const langCode of uniqueCodes) {
                        const apiLangCode = langCode.split('-')[0];
                        const languageVoices = voicesData.voices.filter(voice => {
                            const voiceLanguage = voice.labels?.language;
                            return voiceLanguage === apiLangCode && (
                                voice.category === "professional" ||
                                voice.category === "shared" ||
                                voice.category === "premade" ||
                                voice.category === "generated" ||
                                voice.category === "personal"
                            );
                        });

                        organizedVoices[langCode] = languageVoices.map(voice => ({
                            voice_id: voice.voice_id,
                            name: voice.name,
                            language: langCode,
                            gender: voice.labels?.gender || 'unknown'
                        }));
                    }

                    console.log('Loaded real ElevenLabs voices:', organizedVoices);
                    return organizedVoices;
                    
                } catch (error) {
                    console.error('Failed to load real ElevenLabs voices:', error);
                    return {}; // Return empty object on error
                }
            }

            async loadComprehensiveVoices() {
                this.setStatus('Loading comprehensive voices...', 'loading');
                
                // Load real ElevenLabs voices from your actual voice library
                const realElevenLabsVoices = await this.loadRealElevenLabsVoices();
                
                // Comprehensive voice data with hundreds of voices (restored from working version)
                const comprehensiveVoices = {
                    playht: {
                        "en": [
                            {"voice_id": "s3://voice-cloning-zero-shot/adb83b67-8d75-48ff-ad4d-a0840d231ef1/original/manifest.json", "name": "Inara", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/820da3d2-3a3b-42e7-844d-e68db835a206/sarah/manifest.json", "name": "Sarah", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/97580643-b568-4198-aaa4-3e07e4a06c47/original/manifest.json", "name": "Indigo", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/a0fa25cc-5f42-4dd0-8a78-a950dd5297cd/original/manifest.json", "name": "Isabella", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/32b943f6-87cf-4e15-8e7a-d4cb848e3689/original/manifest.json", "name": "Scarlett", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/f6c4ed76-1b55-4cd9-8896-31f7535f6cdb/original/manifest.json", "name": "Aaliyah", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/80ba8839-a6e6-470c-8f68-7c1e5d3ee2ff/abigailsaad/manifest.json", "name": "Abigail", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/d9ff78ba-d016-47f6-b0ef-dd630f59414e/female-cs/manifest.json", "name": "Ruby", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/fdb74aec-ede9-45f8-ad87-71cb45f01816/original/manifest.json", "name": "Carmen", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/e5df2eb3-5153-40fa-9f6e-6e27bbb7a38e/original/manifest.json", "name": "Navya", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/f3c22a65-87e8-441f-aea5-10a1c201e522/original/manifest.json", "name": "Sumita", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/928ed0a0-2271-4710-a7c9-1711d36b9897/original/manifest.json", "name": "Niamh", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/30884451-1eff-4fd8-9a24-d1ee3353b215/original/manifest.json", "name": "Siobhán", "language": "en", "gender": "female"}
                        ],
                        "de": [
                            {"voice_id": "s3://voice-cloning-zero-shot/3d1a2ebc-6fe3-4b9b-b8f3-d23a3e5b6c7d/original/manifest.json", "name": "German_Anke Narrative", "language": "de", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/820da3d2-3a3b-42e7-844d-e68db835a206/german_female/manifest.json", "name": "German Female", "language": "de", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/d4f2c5a1-8b3e-4f2d-9c7a-1e5b8d3f6a9c/original/manifest.json", "name": "Greta", "language": "de", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/b8e3f2d1-5c4a-6f8b-2d9e-7a1c3f5e8b2d/original/manifest.json", "name": "Ingrid", "language": "de", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/f7a2d8e3-9b1c-4e5f-8d2a-6c9e3f1b5a7d/original/manifest.json", "name": "Petra", "language": "de", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/c5f8a1d2-7e3b-6c9f-1a4d-8b2e5f9c3a6d/original/manifest.json", "name": "Ursula", "language": "de", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/a9c2f5e8-3d1b-7f4a-5e8c-2a6f9d3b1e7c/original/manifest.json", "name": "Brigitte", "language": "de", "gender": "female"}
                        ],
                        "es": [
                            {"voice_id": "s3://voice-cloning-zero-shot/e8f3a2d1-5c7b-9e4f-2a6d-8c1f5b3e9a7d/original/manifest.json", "name": "María", "language": "es", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/f2a8d5c1-9e3b-7f4a-6d2e-1c5f8b9a3d7e/original/manifest.json", "name": "Carmen", "language": "es", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/d7c1f5a8-2e9b-4f3d-8a1c-6e5f2b9d3a7c/original/manifest.json", "name": "Isabella", "language": "es", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/b5e8f2a1-7c3d-9f6a-3e1b-8d5f2c7a9e4f/original/manifest.json", "name": "Sofia", "language": "es", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/c9a3f7e2-1d5b-8f4c-6a2e-9f3d1b7c5a8e/original/manifest.json", "name": "Valentina", "language": "es", "gender": "female"}
                        ],
                        "fr": [
                            {"voice_id": "s3://voice-cloning-zero-shot/a1f5c8e3-9d2b-7f4a-5c8e-3a1f6d9b2e7c/original/manifest.json", "name": "Amélie", "language": "fr", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/e7c2f9a5-3d1b-8f6c-2a5e-9c3f1d7b5a8e/original/manifest.json", "name": "Camille", "language": "fr", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/f3a7e1c5-8d2b-9f4a-6c1e-5a8f3d2b7c9e/original/manifest.json", "name": "Élise", "language": "fr", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/d8f1c5a2-7e3b-6f9c-1a4d-8c2f5e9a3d7f/original/manifest.json", "name": "Juliette", "language": "fr", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/c2a9f5e1-3d7b-8f4c-5a2e-9f1d3c7a5e8f/original/manifest.json", "name": "Margot", "language": "fr", "gender": "female"}
                        ],
                        "nl": [
                            {"voice_id": "s3://voice-cloning-zero-shot/f5a2d8c1-9e3b-7f4a-6d1c-8e5f2a9d3c7e/original/manifest.json", "name": "Emma", "language": "nl", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/e1c7f9a3-5d2b-8f6c-3a1e-9c5f7d2a8e4f/original/manifest.json", "name": "Sophie", "language": "nl", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/a8f3c2d5-1e7b-9f4a-5c2e-8a3f1d7c9e5f/original/manifest.json", "name": "Lotte", "language": "nl", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/d2c8f1a5-7e3b-6f9c-2a5d-8c1f3e9a7d5c/original/manifest.json", "name": "Iris", "language": "nl", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/c7a1f5e8-3d9b-8f2c-6a1e-9f5d3c8a2e7f/original/manifest.json", "name": "Fleur", "language": "nl", "gender": "female"}
                        ]
                    },
                    elevenlabs: realElevenLabsVoices || {
                        "en": [
                            {"voice_id": "kdmDKE6EkgrWrrykO9Qt", "name": "Alexandra - Conversational and Real", "language": "en", "gender": "female"},
                            {"voice_id": "yu4eXTP5aod8KAQzTI3T", "name": "Claudia - Credible, Competent & Authentic", "language": "en", "gender": "female"},
                            {"voice_id": "aMSt68OGf4xUZAnLpTU8", "name": "Juniper", "language": "en", "gender": "female"},
                            {"voice_id": "bIHbv24MWmeRgasZH58o", "name": "Will", "language": "en", "gender": "male"},
                            {"voice_id": "EXAVITQu4vr4xnSDxMaL", "name": "Bella", "language": "en", "gender": "female"},
                            {"voice_id": "ErXwobaYiN019PkySvjV", "name": "Antoni", "language": "en", "gender": "male"},
                            {"voice_id": "MF3mGyEYCl7XYWbV9V6O", "name": "Elli", "language": "en", "gender": "female"},
                            {"voice_id": "TxGEqnHWrfWFTfGW9XjX", "name": "Josh", "language": "en", "gender": "male"},
                            {"voice_id": "VR6AewLTigWG4xSOukaG", "name": "Arnold", "language": "en", "gender": "male"},
                            {"voice_id": "pNInz6obpgDQGcFmaJgB", "name": "Adam", "language": "en", "gender": "male"},
                            {"voice_id": "yoZ06aMxZJJ28mfd3POQ", "name": "Sam", "language": "en", "gender": "male"},
                            {"voice_id": "AZnzlk1XvdvUeBnXmlld", "name": "Domi", "language": "en", "gender": "female"},
                            {"voice_id": "CYw3kZ02Hs0563khs1Fj", "name": "Dave", "language": "en", "gender": "male"},
                            {"voice_id": "D38z5RcWu1voky8WS1ja", "name": "Fin", "language": "en", "gender": "male"},
                            {"voice_id": "IKne3meq5aSn9XLyUdCD", "name": "Charlie", "language": "en", "gender": "male"},
                            {"voice_id": "JBFqnCBsd6RMkjVDRZzb", "name": "George", "language": "en", "gender": "male"},
                            {"voice_id": "N2lVS1w4EtoT3dr4eOWO", "name": "Callum", "language": "en", "gender": "male"},
                            {"voice_id": "SOYHLrjzK2X1ezoPC6cr", "name": "Harry", "language": "en", "gender": "male"},
                            {"voice_id": "ThT5KcBeYPX3keUQqHPh", "name": "Dorothy", "language": "en", "gender": "female"},
                            {"voice_id": "XB0fDUnXU5powFXDhCwa", "name": "Charlotte", "language": "en", "gender": "female"},
                            {"voice_id": "Xb7hH8MSUJpSbSDYk0k2", "name": "Alice", "language": "en", "gender": "female"},
                            {"voice_id": "XrExE9yKIg1WjnnlVkGX", "name": "Matilda", "language": "en", "gender": "female"},
                            {"voice_id": "Zlb1dXrM653N07WRdFW3", "name": "Lily", "language": "en", "gender": "female"},
                            {"voice_id": "g5CIjZEefAph4nQFvHAz", "name": "River", "language": "en", "gender": "male"},
                            {"voice_id": "jBpfuIE2acCO8z3wKNLl", "name": "Gigi", "language": "en", "gender": "female"},
                            {"voice_id": "jsCqWAovK2LkecY7zXl4", "name": "Freya", "language": "en", "gender": "female"},
                            {"voice_id": "nPczCjzI2devNBz1zQrb", "name": "Brian", "language": "en", "gender": "male"},
                            {"voice_id": "onwK4e9ZLuTAKqWW03F9", "name": "Daniel", "language": "en", "gender": "male"},
                            {"voice_id": "piTKgcLEGmPE4e6mEKli", "name": "Nicole", "language": "en", "gender": "female"},
                            {"voice_id": "t0jbNlBVZ17f02VDIeMI", "name": "Sarah", "language": "en", "gender": "female"},
                            {"voice_id": "z9fAnlkpzviPz146aGWa", "name": "Bill", "language": "en", "gender": "male"}
                        ],
                        "es-CO": [
                            {"voice_id": "VBmCZpOLbAT9F8rUdK7k", "name": "Ana María - Calm & natural neutral Spanish", "language": "es-CO", "gender": "female"},
                            {"voice_id": "D4BIjjCRFRZhH8fGOzGP", "name": "Spanish Female Voice", "language": "es-CO", "gender": "female"},
                            {"voice_id": "E3A1KVHlyvOAmKwVNVIv", "name": "Esperanza - Warm & expressive Mexican Spanish", "language": "es", "gender": "female"},
                            {"voice_id": "L0YZdOCrJp8dJQtLF8pF", "name": "Diego - Deep & warm Mexican Spanish", "language": "es", "gender": "male"},
                            {"voice_id": "M8TxODKrfOLbHv3FQ2pL", "name": "Valentina - Soft & melodic Spanish", "language": "es", "gender": "female"}
                        ],
                        "de": [
                            {"voice_id": "D4BIjjCRFRZhH8fGOzGP", "name": "German Voice", "language": "de", "gender": "female"},
                            {"voice_id": "BmGJM2HQCL8H5KfGOzGP", "name": "German Female Voice 2", "language": "de", "gender": "female"},
                            {"voice_id": "F2YzKvMjPqRtN8bHc4dF", "name": "Greta - Clear & professional German", "language": "de", "gender": "female"},
                            {"voice_id": "H8kLmQrTvXzB3fYpN9wJ", "name": "Klaus - Authoritative German", "language": "de", "gender": "male"},
                            {"voice_id": "P5wRyBmKqLzF8cHtN2vX", "name": "Ingrid - Warm German narrator", "language": "de", "gender": "female"}
                        ],
                        "fr-CA": [
                            {"voice_id": "D4BIjjCRFRZhH8fGOzGP", "name": "Caroline - Top France - Narrative, warm, sweet", "language": "fr-CA", "gender": "female"},
                            {"voice_id": "BmGJM2HQCL8H5KfGOzGP", "name": "French Canadian Voice", "language": "fr-CA", "gender": "female"},
                            {"voice_id": "L9TxPqKvRzN8bHc4dFmY", "name": "Amélie - Elegant French", "language": "fr", "gender": "female"},
                            {"voice_id": "M3kRyBqLzF8cHtN2vXpW", "name": "Pierre - Distinguished French", "language": "fr", "gender": "male"},
                            {"voice_id": "N7wLmQvTzB3fYpN9wJkR", "name": "Camille - Soft French narrator", "language": "fr", "gender": "female"}
                        ],
                        "nl": [
                            {"voice_id": "OlBRrVAItyi00MuGMbna", "name": "Emma - Natural conversations in Dutch", "language": "nl", "gender": "female"},
                            {"voice_id": "BmGJM2HQCL8H5KfGOzGP", "name": "Dutch Female Voice", "language": "nl", "gender": "female"},
                            {"voice_id": "Q4rTyBmLzF8cHtN2vXpW", "name": "Sophie - Clear Dutch", "language": "nl", "gender": "female"},
                            {"voice_id": "R8kLmQvTzB3fYpN9wJkR", "name": "Pieter - Professional Dutch", "language": "nl", "gender": "male"},
                            {"voice_id": "S2wRyBqLzF8cHtN2vXpW", "name": "Lotte - Friendly Dutch narrator", "language": "nl", "gender": "female"}
                        ]
                    }
                };

                // Load voices from comprehensive data
                this.voices.playht = [];
                this.voices.elevenlabs = [];

                // Flatten PlayHT voices from all languages
                for (const [langCode, voices] of Object.entries(comprehensiveVoices.playht)) {
                    this.voices.playht.push(...voices.map(voice => ({
                        ...voice,
                        lang_code: langCode
                    })));
                }

                // Flatten ElevenLabs voices from all languages
                for (const [langCode, voices] of Object.entries(comprehensiveVoices.elevenlabs)) {
                    this.voices.elevenlabs.push(...voices.map(voice => ({
                        ...voice,
                        lang_code: langCode
                    })));
                }

                // Global deduplication of ElevenLabs voices by voice_id (fallback to name)
                const seenGlobal = new Set();
                this.voices.elevenlabs = this.voices.elevenlabs.filter(v => {
                    const key = v.voice_id || v.name;
                    if (!key) return false;
                    if (seenGlobal.has(key)) return false;
                    seenGlobal.add(key);
                    return true;
                });

                console.log(`Loaded ${this.voices.playht.length} PlayHT voices and ${this.voices.elevenlabs.length} ElevenLabs voices`);
                this.populateVoices();
                this.setStatus(`Loaded ${this.voices.playht.length + this.voices.elevenlabs.length} comprehensive voices`, 'success');
            }

            // ===== VALIDATION PERSISTENCE METHODS =====
            
            async loadValidationResults() {
                try {
                    console.log('🔄 Loading validation results...');
                    
                    // Try to load from shared storage first
                    const sharedLoaded = await this.loadFromSharedStorage();
                    
                    if (!sharedLoaded) {
                        console.log('📝 No shared storage found, checking static JSON file...');
                        
                        // Try loading from JSON file
                        try {
                            const jsonResponse = await fetch('./validation_results.json');
                            if (jsonResponse.ok) {
                                const jsonData = await jsonResponse.json();
                                if (jsonData.validation_results) {
                                    this.validation_results = jsonData.validation_results;
                                    console.log(`✅ Loaded ${Object.keys(this.validation_results).length} validation results from JSON file`);
                                    console.log(`📅 File exported: ${jsonData.metadata?.exported_at || 'Unknown date'}`);
                                    return; // Successfully loaded from file
                                }
                            }
                        } catch (jsonError) {
                            console.log('📝 No validation_results.json file found, checking localStorage...');
                        }
                        
                        // Fallback to localStorage if JSON file not found
                        console.log('🔄 Loading validation results from localStorage...');
                        const storedResults = localStorage.getItem('validation_results');
                        
                        if (storedResults) {
                            this.validation_results = JSON.parse(storedResults);
                            console.log(`✅ Loaded ${Object.keys(this.validation_results).length} validation results from localStorage`);
                        } else {
                            console.log('📝 No previous validation results found, starting fresh');
                            this.validation_results = {};
                        }
                    }
                } catch (error) {
                    console.error('❌ Error loading validation results:', error);
                    this.validation_results = {};
                }
            }
            
            async saveValidationResults() {
                try {
                    console.log('💾 Saving validation results to localStorage and shared storage...');
                    
                    // Count total validation entries
                    let totalValidations = 0;
                    Object.keys(this.validation_results).forEach(itemId => {
                        totalValidations += Object.keys(this.validation_results[itemId]).length;
                    });
                    
                    // Save to localStorage (immediate backup)
                    localStorage.setItem('validation_results', JSON.stringify(this.validation_results));
                    
                    // Also save to shared storage (await to ensure persistence before UI update)
                    await this.saveToSharedStorage();
                    
                    console.log(`✅ Saved ${Object.keys(this.validation_results).length} items with ${totalValidations} total validations`);
                    
                    return {
                        success: true,
                        itemCount: Object.keys(this.validation_results).length,
                        validationCount: totalValidations
                    };
                } catch (error) {
                    console.error('❌ Error saving validation results:', error);
                    return {
                        success: false,
                        error: error.message
                    };
                }
            }

            async saveToSharedStorage() {
                try {
                    console.log('🌐 Saving validation results to shared storage...');
                    
                    const exportData = {
                        validation_results: this.validation_results,
                        metadata: {
                            saved_by: 'Levante Pitwall Dashboard',
                            version: '1.0',
                            total_items: Object.keys(this.validation_results).length,
                            languages: Object.keys(this.languages),
                            saved_at: new Date().toISOString()
                        }
                    };

                    const response = await fetch('/api/validation-storage', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(exportData)
                    });

                    if (response.ok) {
                        const result = await response.json();
                        console.log('✅ Successfully saved to shared storage:', result.metadata);
                        this.setStatus('💾 Validation results saved to shared session storage for team access', 'success');
                    } else {
                        console.warn('⚠️ Failed to save to shared storage, but localStorage backup is available');
                    }
                } catch (error) {
                    console.warn('⚠️ Could not save to shared storage:', error.message);
                    // Don't throw error - localStorage save is the primary backup
                }
            }

            async loadFromSharedStorage() {
                try {
                    console.log('🌐 Loading validation results from shared storage...');
                    
                    const response = await fetch('/api/validation-storage');
                    
                    if (response.ok) {
                        const result = await response.json();
                        if (result.success && result.data.validation_results) {
                            // Merge with local results (shared storage takes precedence for newer data)
                            const sharedResults = result.data.validation_results;
                            const localResults = this.validation_results;
                            
                            // Smart merge: keep newer validations
                            Object.keys(sharedResults).forEach(itemId => {
                                if (!localResults[itemId]) {
                                    localResults[itemId] = sharedResults[itemId];
                                } else {
                                    // Merge language validations, keeping newer ones
                                    Object.keys(sharedResults[itemId]).forEach(lang => {
                                        const sharedValidation = sharedResults[itemId][lang];
                                        const localValidation = localResults[itemId][lang];
                                        
                                        if (!localValidation || 
                                            (sharedValidation.updated && 
                                             (!localValidation.updated || sharedValidation.updated > localValidation.updated))) {
                                            localResults[itemId][lang] = sharedValidation;
                                        }
                                    });
                                }
                            });
                            
                            this.validation_results = localResults;
                            console.log(`✅ Loaded shared validation results: ${Object.keys(sharedResults).length} items`);
                            this.setStatus('🌐 Loaded validation results from shared session storage', 'success');
                            return true;
                        }
                    }
                } catch (error) {
                    console.log('⚠️ Could not load from shared storage:', error.message);
                }
                return false;
            }
            
            setupAutoSave() {
                // Auto-save disabled per user request
                // Users can manually save using the "Save Validations" button
                
                console.log('🔧 Auto-save disabled - use manual save button');
            }
            
            applyStoredValidationResults() {
                // Deprecated: Use applyStoredValidationResultsForCurrentLanguage() instead
                console.log('⚠️ applyStoredValidationResults is deprecated, use applyStoredValidationResultsForCurrentLanguage');
                this.applyStoredValidationResultsForCurrentLanguage();
            }
            
            applyStoredValidationResultsForCurrentLanguage() {
                const currentLangCode = this.languages[this.currentLanguage].lang_code;
                console.log(`🎯 Applying stored validation results for ${this.currentLanguage} (${currentLangCode})...`);
                let appliedCount = 0;
                
                Object.keys(this.validation_results).forEach(itemId => {
                    if (this.validation_results[itemId][currentLangCode]) {
                        const result = this.validation_results[itemId][currentLangCode];
                        if (result.score !== undefined) {
                            this.updateValidationUI(itemId, currentLangCode, result.score, result.notes || '');
                            appliedCount++;
                        }
                    }
                });
                
                console.log(`✅ Applied ${appliedCount} stored validation results for ${this.currentLanguage}`);
                
                // Update summary for current language
                if (typeof updateValidationSummary === 'function') {
                    updateValidationSummary();
                }
            }
            
            storeValidationResult(itemId, langCode, score, notes = '') {
                // Initialize item if it doesn't exist
                if (!this.validation_results[itemId]) {
                    this.validation_results[itemId] = {};
                }
                
                // Store the result
                this.validation_results[itemId][langCode] = {
                    score: score,
                    notes: notes,
                    timestamp: new Date().toISOString()
                };
                
                console.log(`📝 Stored validation result: ${itemId}[${langCode}] = ${score}%`);
            }
            
            updateValidationUI(itemId, langCode, score, notes) {
                // Map langCode to language name to target the correct tab
                const langCodeToLanguage = {
                    'en': 'English',
                    'es-CO': 'Spanish', 
                    'de': 'German',
                    'de-CH': 'German (Switzerland)',
                    'fr-CA': 'French',
                    'nl': 'Dutch'
                };
                
                const languageName = langCodeToLanguage[langCode];
                if (!languageName) {
                    console.warn(`Unknown langCode: ${langCode}`);
                    return;
                }
                
                // Look for indicator within the specific language tab
                const languageTab = document.getElementById(`table-${languageName}`);
                if (!languageTab) {
                    console.warn(`Language tab not found: table-${languageName}`);
                    return;
                }
                
                const indicator = languageTab.querySelector(`[data-item-id="${itemId}"]`);
                if (!indicator) {
                    console.warn(`Indicator not found for ${itemId} in ${languageName} tab`);
                    return;
                }
                
                // Convert stored decimal score to percentage for display
                const scorePercent = Math.round((score * 100) * 100) / 100; // 2 decimal places
                
                // Determine status based on score percentage
                let statusClass, statusTitle, buttonText, scoreEmoji;
                if (scorePercent >= 85) {
                    statusClass = 'status-good';
                    statusTitle = `✅ Excellent: ${scorePercent.toFixed(2)}% similarity`;
                    buttonText = 'View Results';
                    scoreEmoji = '✅';
                } else if (scorePercent >= 70) {
                    statusClass = 'status-warning';
                    statusTitle = `⚠️ Warning: ${scorePercent.toFixed(2)}% similarity`;
                    buttonText = 'View Warning';
                    scoreEmoji = '⚠️';
                } else {
                    statusClass = 'status-error';
                    statusTitle = `❌ Poor: ${scorePercent.toFixed(2)}% similarity`;
                    buttonText = 'View Issues';
                    scoreEmoji = '❌';
                }
                
                // Update indicator
                indicator.className = `status-indicator ${statusClass}`;
                indicator.title = statusTitle;
                
                // Update or create score badge
                const existingBadge = indicator.parentElement.querySelector('.score-badge');
                if (existingBadge) existingBadge.remove();
                
                const scoreBadge = document.createElement('span');
                scoreBadge.className = 'score-badge';
                scoreBadge.textContent = `${scorePercent.toFixed(2)}%`;
                scoreBadge.style.cssText = `
                    font-size: 10px;
                    font-weight: bold;
                    color: ${scorePercent >= 85 ? '#155724' : scorePercent >= 70 ? '#856404' : '#721c24'};
                    margin-left: 4px;
                    opacity: 0.9;
                `;
                indicator.parentElement.appendChild(scoreBadge);
                
                // Update button if it exists
                const button = indicator.parentElement.querySelector('.validate-btn');
                if (button) {
                    button.textContent = `${scoreEmoji} ${buttonText}`;
                    button.disabled = false;
                }
            }

            createTabs() {
                // Ensure latest language map
                this.refreshLanguagesFromConfig();
                const tabButtons = document.getElementById('tabButtons');
                const tabContent = document.getElementById('tabContent');
                
                // Clear existing tabs to prevent duplicates
                tabButtons.innerHTML = '';
                tabContent.innerHTML = '';
                
                Object.keys(this.languages).forEach((language, index) => {
                    // Create tab button
                    const button = document.createElement('button');
                    button.className = `tab-button ${index === 0 ? 'active' : ''}`;
                    button.textContent = this.getDisplayName(language);
                    button.addEventListener('click', () => this.switchTab(language, button));
                    tabButtons.appendChild(button);

                    // Create tab content
                    const content = document.createElement('div');
                    content.className = `tab-content ${index === 0 ? 'active' : ''}`;
                    content.id = `tab-${language}`;
                    
                    const langConfig = this.languages[language];
                    content.innerHTML = `
                        <h3>${this.getFlagForLanguage(language)}${language} Configuration</h3>
                        <div class="language-info">
                            <div class="info-card">
                                <strong>Language Code</strong>
                                <span>${langConfig.lang_code}</span>
                            </div>
                            <div class="info-card">
                                <strong>Default Service</strong>
                                <span>${langConfig.service}</span>
                            </div>
                            <div class="info-card">
                                <strong>Default Voice</strong>
                                <span>${langConfig.voice}</span>
                            </div>
                        </div>
                        <div class="data-table">
                            <div class="table-header">
                                <h4><i class="fas fa-table"></i> Translation Items <span id="item-count-${language}" class="item-count">(Loading...)</span></h4>
                                <input type="text" class="search-box" placeholder="Search items..." id="search-${language}">
                            </div>
                            <div class="table-content" id="table-${language}">
                                <!-- Data will be populated here -->
                            </div>
                        </div>
                    `;
                    tabContent.appendChild(content);
                });
                
                // Setup search listeners for the newly created search boxes
                setTimeout(() => this.setupSearchListeners(), 100);
                
                // Populate initial data
                this.populateDataTable();
            }

            populateDataTable() {
                // Ensure latest language map
                this.refreshLanguagesFromConfig();
                const langCode = this.languages[this.currentLanguage].lang_code;
                const tableContent = document.getElementById(`table-${this.currentLanguage}`);
                
                if (!tableContent) return;

                tableContent.innerHTML = '';
                
                console.log(`🔍 DEBUG: Populating table for ${this.getDisplayName(this.currentLanguage)} (${langCode}) with ${this.data.length} items`);
                console.log(`🔍 DEBUG: Unique identifiers in data:`, new Set(this.data.map(item => item.item_id)).size);
                console.log(`🔍 DEBUG: Sample identifiers:`, this.data.slice(0, 10).map(item => item.item_id));
                
                // Update item count in header
                const itemCountSpan = document.getElementById(`item-count-${this.currentLanguage}`);
                if (itemCountSpan) {
                    itemCountSpan.textContent = `(${this.data.length} items)`;
                    itemCountSpan.style.color = '#6c757d';
                    itemCountSpan.style.fontSize = '0.9em';
                }
                
                                    this.data.forEach((item, index) => {
                        let text = item[langCode];
                        if (!text && langCode.includes('-')) {
                            const base = langCode.split('-')[0];
                            text = item[base];
                        }
                        if (!text) {
                            const keys = Object.keys(item);
                            const match = keys.find(k => k.toLowerCase() === langCode.toLowerCase());
                            text = match ? item[match] : null;
                        }
                        if (!text) text = item.en || 'No translation available';
                    
                    const row = document.createElement('div');
                    row.className = 'data-row';
                    
                    // Debug logging for first few items
                    if (index < 3) {
                        console.log(`Item ${index}:`, {
                            raw_item: item,
                            item_id: item.item_id,
                            labels: item.labels,
                            available_keys: Object.keys(item)
                        });
                    }
                    
                    const itemId = item.item_id || `fallback_${index}`;
                    const taskName = item.labels || item.task || 'general';
                    const originalEnglish = item.en || 'No English source';
                    row.dataset.itemId = itemId;
                    row.dataset.langCode = langCode;
                    const escapedItemId = itemId.replace(/'/g, "\\'");
                    const escapedOriginal = originalEnglish.replace(/'/g, "\\'").replace(/"/g, '\\"');
                    const escapedTranslation = text.replace(/'/g, "\\'").replace(/"/g, '\\"');
                    
                    row.innerHTML = `
                        <div class="item_id">${itemId}</div>
                        <div class="item-task">${taskName}</div>
                        <div class="item-english">${originalEnglish}</div>
                        <div class="item-text">
                            ${text}
                            <div class="validation-status">
                                <div class="status-indicator status-pending" title="Not validated yet" data-item-id="${itemId}"></div>
                                <button class="validate-btn" onclick="validateSingle('${escapedItemId}', '${escapedOriginal}', '${escapedTranslation}', '${langCode}')">Validate</button>
                                <button class="info-btn" onclick="showAudioInfo('${escapedItemId}', '${langCode}')" title="Show audio metadata">Info</button>
                            </div>
                        </div>
                        <div class="audio-controls">
                            <button class="play-btn" onclick="playAudio('${escapedItemId}', '${langCode}')" title="Play existing audio">
                                <i class="fas fa-play"></i>
                            </button>
                            <button class="regen-btn" onclick="regenerateItemAudio('${escapedItemId}', '${langCode}')" title="Re-generate audio with selected voice">
                                <i class="fas fa-arrows-rotate"></i>
                            </button>
                            <button class="save-btn" data-item-id="${escapedItemId}" data-lang-code="${langCode}" onclick="saveItemAudio('${escapedItemId}', '${langCode}')" title="Generate audio before saving" disabled>
                                 <i class="fas fa-floppy-disk"></i>
                             </button>
                        </div>
                    `;
                    
                    const saveButton = row.querySelector('.save-btn');
                    if (saveButton) {
                        saveButton.dataset.itemId = itemId;
                        saveButton.dataset.langCode = langCode;
                        const pendingKey = this.pendingSaveKey;
                        const key = `${langCode}::${itemId}`;
                        const isPending = Boolean(
                            pendingKey &&
                            pendingKey === key &&
                            this.latestGeneratedAudio &&
                            this.latestGeneratedAudio.itemId === itemId &&
                            this.latestGeneratedAudio.langCode === langCode
                        );
                        saveButton.disabled = !isPending;
                        saveButton.title = isPending ? 'Save latest generated audio to draft bucket' : 'Generate audio before saving';
                    }
                    
                    row.addEventListener('click', () => this.selectRow(row, item));
                    tableContent.appendChild(row);
                });
                
                // Apply stored validation results after table is populated, but only for current language
                setTimeout(() => {
                    this.applyStoredValidationResultsForCurrentLanguage();
                }, 100);
                
                // Update validation summary after populating table
                updateValidationSummary();
            }

            selectRow(rowElement, item) {
                // Remove previous selection
                document.querySelectorAll('.data-row').forEach(row => row.classList.remove('selected'));
                
                // Add selection to clicked row
                rowElement.classList.add('selected');
                this.selectedRow = item;
                
                                    const langCode = this.languages[this.currentLanguage].lang_code;
                    // Try exact lang code, then base language (e.g., de-CH -> de), then any case variations
                    let text = item[langCode];
                    if (!text && langCode.includes('-')) {
                        const base = langCode.split('-')[0];
                        text = item[base];
                    }
                    if (!text) {
                        // Attempt case-insensitive lookup of headers
                        const keys = Object.keys(item);
                        const match = keys.find(k => k.toLowerCase() === langCode.toLowerCase());
                        text = match ? item[match] : null;
                    }
                    if (!text) text = item.en || 'No translation available';
                const itemId = item.item_id || 'unknown_id';
                
                console.log('Selected item:', { item, itemId, langCode, text: text.substring(0, 50) });
                this.setStatus(`Selected: ${itemId} - "${text.substring(0, 50)}..."`, 'success');
            }

            switchTab(language, button) {
                // Update active states
                document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
                
                button.classList.add('active');
                document.getElementById(`tab-${language}`).classList.add('active');
                
                // Refresh languages in case remote config changed
                this.refreshLanguagesFromConfig();
                this.currentLanguage = language;
                this.populateVoices();
                this.populateDataTable();
                updateValidationSummary(); // Update counts for new language tab
                this.setStatus(`Switched to ${this.getDisplayName(language)} - ${this.languages[language].service} (${this.languages[language].lang_code})`, 'success');
            }

            populateVoices() {
                // Ensure latest language map
                this.refreshLanguagesFromConfig();
                const playhtSelect = document.getElementById('playhtVoice');
                const elevenlabsSelect = document.getElementById('elevenlabsVoice');
                
                // Clear existing options
                playhtSelect.innerHTML = '<option value="">Select PlayHT Voice...</option>';
                elevenlabsSelect.innerHTML = '<option value="">Select ElevenLabs Voice...</option>';
                
                const langCode = this.languages[this.currentLanguage].lang_code;
                
                // Filter and populate PlayHT voices for current language (accept base language of BCP-47)
                const baseLang = langCode.includes('-') ? langCode.split('-')[0] : langCode;
                const playhtVoices = this.voices.playht.filter(voice => 
                    voice.lang_code === langCode || voice.language === langCode || voice.lang_code === baseLang || voice.language === baseLang
                );
                
                playhtVoices.forEach(voice => {
                    const option = document.createElement('option');
                    option.value = voice.voice_id;
                    option.textContent = voice.name;
                    playhtSelect.appendChild(option);
                });
                
                // Filter and populate ElevenLabs voices for current language (accept base language of BCP-47)
                const elevenlabsVoices = this.voices.elevenlabs.filter(voice => {
                    const vLang = voice.lang_code || voice.language || '';
                    const vBase = vLang.includes('-') ? vLang.split('-')[0] : vLang;
                    return vLang === langCode || vLang === baseLang || vBase === baseLang;
                });
                
                // Deduplicate by voice_id (or name fallback) to avoid duplicates from base/regional overlaps
                const seenVoiceIds = new Set();
                const uniqueElevenLabs = [];
                elevenlabsVoices.forEach(v => {
                    const key = v.voice_id || v.name;
                    if (key && !seenVoiceIds.has(key)) {
                        seenVoiceIds.add(key);
                        uniqueElevenLabs.push(v);
                    }
                });
                
                uniqueElevenLabs.forEach(voice => {
                    const option = document.createElement('option');
                    option.value = voice.voice_id;
                    option.textContent = voice.name;
                    elevenlabsSelect.appendChild(option);
                });
            }

            setupEventListeners() {
                // Refresh voices button
                document.getElementById('refreshVoices').addEventListener('click', async () => {
                    // Re-load real ElevenLabs voices (uses any newly saved credentials)
                    await this.loadComprehensiveVoices();
                    this.populateVoices();
                    this.setStatus('Voices reloaded from services', 'success');
                });

                // Voice selection handlers
                document.getElementById('playhtVoice').addEventListener('change', (e) => {
                    if (e.target.value) {
                        this.setStatus(`PlayHT voice selected: ${e.target.options[e.target.selectedIndex].text}`, 'success');
                    }
                });

                document.getElementById('elevenlabsVoice').addEventListener('change', (e) => {
                    if (e.target.value) {
                        this.setStatus(`ElevenLabs voice selected: ${e.target.options[e.target.selectedIndex].text}`, 'success');
                    }
                });

                // Copy buttons for voice names
                document.getElementById('copyPlayhtVoice').addEventListener('click', () => {
                    const select = document.getElementById('playhtVoice');
                    if (select.selectedIndex > 0) {
                        const voiceName = select.options[select.selectedIndex].text;
                        navigator.clipboard.writeText(voiceName).then(() => {
                            this.setStatus(`Copied PlayHT voice: ${voiceName}`, 'success');
                        });
                    } else {
                        this.setStatus('No PlayHT voice selected', 'error');
                    }
                });

                document.getElementById('copyElevenlabsVoice').addEventListener('click', () => {
                    const select = document.getElementById('elevenlabsVoice');
                    if (select.selectedIndex > 0) {
                        const voiceName = select.options[select.selectedIndex].text;
                        navigator.clipboard.writeText(voiceName).then(() => {
                            this.setStatus(`Copied ElevenLabs voice: ${voiceName}`, 'success');
                        });
                    } else {
                        this.setStatus('No ElevenLabs voice selected', 'error');
                    }
                });

                // Text generation controls
                document.getElementById('generateAudio').addEventListener('click', () => {
                    this.generateAudioFromText();
                });

                document.getElementById('populateSelected').addEventListener('click', () => {
                    this.populateSelectedText();
                });

                const viewDeployFolderBtn = document.getElementById('viewDeployFolder');
                if (viewDeployFolderBtn) {
                    viewDeployFolderBtn.addEventListener('click', () => {
                        this.openDeployFolderLink();
                    });
                }

                const viewDraftAudioBtn = document.getElementById('viewDraftAudio');
                if (viewDraftAudioBtn) {
                    viewDraftAudioBtn.addEventListener('click', () => {
                        this.openDraftAudioModal();
                    });
                }

                 // Setup search functionality for all language tabs
                 this.setupSearchListeners();
             }

             setupSearchListeners() {
                 // Add search event listeners for each language
                 Object.keys(this.languages).forEach(language => {
                     const searchBox = document.getElementById(`search-${language}`);
                     if (searchBox) {
                         searchBox.addEventListener('input', (e) => {
                             this.filterTable(language, e.target.value);
                         });
                     }
                 });
             }

             filterTable(language, searchTerm) {
                 const tableContent = document.getElementById(`table-${language}`);
                 if (!tableContent) return;

                 const rows = tableContent.querySelectorAll('.data-row');
                 const searchLower = searchTerm.toLowerCase();
                 let visibleCount = 0;

                 rows.forEach(row => {
                     const itemId = row.querySelector('.item_id')?.textContent || '';
                     const itemText = row.querySelector('.item-text')?.textContent || '';
                     const itemEnglish = row.querySelector('.item-english')?.textContent || '';
                     const itemTask = row.querySelector('.item-task')?.textContent || '';

                     const matches = 
                         itemId.toLowerCase().includes(searchLower) ||
                         itemText.toLowerCase().includes(searchLower) ||
                         itemEnglish.toLowerCase().includes(searchLower) ||
                         itemTask.toLowerCase().includes(searchLower);

                     if (matches) {
                         row.style.display = '';
                         visibleCount++;
                     } else {
                         row.style.display = 'none';
                     }
                 });

                 // Update item count to show filtered results
                 const itemCountSpan = document.getElementById(`item-count-${language}`);
                 if (itemCountSpan) {
                     if (searchTerm) {
                         itemCountSpan.textContent = `(${visibleCount} of ${rows.length} items)`;
                         itemCountSpan.style.color = '#007bff';
                     } else {
                         itemCountSpan.textContent = `(${rows.length} items)`;
                         itemCountSpan.style.color = '#6c757d';
                     }
                 }

                 if (searchTerm) {
                    this.setStatus(`Showing ${visibleCount} items matching "${searchTerm}" in ${this.getDisplayName(language)}`, 'success');
                }
            }

            getLanguageConfigByCode(langCode) {
                const exactMatch = Object.values(this.languages).find(cfg => cfg.lang_code === langCode);
                if (exactMatch) return exactMatch;
                const base = langCode.includes('-') ? langCode.split('-')[0] : langCode;
                return Object.values(this.languages).find(cfg => {
                    const cfgLang = cfg.lang_code || '';
                    const cfgBase = cfgLang.includes('-') ? cfgLang.split('-')[0] : cfgLang;
                    return cfgBase === base;
                }) || this.languages[this.currentLanguage];
            }

            async fetchExistingAudioMetadata(itemId, langCode) {
                if (!itemId || !langCode) return null;
                try {
                    const cacheKey = `${langCode}::${itemId}`;
                    if (!this.audioMetadataCache) {
                        this.audioMetadataCache = new Map();
                    }
                    if (this.audioMetadataCache.has(cacheKey)) {
                        return this.audioMetadataCache.get(cacheKey);
                    }

                    const response = await fetch(`/api/read-tags?itemId=${encodeURIComponent(itemId)}&langCode=${encodeURIComponent(langCode)}`);
                    if (!response.ok) {
                        throw new Error(`Metadata request failed (${response.status})`);
                    }
                    const data = await response.json();
                    if (data && !data.error) {
                        this.audioMetadataCache.set(cacheKey, data);
                        return data;
                    }
                    return null;
                } catch (error) {
                    console.warn('⚠️ Failed to fetch existing audio metadata:', error);
                    return null;
                }
            }

            findVoiceCandidate(service, voiceDescriptor, langCode) {
                if (!voiceDescriptor) return null;
                const descriptor = String(voiceDescriptor).trim();
                if (!descriptor) return null;
                const baseLang = langCode && langCode.includes('-') ? langCode.split('-')[0] : langCode;
                const serviceKey = (service || '').toString().toLowerCase();
                let candidates = [];
                if (serviceKey === 'playht') {
                    candidates = this.voices.playht || [];
                } else if (serviceKey === 'elevenlabs') {
                    candidates = this.voices.elevenlabs || [];
                } else {
                    candidates = (this.voices.playht || []).concat(this.voices.elevenlabs || []);
                }

                const normalize = (value) => (value || '').toString().trim();

                const byExactId = candidates.find(v => normalize(v.voice_id) === descriptor);
                if (byExactId) return byExactId;

                const byExactName = candidates.find(v => normalize(v.name) === descriptor);
                if (byExactName) return byExactName;

                if (langCode) {
                    const byLang = candidates.find(v => normalize(v.lang_code) === langCode && normalize(v.name) === descriptor);
                    if (byLang) return byLang;
                    const byBaseLang = candidates.find(v => normalize(v.lang_code) === baseLang && normalize(v.name) === descriptor);
                    if (byBaseLang) return byBaseLang;
                }

                return null;
            }

            async resolveVoiceSelection(langCode, itemId = null, { allowMetadataFallback = false } = {}) {
                const playhtSelect = document.getElementById('playhtVoice');
                const elevenlabsSelect = document.getElementById('elevenlabsVoice');
                const playhtVoiceId = (playhtSelect && playhtSelect.selectedIndex > 0) ? playhtSelect.value : '';
                const playhtVoiceName = (playhtSelect && playhtSelect.selectedIndex > 0) ? playhtSelect.options[playhtSelect.selectedIndex].text : '';
                const elevenlabsVoiceId = (elevenlabsSelect && elevenlabsSelect.selectedIndex > 0) ? elevenlabsSelect.value : '';
                const elevenlabsVoiceName = (elevenlabsSelect && elevenlabsSelect.selectedIndex > 0) ? elevenlabsSelect.options[elevenlabsSelect.selectedIndex].text : '';
                const config = this.getLanguageConfigByCode(langCode);
                let service = null;
                let voiceId = null;
                let voiceName = null;
                let source = 'selection';

                if (playhtVoiceId && elevenlabsVoiceId) {
                    if (config && config.service === 'PlayHT') {
                        service = 'PlayHT';
                        voiceId = playhtVoiceId;
                        voiceName = playhtVoiceName;
                    } else {
                        service = 'ElevenLabs';
                        voiceId = elevenlabsVoiceId;
                        voiceName = elevenlabsVoiceName;
                    }
                } else if (playhtVoiceId) {
                    service = 'PlayHT';
                    voiceId = playhtVoiceId;
                    voiceName = playhtVoiceName;
                } else if (elevenlabsVoiceId) {
                    service = 'ElevenLabs';
                    voiceId = elevenlabsVoiceId;
                    voiceName = elevenlabsVoiceName;
                }

                if (!service && allowMetadataFallback && itemId) {
                    const metadata = await this.fetchExistingAudioMetadata(itemId, langCode);
                    const tags = metadata?.id3Tags || {};
                    const tagService = (tags.service || metadata?.service || '').toString();
                    const tagVoice = tags.voice || metadata?.voice || '';

                    if (tagService || tagVoice) {
                        const normalizedService = tagService.trim() || (config?.service || '');
                        const voiceCandidate = this.findVoiceCandidate(normalizedService, tagVoice, langCode);

                        if (voiceCandidate) {
                            service = normalizedService || (this.voices.playht.includes(voiceCandidate) ? 'PlayHT' : 'ElevenLabs');
                            voiceId = voiceCandidate.voice_id;
                            voiceName = voiceCandidate.name;
                            source = 'metadata';
                        } else if (normalizedService && tagVoice) {
                            service = normalizedService;
                            voiceId = tagVoice;
                            voiceName = tagVoice;
                            source = 'metadata';
                        }

                        if (service && voiceId) {
                            this.setStatus(`Using existing audio voice ${voiceName || voiceId} (${service})`, 'info');
                        }
                    }
                }

                return { service, voiceId, voiceName, source };
            }

            openDeployFolderLink() {
                const bucketName = this.currentDraftBucketName || 'levante-assets-draft';
                const link = this.buildDraftFolderLink('deploy/', bucketName);
                if (link) {
                    window.open(link, '_blank', 'noopener');
                    this.setStatus('Opened deploy folder listing in new tab.', 'success');
                } else {
                    this.setStatus('Unable to open deploy folder link.', 'error');
                }
            }

            async openDraftAudioModal() {
                const modal = document.getElementById('draftAudioModal');
                if (!modal) {
                    window.open('./bucket-info.html', '_blank');
                    return;
                }
                this.bindCopyDraftLinkButton(modal);
                modal.style.display = 'block';
                await this.loadDraftAudioData();
            }

            async loadDraftAudioData() {
                const loadingEl = document.getElementById('draftAudioLoading');
                const bodyEl = document.getElementById('draftAudioBody');
                if (loadingEl) loadingEl.style.display = 'block';
                if (bodyEl) bodyEl.innerHTML = '';
                try {
                    this.setStatus('Loading draft audio files...', 'loading');
                    const response = await fetch('/api/list-draft-audio');
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(errorText || `Request failed (${response.status})`);
                    }
                    const data = await response.json();
                    const items = Array.isArray(data.items) ? data.items : [];
                    const bucketName = data.bucket || 'levante-assets-draft';
                    const prefix = data.prefix || 'audio/';
                    this.currentDraftBucketName = bucketName;
                    this.selectedDraftAudio = null;
                    const availablePaths = new Set(items.map(item => item.path || item.name).filter(Boolean));
                    if (!this.approvedDrafts) {
                        this.approvedDrafts = new Set();
                    } else if (availablePaths.size) {
                        this.approvedDrafts = new Set([...this.approvedDrafts].filter(path => availablePaths.has(path)));
                    }
                    items.forEach((item) => {
                        const path = item.path || item.name;
                        if (item.approvedBySite && path) {
                            this.approvedDrafts.add(path);
                        }
                    });

                    if (bodyEl) {
                        bodyEl.innerHTML = this.buildDraftAudioTable(items, { bucket: bucketName, prefix });
                        const modalEl = document.getElementById('draftAudioModal');
                        this.attachDraftRowHandlers(modalEl, bucketName);
                        this.bindDraftApprovalHandlers(modalEl);
                        const refreshBtn = document.getElementById('refreshDraftAudio');
                        if (refreshBtn) {
                            refreshBtn.addEventListener('click', () => this.loadDraftAudioData());
                        }
                        const deployBtn = document.getElementById('deployDraftAudio');
                        if (deployBtn) {
                            deployBtn.addEventListener('click', () => this.handleDeployDraftAudio());
                        }
                        this.bindCopyDraftLinkButton(modalEl);
                    }
                    this.setStatus(`Loaded ${items.length} draft audio files`, 'success');
                } catch (error) {
                    console.error('Error loading draft audio files', error);
                    if (bodyEl) {
                        bodyEl.innerHTML = `<div class="draft-audio-empty">Failed to load draft audio files: ${error.message}</div>`;
                    }
                    this.setStatus(`❌ Error loading draft audio: ${error.message}`, 'error');
                } finally {
                    if (loadingEl) loadingEl.style.display = 'none';
                }
            }

            buildDraftAudioTable(items = [], meta = {}) {
                if (!items.length) {
                    const bucketName = meta.bucket || 'levante-assets-draft';
                    return `<div class="draft-audio-empty">No audio files found in <code>${bucketName}/audio</code>.</div>`;
                }

                this.selectedDraftAudio = null;
                const bucketName = meta.bucket || 'levante-assets-draft';
                const prefix = meta.prefix || 'audio/';
                const sorted = [...items].sort((a, b) => {
                    const dateA = new Date(a.updated || a.timeCreated || 0).getTime();
                    const dateB = new Date(b.updated || b.timeCreated || 0).getTime();
                    return dateB - dateA;
                });

                const summary = `
                    <div class="draft-audio-summary">
                        <div>
                            <strong>${sorted.length}</strong> files in <code>${bucketName}/${prefix}</code>
                        </div>
                        <div class="draft-actions">
                            <button id="deployDraftAudio" class="btn btn-primary btn-compact">
                                <i class="fas fa-cloud-upload-alt"></i> Deploy
                            </button>
                            <button id="refreshDraftAudio" class="btn btn-secondary btn-compact">
                                <i class="fas fa-sync-alt"></i> Refresh
                            </button>
                        </div>
                    </div>
                `;

                const rows = sorted.map(item => {
                    const language = item.language || (item.name && item.name.split('/')[1]) || '—';
                    const itemId = item.itemId || (item.name ? item.name.replace(/^audio\//, '').replace(/\.mp3$/i, '').split('/').pop() : '—');
                    const versionLabel = item.version ? `v${String(item.version).padStart(3, '0')}` : '—';
                    const rawPath = item.path || item.name;
                    const encodedPath = rawPath ? encodeURIComponent(rawPath) : '';
                    const sizeValue = Number(item.size || item.bytes || 0);
                    const formatSize = (typeof formatFileSize === 'function') ? formatFileSize(sizeValue) : `${sizeValue} bytes`;
                    const updatedRaw = item.updated || item.timeCreated || item.generation;
                    let updatedText = updatedRaw ? updatedRaw : '';
                    if (updatedRaw && typeof formatDate === 'function') {
                        updatedText = formatDate(updatedRaw);
                    } else if (updatedRaw) {
                        updatedText = new Date(updatedRaw).toLocaleString();
                    }
                    const siteApproved = Boolean(item.approvedBySite);
                    const isApproved = rawPath ? this.approvedDrafts?.has(rawPath) : false;
                    const checkedAttr = isApproved ? 'checked' : '';
                    const statusLabel = isApproved ? (siteApproved ? 'Approved' : 'Selected') : 'Pending';
                    const approvalCellClasses = ['draft-approve-cell'];
                    if (isApproved) approvalCellClasses.push('is-active');
                    if (siteApproved) approvalCellClasses.push('is-site-approved');
                    const approvalCellClass = approvalCellClasses.join(' ');
                    return `
                        <tr data-path="${encodedPath}" data-item-id="${itemId}" data-version="${item.version || ''}" data-language="${language}" data-site-approved="${siteApproved ? 'true' : 'false'}">
                            <td>${language}</td>
                            <td><code>${itemId}</code></td>
                            <td>${versionLabel}</td>
                            <td>${formatSize}</td>
                            <td>${updatedText || '—'}</td>
                            <td class="${approvalCellClass}" data-original-site-approved="${siteApproved ? 'true' : 'false'}">
                                <label class="draft-approve-toggle">
                                    <input type="checkbox" class="draft-approve" data-path="${encodedPath}" ${checkedAttr}>
                                    <span class="draft-approve-status${isApproved ? ' is-checked' : ''}">${statusLabel}</span>
                                </label>
                            </td>
                            <td>
                                <button class="btn btn-secondary btn-compact draft-play" data-path="${encodedPath}">
                                    <i class="fas fa-play"></i> Play
                                </button>
                            </td>
                        </tr>
                    `;
                }).join('');

                return `
                    ${summary}
                    <div class="draft-audio-table-wrapper">
                        <table class="draft-audio-table">
                            <thead>
                                <tr>
                                    <th>Language</th>
                                    <th>Item ID</th>
                                    <th>Version</th>
                                    <th>Size</th>
                                    <th>Updated</th>
                                    <th>Approved by Site</th>
                                    <th>Preview</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rows}
                            </tbody>
                        </table>
                    </div>
                `;
            }

            attachDraftRowHandlers(modal, bucketName = 'levante-assets-draft') {
                if (!modal) return;
                const rows = modal.querySelectorAll('.draft-audio-table tbody tr');
                rows.forEach(row => {
                    row.addEventListener('click', (event) => {
                        // Avoid row selection when clicking the play button or checkbox
                        if (event.target.closest('.draft-play') || event.target.closest('.draft-approve')) return;
                        rows.forEach(r => r.classList.remove('selected'));
                        row.classList.add('selected');
                        const decodedPath = row.dataset.path ? decodeURIComponent(row.dataset.path) : '';
                        const folderPath = decodedPath ? (decodedPath.includes('/') ? decodedPath.substring(0, decodedPath.lastIndexOf('/')) : decodedPath) : '';
                        this.selectedDraftAudio = {
                            path: decodedPath,
                            folder: folderPath ? folderPath + '/' : '',
                            itemId: row.dataset.itemId,
                            version: row.dataset.version,
                            language: row.dataset.language,
                            bucketName
                        };
                        const versionLabel = row.dataset.version ? ` (v${String(row.dataset.version).padStart(3, '0')})` : '';
                        this.setStatus(`Selected draft ${row.dataset.itemId}${versionLabel} [${row.dataset.language}]`, 'info');
                    });
                });

                const playButtons = modal.querySelectorAll('.draft-play');
                playButtons.forEach(btn => {
                    btn.addEventListener('click', (event) => {
                        event.stopPropagation();
                        const encoded = btn.dataset.path;
                        const path = encoded ? decodeURIComponent(encoded) : '';
                        if (path) {
                            this.playDraftAudioSample(path, bucketName);
                        } else {
                            this.setStatus('Unable to determine draft audio path for preview', 'warning');
                        }
                    });
                });
            }

            bindDraftApprovalHandlers(modal) {
                if (!modal) return;
                const checkboxes = modal.querySelectorAll('input.draft-approve');
                checkboxes.forEach(checkbox => {
                    checkbox.addEventListener('click', (event) => {
                        event.stopPropagation();
                    });
                    checkbox.addEventListener('change', () => {
                        const encodedPath = checkbox.dataset.path || '';
                        const decodedPath = encodedPath ? decodeURIComponent(encodedPath) : '';
                        if (!decodedPath) return;
                        if (!this.approvedDrafts) {
                            this.approvedDrafts = new Set();
                        }

                        const row = checkbox.closest('tr');
                        const dataset = row && row.dataset ? row.dataset : {};
                        const cell = checkbox.closest('.draft-approve-cell');
                        const statusEl = cell ? cell.querySelector('.draft-approve-status') : null;
                        const originallyApproved = cell?.dataset.originalSiteApproved === 'true';
                        const itemId = dataset.itemId || decodedPath;
                        const language = dataset.language || '';
                        const versionRaw = dataset.version || '';

                        if (checkbox.checked) {
                            this.approvedDrafts.add(decodedPath);
                        } else {
                            this.approvedDrafts.delete(decodedPath);
                        }

                        const versionLabel = versionRaw ? ` (v${String(versionRaw).padStart(3, '0')})` : '';
                        const langLabel = language ? ` [${language}]` : '';
                        const state = checkbox.checked
                            ? (originallyApproved ? 'Confirmed site approval for' : 'Marked site approval for')
                            : 'Cleared site approval for';

                        if (cell) {
                            cell.classList.toggle('is-active', checkbox.checked);
                        }
                        if (statusEl) {
                            statusEl.textContent = checkbox.checked ? (originallyApproved ? 'Approved' : 'Selected') : 'Pending';
                            statusEl.classList.toggle('is-checked', checkbox.checked);
                        }

                        this.setStatus(`${state} ${itemId}${versionLabel}${langLabel}`, checkbox.checked ? 'success' : 'info');
                    });
                });
            }

            async handleDeployDraftAudio() {
                if (this.deployingDrafts) {
                    this.setStatus('Deployment already in progress...', 'info');
                    return;
                }

                const modal = document.getElementById('draftAudioModal');
                if (!modal) {
                    this.setStatus('Draft modal not available for deployment', 'error');
                    return;
                }

                const checkboxes = modal.querySelectorAll('input.draft-approve');
                const selections = [];
                checkboxes.forEach(checkbox => {
                    if (!checkbox.checked) return;
                    const encodedPath = checkbox.dataset.path || '';
                    const path = encodedPath ? decodeURIComponent(encodedPath) : '';
                    if (!path) return;
                    const row = checkbox.closest('tr');
                    const dataset = row && row.dataset ? row.dataset : {};
                    selections.push({
                        bucket: this.currentDraftBucketName || 'levante-assets-draft',
                        path,
                        itemId: dataset.itemId || path,
                        language: dataset.language || '',
                        version: dataset.version || ''
                    });
                });

                if (!selections.length) {
                    this.setStatus('Select at least one site-approved draft before deploying.', 'warning');
                    alert('Please tick the Approved by Site checkbox next to each draft you want to deploy.');
                    return;
                }

                const summary = selections
                    .map(sel => `${sel.bucket}/${sel.path}`)
                    .join('\n');

                const confirmed = window.confirm(`Deploy ${selections.length} draft audio file(s)?\n\n${summary}`);
                if (!confirmed) {
                    this.setStatus('Deployment cancelled.', 'info');
                    return;
                }

                try {
                    this.deployingDrafts = true;
                    this.setStatus(`Deploying ${selections.length} draft audio file(s)...`, 'loading');
                    const payload = {
                        files: selections,
                        bucket: this.currentDraftBucketName || 'levante-assets-draft'
                    };

                    const response = await fetch('/api/deploy-draft-audio', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    const result = await response.json().catch(() => ({}));

                    if (!response.ok || !result.success) {
                        const message = result?.message || result?.error || `HTTP ${response.status}`;
                        throw new Error(message);
                    }

                    const movedCountRaw = Number(result.moved);
                    const movedCount = Number.isFinite(movedCountRaw) ? movedCountRaw : selections.length;
                    const deletedCountRaw = Number(result.deleted);
                    const deletedCount = Number.isFinite(deletedCountRaw) ? deletedCountRaw : 0;
                    const bucketList = Array.isArray(result.buckets) && result.buckets.length ? result.buckets : [this.currentDraftBucketName || 'levante-assets-draft'];

                    const summaryParts = [];
                    summaryParts.push(`Moved ${movedCount} file${movedCount === 1 ? '' : 's'} to deploy folder`);
                    if (deletedCount > 0) {
                        summaryParts.push(`removed ${deletedCount} old version${deletedCount === 1 ? '' : 's'}`);
                    }
                    const summaryMessage = summaryParts.join(', ') || 'Deployment complete';
                    this.setStatus(`${summaryMessage}.`, 'success');

                    const lines = [];
                    lines.push(summaryMessage + '.');
                    lines.push(`Bucket: ${bucketList.join(', ')}`);

                    if (Array.isArray(result.results) && result.results.length) {
                        const preview = result.results
                            .slice(0, Math.min(result.results.length, 3))
                            .map(item => {
                                const lang = item.language || 'lang';
                                const dest = item.destination || item.source || '';
                                return `${lang}: ${dest}`;
                            });
                        if (preview.length) {
                            lines.push('\nExamples:');
                            lines.push(preview.join('\n'));
                        }
                    }

                    alert(lines.join('\n'));
                    selections.forEach(sel => this.approvedDrafts.delete(sel.path));
                    await this.loadDraftAudioData();
                } catch (error) {
                    console.error('Error deploying draft audio', error);
                    this.setStatus(`❌ Deployment failed: ${error.message}`, 'error');
                    alert(`Failed to deploy draft audio: ${error.message}`);
                } finally {
                    this.deployingDrafts = false;
                }
            }

            buildDraftDeployCommitMessage(selections = []) {
                if (!Array.isArray(selections) || selections.length === 0) {
                    return 'Deploy draft audio from dashboard';
                }
                const samples = selections.slice(0, 3).map(sel => {
                    const lang = sel.language || 'lang';
                    const item = sel.itemId || sel.path || 'item';
                    return `${lang}:${item}`;
                });
                const suffix = selections.length > 3 ? ` +${selections.length - 3} more` : '';
                return `Deploy draft audio: ${samples.join(', ')}${suffix}`;
            }

            async playDraftAudioSample(path, bucketName = 'levante-assets-draft') {
                if (!path) {
                    this.setStatus('No audio path provided for preview', 'warning');
                    return;
                }
                try {
                    const params = new URLSearchParams({
                        bucket: bucketName,
                        path
                    });
                    this.setStatus(`Loading draft audio preview...`, 'loading');
                    const response = await fetch(`/api/get-draft-audio?${params.toString()}`);
                    if (!response.ok) {
                        const text = await response.text();
                        throw new Error(text || `HTTP ${response.status}`);
                    }
                    const blob = await response.blob();
                    const url = URL.createObjectURL(blob);
                    const audio = new Audio(url);
                    audio.addEventListener('ended', () => URL.revokeObjectURL(url));
                    audio.addEventListener('error', () => URL.revokeObjectURL(url));
                    await audio.play();
                    this.setStatus(`Playing draft audio preview (${path})`, 'success');
                } catch (error) {
                    console.error('Error playing draft audio preview', error);
                    this.setStatus(`❌ Could not preview draft audio: ${error.message}`, 'error');
                }
            }

            extractTextForItem(item, langCode) {
                if (!item) return '';
                let text = item[langCode];
                if (!text && langCode.includes('-')) {
                    const base = langCode.split('-')[0];
                    text = item[base];
                }
                if (!text) {
                    const keys = Object.keys(item);
                    const match = keys.find(k => k.toLowerCase() === langCode.toLowerCase());
                    text = match ? item[match] : null;
                }
                return text || item.en || '';
            }

            async regenerateAudioForItem(itemId, langCode) {
                const item = this.data.find(entry => entry.item_id === itemId);
                if (!item) {
                    const message = `Item ${itemId} not found in current dataset`;
                    this.setStatus(`❌ ${message}`, 'error');
                    alert(message);
                    return;
                }

                const text = this.extractTextForItem(item, langCode);
                if (!text) {
                    const message = `No translation text available for ${itemId} (${langCode})`;
                    this.setStatus(`❌ ${message}`, 'error');
                    alert(message);
                    return;
                }

                const { service, voiceId, voiceName, source } = await this.resolveVoiceSelection(langCode, itemId, { allowMetadataFallback: true });
                if (!service || !voiceId) {
                    const message = 'Please select a voice before regenerating audio.';
                    this.setStatus(`⚠️ ${message}`, 'warning');
                    alert(message);
                    return;
                }

                try {
                    const originLabel = source === 'metadata' ? 'existing audio' : 'selection';
                    this.setStatus(`Generating ${itemId} with ${service} (${originLabel})...`, 'loading');
                    const options = {
                        itemId,
                        langCode,
                        voiceName,
                        text,
                        itemLabel: item.labels || item.task || '',
                        source: 'regenerate'
                    };
                    if (service === 'PlayHT') {
                        await this.generatePlayHTAudio(text, voiceId, options);
                    } else {
                        await this.generateElevenLabsAudio(text, voiceId, options);
                    }
                } catch (error) {
                    console.error('Error regenerating audio', error);
                    this.setStatus(`❌ Error regenerating ${itemId}: ${error.message}`, 'error');
                    alert(`Failed to regenerate audio for ${itemId}: ${error.message}`);
                }
            }

            async saveGeneratedAudioDraft(itemId, langCode) {
                if (!this.latestGeneratedAudio) {
                    const message = 'No generated audio found. Please re-generate audio before saving.';
                    this.setStatus(`⚠️ ${message}`, 'warning');
                    alert(message);
                    return;
                }

                if (this.latestGeneratedAudio.itemId !== itemId || this.latestGeneratedAudio.langCode !== langCode) {
                    const message = 'The most recent generated audio does not match this item/language. Please re-generate before saving.';
                    this.setStatus(`⚠️ ${message}`, 'warning');
                    alert(message);
                    return;
                }

                const payload = {
                    audioBase64: this.latestGeneratedAudio.audioBase64,
                    langCode,
                    itemId,
                    bucket: 'levante-assets-draft',
                    versioning: true,
                    tags: {
                        title: itemId,
                        artist: `Levante Framework - ${this.latestGeneratedAudio.service}`,
                        album: this.latestGeneratedAudio.itemLabel || langCode,
                        genre: 'Speech Synthesis',
                        comment: `Levante Project - ${this.latestGeneratedAudio.service} - ${this.latestGeneratedAudio.voiceName || this.latestGeneratedAudio.voiceId} - ${langCode}`,
                        service: this.latestGeneratedAudio.service,
                        voice: this.latestGeneratedAudio.voiceName || this.latestGeneratedAudio.voiceId,
                        lang_code: langCode,
                        text: this.latestGeneratedAudio.text || '',
                        created: this.latestGeneratedAudio.generatedAt,
                        copyright: this.audioCopyright,
                        source: 'patch'
                    }
                };

                try {
                    this.setStatus(`Uploading ${itemId} to draft bucket...`, 'loading');
                    const response = await fetch('/api/save-audio', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    const result = await response.json();
                    if (!response.ok || !result.success) {
                        const message = result?.message || 'Unknown upload error';
                        throw new Error(message);
                    }
                    const versionSuffix = result.version ? ` (v${String(result.version).padStart(3, '0')})` : '';
                    this.setStatus(`Saved ${itemId}${versionSuffix} to ${result.bucket}/${result.path}`, 'success');
                    alert(`Audio saved to ${result.bucket}/${result.path}`);
                    this.pendingSaveKey = null;
                    this.latestGeneratedAudio = null;
                    this.updateSaveButtonState(itemId, langCode);
                } catch (error) {
                    console.error('Error saving generated audio', error);
                    this.setStatus(`❌ Error saving audio: ${error.message}`, 'error');
                    alert(`Failed to save audio: ${error.message}`);
                }
            }

            async recordGeneratedAudio(audioBlob, metadata) {
                if (!audioBlob) return;
                try {
                    const audioBase64 = await this.convertBlobToBase64(audioBlob);
                    this.latestGeneratedAudio = {
                        audioBlob,
                        audioBase64,
                        service: metadata.service,
                        voiceId: metadata.voiceId,
                        voiceName: metadata.voiceName || metadata.voiceId,
                        langCode: metadata.langCode || (this.languages[this.currentLanguage]?.lang_code || ''),
                        itemId: metadata.itemId || null,
                        itemLabel: metadata.itemLabel || '',
                        text: metadata.text || '',
                        source: metadata.source || 'unknown',
                        generatedAt: new Date().toISOString()
                    };

                    if (this.latestGeneratedAudio.itemId && this.latestGeneratedAudio.langCode) {
                        const cacheKey = `${this.latestGeneratedAudio.langCode}::${this.latestGeneratedAudio.itemId}`;
                        if (!this.audioMetadataCache) {
                            this.audioMetadataCache = new Map();
                        }
                        this.audioMetadataCache.set(cacheKey, {
                            id3Tags: {
                                service: this.latestGeneratedAudio.service,
                                voice: this.latestGeneratedAudio.voiceName,
                                text: this.latestGeneratedAudio.text,
                                created: this.latestGeneratedAudio.generatedAt
                            }
                        });
                        this.pendingSaveKey = cacheKey;
                        this.updateSaveButtonState(this.latestGeneratedAudio.itemId, this.latestGeneratedAudio.langCode);
                    }
                } catch (error) {
                    console.error('Failed to cache generated audio', error);
                    this.latestGeneratedAudio = null;
                    this.pendingSaveKey = null;
                }
            }

            convertBlobToBase64(blob) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = () => reject(new Error('Failed to convert audio to base64'));
                    reader.readAsDataURL(blob);
                });
            }

            async generateAudioFromText() {
                const textInput = document.getElementById('textInput');
                const text = textInput.value.trim();
                
                if (!text) {
                    alert('Please enter some text to generate audio.');
                    return;
                }
                
                const langCode = this.languages[this.currentLanguage].lang_code;
                const { service: selectedService, voiceId: selectedVoice, voiceName } = await this.resolveVoiceSelection(langCode, null, { allowMetadataFallback: false });
                
                if (!selectedService || !selectedVoice) {
                    alert('Please select a voice from either PlayHT or ElevenLabs to generate audio.');
                    this.setStatus('⚠️ Select a voice before generating audio', 'warning');
                    return;
                }
                
                this.setStatus(`Generating audio with ${selectedService}...`, 'loading');
                
                try {
                    const options = {
                        langCode,
                        voiceName,
                        text,
                        source: 'text-input'
                    };
                    if (selectedService === 'PlayHT') {
                        await this.generatePlayHTAudio(text, selectedVoice, options);
                    } else if (selectedService === 'ElevenLabs') {
                        await this.generateElevenLabsAudio(text, selectedVoice, options);
                    }
                } catch (error) {
                    console.error('Audio generation error:', error);
                    this.setStatus(`Error generating audio: ${error.message}`, 'error');
                    alert(`Failed to generate audio: ${error.message}`);
                }
            }
            
            async generatePlayHTAudio(text, voiceId, options = {}) {
                const credentials = getCredentials();
                const playhtKey = credentials.playht_api_key || credentials.playhtApiKey;
                const playhtUser = credentials.playht_user_id || credentials.playhtUserId;
                if (!playhtKey || !playhtUser) {
                    throw new Error('PlayHT credentials not found. Please add them in the credentials manager.');
                }
                
                const requestData = {
                    text: text,
                    voice: voiceId,
                    quality: 'medium',
                    output_format: 'mp3',
                    speed: 1,
                    sample_rate: 24000
                };
                
                console.log('Calling PlayHT API with:', requestData);
                
                const response = await fetch('/api/playht-proxy', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'AUTHORIZATION': playhtKey,
                        'X-USER-ID': playhtUser
                    },
                    body: JSON.stringify(requestData)
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`PlayHT API error: ${response.status} - ${errorText}`);
                }
                
                // Get the audio blob
                const audioBlob = await response.blob();
                await this.recordGeneratedAudio(audioBlob, {
                    service: 'PlayHT',
                    voiceId,
                    voiceName: options.voiceName,
                    langCode: options.langCode,
                    itemId: options.itemId,
                    itemLabel: options.itemLabel,
                    text,
                    source: options.source
                });
                const audioUrl = URL.createObjectURL(audioBlob);
                
                this.setStatus('Audio generated successfully! Playing now...', 'success');
                
                // Play the generated audio
                const audio = new Audio(audioUrl);
                audio.addEventListener('canplaythrough', () => {
                    audio.play();
                    this.setStatus('Playing generated audio...', 'success');
                });
                audio.addEventListener('ended', () => {
                    this.setStatus('Audio playback completed.', 'success');
                    // Clean up the blob URL
                    URL.revokeObjectURL(audioUrl);
                });
                audio.addEventListener('error', (e) => {
                    console.error('Audio playback error:', e);
                    this.setStatus('Error playing generated audio.', 'error');
                    URL.revokeObjectURL(audioUrl);
                });
            }
            
            async generateElevenLabsAudio(text, voiceId, options = {}) {
                const credentials = getCredentials();
                const elevenKey = credentials.elevenlabs_api_key || credentials.elevenlabsApiKey;
                if (!elevenKey) {
                    throw new Error('ElevenLabs API key not found. Please add it in the credentials manager.');
                }
                
                const requestData = {
                    text: text,
                    model_id: "eleven_multilingual_v2",
                    output_format: "mp3_22050_32"
                };
                
                console.log('Calling ElevenLabs API with:', requestData);
                
                const response = await fetch(`/api/elevenlabs-proxy?voice_id=${voiceId}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-KEY': elevenKey
                    },
                    body: JSON.stringify(requestData)
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
                }
                
                // Get the audio blob
                const audioBlob = await response.blob();
                await this.recordGeneratedAudio(audioBlob, {
                    service: 'ElevenLabs',
                    voiceId,
                    voiceName: options.voiceName,
                    langCode: options.langCode,
                    itemId: options.itemId,
                    itemLabel: options.itemLabel,
                    text,
                    source: options.source
                });
                const audioUrl = URL.createObjectURL(audioBlob);
                
                this.setStatus('Audio generated successfully! Playing now...', 'success');
                
                // Play the generated audio
                const audio = new Audio(audioUrl);
                audio.addEventListener('canplaythrough', () => {
                    audio.play();
                    this.setStatus('Playing generated audio...', 'success');
                });
                audio.addEventListener('ended', () => {
                    this.setStatus('Audio playback completed.', 'success');
                    // Clean up the blob URL
                    URL.revokeObjectURL(audioUrl);
                });
                audio.addEventListener('error', (e) => {
                    console.error('Audio playback error:', e);
                    this.setStatus('Error playing generated audio.', 'error');
                    URL.revokeObjectURL(audioUrl);
                });
            }
            
            populateSelectedText() {
                if (!this.selectedRow) {
                    alert('Please select an item from the table first.');
                    return;
                }
                
                const langCode = this.languages[this.currentLanguage].lang_code;
                const text = this.selectedRow[langCode] || this.selectedRow.en || 'No translation available';
                
                document.getElementById('textInput').value = text;
                this.setStatus(`Text populated from selected item: ${this.selectedRow.item_id}`, 'success');
            }

            setStatus(message, type = 'success') {
                const statusBar = document.getElementById('statusBar');
                const statusIcon = statusBar.querySelector('.status-icon');
                const statusContent = statusBar.querySelector('span');
                
                // Update icon based on type
                statusIcon.className = `fas fa-circle status-icon ${type}`;
                
                if (statusContent) {
                    statusContent.textContent = message;
                }
            }

            showButtonFeedback(button, text, variant = 'success', iconClass = 'fa-check', duration = 2000) {
                if (!button) return;
                const originalHtml = button.dataset.originalHtml || button.innerHTML;
                if (!button.dataset.originalHtml) {
                    button.dataset.originalHtml = originalHtml;
                }

                const timeoutIdRaw = (button.dataset.feedbackTimeout && button.dataset.feedbackTimeout !== '')
                    ? Number(button.dataset.feedbackTimeout)
                    : null;
                if (timeoutIdRaw !== null && !Number.isNaN(timeoutIdRaw)) {
                    clearTimeout(timeoutIdRaw);
                }

                button.classList.remove('btn-feedback-success', 'btn-feedback-error', 'btn-feedback-warning');
                if (variant) {
                    button.classList.add(`btn-feedback-${variant}`);
                }

                const iconHtml = iconClass ? `<i class="fas ${iconClass}"></i> ` : '';
                button.innerHTML = `${iconHtml}${text}`;

                const timeoutId = window.setTimeout(() => {
                    button.innerHTML = button.dataset.originalHtml || originalHtml;
                    button.classList.remove('btn-feedback-success', 'btn-feedback-error', 'btn-feedback-warning');
                    delete button.dataset.feedbackTimeout;
                }, duration);

                button.dataset.feedbackTimeout = String(timeoutId);
            }

            updateSaveButtonState(itemId, langCode) {
                if (!itemId || !langCode) return;
                const pendingKey = this.pendingSaveKey;
                const targetKey = `${langCode}::${itemId}`;
                const shouldEnable = Boolean(
                    pendingKey &&
                    pendingKey === targetKey &&
                    this.latestGeneratedAudio &&
                    this.latestGeneratedAudio.itemId === itemId &&
                    this.latestGeneratedAudio.langCode === langCode
                );

                const buttons = Array.from(document.querySelectorAll('.save-btn[data-item-id][data-lang-code]'));
                buttons.forEach((btn) => {
                    if (btn.dataset.itemId === itemId && btn.dataset.langCode === langCode) {
                        btn.disabled = !shouldEnable;
                        btn.title = shouldEnable
                            ? 'Save latest generated audio to draft bucket'
                            : 'Generate audio before saving';
                    }
                });
            }
        }

        // All other functions moved to modular JS files:
        // - js/utils.js (getCredentials, formatFileSize, etc.)
        // - js/credentials.js (modal functions)
        // - js/validation.js (validateSingle, validateAll, etc.)
        // - js/audio.js (playAudio, showAudioInfo, etc.)
        // - js/language-config.js (Vue config modal)
        // - js/bootstrap.js (initialization)

        // Make Dashboard class available globally for bootstrap
        window.Dashboard = Dashboard;
