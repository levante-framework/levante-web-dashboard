function openLanguageConfigModal() {
    document.getElementById('languageConfigModal').style.display = 'block';
}
function closeLanguageConfigModal() {
    document.getElementById('languageConfigModal').style.display = 'none';
}
function initLanguageConfigApp() {
    // Check if the Vue app mount point exists
    const mountPoint = document.getElementById('language-config-app');
    if (!mountPoint) {
        console.warn('Language config app mount point not found, skipping Vue initialization');
        return;
    }
    
    const { createApp, reactive } = Vue;
    const app = createApp({
        data() {
            return {
                loading: true,
                saving: false,
                config: reactive({ languages: JSON.parse(JSON.stringify(window.CONFIG?.languages || {})) }),
                renameBuffer: {}
            };
        },
        mounted() { this.load(); },
        methods: {
            async load() {
                this.loading = true;
                try {
                    const resp = await fetch('/api/language-config');
                    const data = await resp.json();
                    if (data && data.languages) {
                        this.config.languages = data.languages;
                    }
                } catch (e) { /* ignore; fallback to local */ }
                finally { this.loading = false; }
            },
            async saveConfig() {
                this.saving = true;
                try {
                    const body = { languages: this.config.languages, metadata: { source: 'web-dashboard' } };
                    const resp = await fetch('/api/language-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                    if (!resp.ok) throw new Error(await resp.text());
                    window.CONFIG = window.CONFIG || {};
                    window.CONFIG.languages = JSON.parse(JSON.stringify(this.config.languages));
                    if (window.dashboard) {
                        window.dashboard.languages = window.CONFIG.languages;
                        document.getElementById('tabButtons').innerHTML = '';
                        document.getElementById('tabContent').innerHTML = '';
                        window.dashboard.createTabs();
                        window.dashboard.populateVoices();
                    }
                    alert('Saved language configuration.');
                    closeLanguageConfigModal();
                } catch (e) {
                    alert(`Failed to save: ${e.message}`);
                } finally { this.saving = false; }
            }
        }
    });
    app.mount('#language-config-app');
}
