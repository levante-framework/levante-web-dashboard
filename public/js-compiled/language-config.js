"use strict";
/**
 * Opens the language configuration modal
 */
function openLanguageConfigModal() {
    const modal = document.getElementById('languageConfigModal');
    if (modal) {
        modal.style.display = 'block';
    }
    else {
        console.error('Language config modal not found');
    }
}
/**
 * Closes the language configuration modal
 */
function closeLanguageConfigModal() {
    const modal = document.getElementById('languageConfigModal');
    if (modal) {
        modal.style.display = 'none';
    }
    else {
        console.error('Language config modal not found');
    }
}
function normalizeLanguageDisplayNamesConfig(languages) {
    const input = languages && typeof languages === 'object' ? languages : {};
    const normalized = {};
    Object.entries(input).forEach(([name, cfgRaw]) => {
        const cfg = cfgRaw && typeof cfgRaw === 'object' ? { ...cfgRaw } : {};
        const langCode = String(cfg.lang_code || '').trim().toLowerCase();
        let nextName = String(name || '').trim();
        if (langCode === 'es-co' && (/^spanish$/i.test(nextName) || /spanish\s*\(colombia\)/i.test(nextName)))
            nextName = 'Spanish (Colombia)';
        if (langCode === 'es-ar' && /^spanish$/i.test(nextName))
            nextName = 'Spanish (Argentina)';
        if ((langCode === 'en' || langCode === 'en-us') && /^english$/i.test(nextName))
            nextName = 'English (United States)';
        if ((langCode === 'de' || langCode === 'de-de') && /^german$/i.test(nextName))
            nextName = 'German (Germany)';
        if (!cfg.display_name)
            cfg.display_name = nextName;
        if (langCode === 'es-co' && (/^spanish$/i.test(String(cfg.display_name)) || /spanish\s*\(colombia\)/i.test(String(cfg.display_name))))
            cfg.display_name = 'Spanish (Colombia)';
        if (langCode === 'es-ar' && /^spanish$/i.test(String(cfg.display_name)))
            cfg.display_name = 'Spanish (Argentina)';
        if ((langCode === 'en' || langCode === 'en-us') && /^english$/i.test(String(cfg.display_name)))
            cfg.display_name = 'English (United States)';
        if ((langCode === 'de' || langCode === 'de-de') && /^german$/i.test(String(cfg.display_name)))
            cfg.display_name = 'German (Germany)';
        // Migrate legacy default voice for Spanish (Argentina) to current Melody voice.
        if (langCode === 'es-ar' && /(malena|melania)\s+tango|sophia|melanie/i.test(String(cfg.voice || ''))) {
            cfg.voice = 'Melody - Ecommerce Voice';
            cfg.voice_id = 'bN1bDXgDIGX5lw0rtY2B';
        }
        normalized[nextName] = cfg;
    });
    return normalized;
}
/**
 * Initializes the Vue.js language configuration app
 * Uses dynamic typing to avoid Vue type complexity
 */
