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
                config: reactive({
                    languages: JSON.parse(JSON.stringify(window.CONFIG?.languages || {}))
                }),
                renameBuffer: {},
                newLang: {
                    name: '',
                    lang_code: '',
                    service: 'ElevenLabs',
                    voice: ''
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
                    const response = await fetch('/api/language-config');
                    if (response.ok) {
                        const data = await response.json();
                        if (data && data.languages) {
                            self.config.languages = data.languages;
                        }
                    }
                }
                catch (error) {
                    console.warn('Failed to load remote language config, using local fallback:', error);
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
                    display_name: name // Use the display name as entered
                };
                // clear form
                self.newLang = { name: '', lang_code: '', service: 'ElevenLabs', voice: '' };
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