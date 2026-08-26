// Global function declarations
declare function loadCredentials(): void;
declare function closeCredentialsModal(): void;
declare function closeAudioInfoModal(): void;
declare function initLanguageConfigApp(): void;

// Language configuration API response type
interface LanguageConfigResponse {
    languages?: Record<string, any>;
    [key: string]: any;
}

function normalizeLanguageDisplayNamesBootstrap(languages: Record<string, any> | undefined): Record<string, any> {
    const input = languages && typeof languages === 'object' ? languages : {};
    const normalized: Record<string, any> = {};
    Object.entries(input).forEach(([name, cfgRaw]) => {
        const cfg = cfgRaw && typeof cfgRaw === 'object' ? { ...cfgRaw } : {};
        const langCode = String(cfg.lang_code || '').trim().toLowerCase();
        let nextName = String(name || '').trim();
        if (langCode === 'es-co' && (/^spanish$/i.test(nextName) || /spanish\s*\(colombia\)/i.test(nextName))) nextName = 'Spanish (Colombia)';
        if (langCode === 'es-ar' && /^spanish$/i.test(nextName)) nextName = 'Spanish (Argentina)';
        if (!cfg.display_name) cfg.display_name = nextName;
        if (langCode === 'es-co' && (/^spanish$/i.test(String(cfg.display_name)) || /spanish\s*\(colombia\)/i.test(String(cfg.display_name)))) cfg.display_name = 'Spanish (Colombia)';
        if (langCode === 'es-ar' && /^spanish$/i.test(String(cfg.display_name))) cfg.display_name = 'Spanish (Argentina)';
        // Migrate legacy default voice for Spanish (Argentina) to current Melody voice.
        if (langCode === 'es-ar' && /(malena|melania)\s+tango|sophia|melanie/i.test(String(cfg.voice || ''))) {
            cfg.voice = 'Melody - Ecommerce Voice';
            cfg.voice_id = 'bN1bDXgDIGX5lw0rtY2B';
        }
        normalized[nextName] = cfg;
    });
    return normalized;
}

function languageSignature(languages: Record<string, any> | undefined): string {
    if (!languages || typeof languages !== 'object') return '';
    const keys = Object.keys(languages).sort();
    return JSON.stringify(keys.map((name) => {
        const cfg = languages[name] || {};
        return {
            name,
            lang_code: String(cfg.lang_code || ''),
            service: String(cfg.service || ''),
            voice: String(cfg.voice || ''),
            display_name: String(cfg.display_name || '')
        };
    }));
}

/**
 * Initializes the dashboard after DOM content is loaded
 */
document.addEventListener('DOMContentLoaded', (): void => {
    const windowAny = window as any;
    windowAny.LANGUAGE_CONFIG_REMOTE_STATUS = 'pending';

    /**
     * Waits for modals to load before initializing credentials and language config
     */
    function initializeAfterModals(): void {
        const credentialsModal = document.getElementById('credentialsModal');
        if (credentialsModal) {
            loadCredentials();
            
            // Initialize language config app
            initLanguageConfigApp();
        } else {
            // Retry in 50ms if modals aren't loaded yet
            setTimeout(initializeAfterModals, 50);
        }
    }

    // Load remote language config BEFORE creating the dashboard instance,
    // so fallback defaults do not overwrite latest saved config.
    loadRemoteLanguagesIntoConfig()
        .finally(() => {
            const DashboardClass = (window as any).Dashboard;
            if (DashboardClass) {
                window.dashboard = new DashboardClass();
            } else {
                console.error('Dashboard class not found');
            }
            // Start initialization after a brief delay
            setTimeout(initializeAfterModals, 100);
        });
});

/**
 * Loads remote language configuration from the API
 */
async function loadRemoteLanguagesIntoConfig(): Promise<void> {
    const windowAny = window as any;
    try {
        const response = await fetch(`/api/language-config?ts=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) {
            console.log('No remote language_config.json found; using local config.js');
            windowAny.LANGUAGE_CONFIG_REMOTE_STATUS = 'failed';
            return;
        }
        
        const data: LanguageConfigResponse = await response.json();
        
        if (data && data.languages && typeof data.languages === 'object') {
            windowAny.CONFIG = windowAny.CONFIG || {};
            const previousLanguages = windowAny.CONFIG.languages as Record<string, any> | undefined;
            const previousSignature = languageSignature(previousLanguages);
            windowAny.CONFIG.languages = normalizeLanguageDisplayNamesBootstrap(data.languages);
            const nextSignature = languageSignature(windowAny.CONFIG.languages as Record<string, any>);
            windowAny.LANGUAGE_CONFIG_REMOTE_STATUS = 'loaded';
            console.log('Loaded languages from remote language_config.json');
            // If dashboard exists, refresh language-dependent UI
            const winAny = window as any;
            if (winAny.dashboard && previousSignature !== nextSignature) {
                winAny.dashboard.languages = winAny.CONFIG.languages;
                if (typeof winAny.dashboard.populateLanguageDropdown === 'function') {
                    winAny.dashboard.populateLanguageDropdown();
                    if (winAny.dashboard.currentLanguage) {
                        winAny.dashboard.populateDataTable();
                    }
                } else {
                    if (document.getElementById('tabButtons')) {
                        (document.getElementById('tabButtons') as HTMLElement).innerHTML = '';
                    }
                    if (document.getElementById('tabContent')) {
                        (document.getElementById('tabContent') as HTMLElement).innerHTML = '';
                    }
                    if (typeof winAny.dashboard.createTabs === 'function') {
                        winAny.dashboard.createTabs();
                    }
                    if (typeof winAny.dashboard.populateVoices === 'function') {
                        winAny.dashboard.populateVoices();
                    }
                }
            } else if (winAny.dashboard) {
                console.log('Remote language config matches current language UI; skipping refresh');
            }
        } else {
            console.log('Invalid language config format; using local config.js');
            windowAny.LANGUAGE_CONFIG_REMOTE_STATUS = 'invalid';
        }
    } catch (error) {
        console.log('Failed to load remote language_config.json; using local config.js');
        windowAny.LANGUAGE_CONFIG_REMOTE_STATUS = 'failed';
    }
}

/**
 * Global click handler to close modals when clicking outside them
 */
window.onclick = function(event: MouseEvent): void {
    const target = event.target as Element | null;
    if (!target) return;
    
    const credentialsModal = document.getElementById('credentialsModal');
    const audioInfoModal = document.getElementById('audioInfoModal');
    
    if (target === credentialsModal) {
        closeCredentialsModal();
    } else if (target === audioInfoModal) {
        closeAudioInfoModal();
    }
};

// Function is globally available - no exports needed in non-module mode