function initLanguageConfigApp() {
    // Check if the Vue app mount point exists
    const mountPoint = document.getElementById('language-config-app');
    if (!mountPoint) {
        console.warn('Language config app mount point not found, skipping Vue initialization');
        return;
    }
    // Check if Vue is available
    const Vue = window.Vue;
    if (!Vue) {
        console.error('Vue.js not loaded, cannot initialize language config app');
        return;
    }
    const { createApp, reactive } = Vue;
    // Create Vue app with proper typing by using 'any' for component methods
    const app = createApp({
        data() {
            return {
                loading: true,
                saving: false,
                loadedFromRemote: false,
                config: reactive({
                    languages: JSON.parse(JSON.stringify(window.CONFIG?.languages || {}))
                }),
                renameBuffer: {},
                newLang: {
                    name: '',
                    lang_code: '',
                    service: 'ElevenLabs',
                    voice: '',
                    approver1_userid: '',
                    approver1_password: '',
                    approver2_userid: '',
                    approver2_password: ''
                }
            };
        },
        mounted() {
            this.load();
        },
        methods: {
            /**
             * Loads language configuration from the API
             */
            async load() {
                const self = this;
                self.loading = true;
                try {
                    const response = await fetch(`/api/language-config?ts=${Date.now()}`, { cache: 'no-store' });
                    if (response.ok) {
                        const data = await response.json();
                        if (data && data.languages) {
                            self.config.languages = normalizeLanguageDisplayNamesConfig(data.languages);
                            self.loadedFromRemote = true;
                            return;
                        }
                    }
                    self.loadedFromRemote = false;
                }
                catch (error) {
                    console.warn('Failed to load remote language config, using local fallback:', error);
                    self.loadedFromRemote = false;
                }
                finally {
                    self.loading = false;
                }
            },
            /**
             * Saves the language configuration to the API
             */
            async saveConfig() {
                const self = this;
                self.saving = true;
                try {
                    if (!self.loadedFromRemote) {
                        throw new Error('Remote language config was not loaded. Save blocked to avoid overwriting latest bucket config with local fallback defaults.');
                    }
                    self.config.languages = normalizeLanguageDisplayNamesConfig(self.config.languages);
                    const requestData = {
                        languages: self.config.languages,
                        metadata: { source: 'web-dashboard' }
                    };
                    const response = await fetch('/api/language-config', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(requestData)
                    });
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(errorText || `HTTP ${response.status}`);
                    }
                    // Update global CONFIG
                    const windowAny = window;
                    windowAny.CONFIG = windowAny.CONFIG || {};
                    windowAny.CONFIG.languages = JSON.parse(JSON.stringify(self.config.languages));
                    // Update dashboard if it exists
                    if (windowAny.dashboard) {
                        windowAny.dashboard.languages = windowAny.CONFIG.languages;
                        // Clear and recreate tabs
                        const tabButtons = document.getElementById('tabButtons');
                        const tabContent = document.getElementById('tabContent');
                        if (tabButtons)
                            tabButtons.innerHTML = '';
                        if (tabContent)
                            tabContent.innerHTML = '';
                        // Recreate dashboard components
                        windowAny.dashboard.createTabs();
                        windowAny.dashboard.populateVoices();
                    }
                    alert('Saved language configuration.');
                    closeLanguageConfigModal();
                }
                catch (error) {
                    const errorMessage = error?.message || 'Unknown error';
                    console.error('Failed to save language config:', error);
                    alert(`Failed to save: ${errorMessage}`);
                }
                finally {
                    self.saving = false;
                }
            },
            addLanguage() {
                const self = this;
                const name = (self.newLang.name || '').trim();
                if (!name) {
                    alert('Please enter a language display name');
                    return;
                }
                if (!self.newLang.lang_code) {
                    alert('Please enter a language code (e.g., es-AR)');
                    return;
                }
                if (!self.newLang.voice) {
                    alert('Please enter a default voice');
                    return;
                }
                if (self.config.languages[name]) {
                    alert('A language with this name already exists');
                    return;
                }
                self.config.languages[name] = {
                    lang_code: self.newLang.lang_code,
                    service: self.newLang.service,
                    voice: self.newLang.voice,
                    approver1_userid: self.newLang.approver1_userid,
                    approver1_password: self.newLang.approver1_password,
                    approver2_userid: self.newLang.approver2_userid,
                    approver2_password: self.newLang.approver2_password,
                    display_name: name // Use the display name as entered
                };
                // clear form
                self.newLang = {
                    name: '',
                    lang_code: '',
                    service: 'ElevenLabs',
                    voice: '',
                    approver1_userid: '',
                    approver1_password: '',
                    approver2_userid: '',
                    approver2_password: ''
                };
            },
            removeLanguage(name) {
                const self = this;
                if (!name)
                    return;
                if (!self.config.languages[name])
                    return;
                if (!confirm(`Remove language "${name}"?`))
                    return;
                delete self.config.languages[name];
            }
        }
    });
    try {
        app.mount('#language-config-app');
        console.log('Language config Vue app mounted successfully');
    }
    catch (error) {
        console.error('Failed to mount language config Vue app:', error);
    }
}
// Functions are globally available - no exports needed in non-module mode
//# sourceMappingURL=language-config.js.map