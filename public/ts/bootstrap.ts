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

/**
 * Initializes the dashboard after DOM content is loaded
 */
document.addEventListener('DOMContentLoaded', (): void => {
    // Create the global dashboard instance using the global class
    const DashboardClass = (window as any).Dashboard;
    if (DashboardClass) {
        window.dashboard = new DashboardClass();
    } else {
        console.error('Dashboard class not found');
    }
    
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
    
    // Start initialization after a brief delay
    setTimeout(initializeAfterModals, 100);
});

/**
 * Loads remote language configuration from the API
 */
async function loadRemoteLanguagesIntoConfig(): Promise<void> {
    try {
        const response = await fetch(`/api/language-config?ts=${Date.now()}`);
        if (!response.ok) {
            console.log('No remote language_config.json found; using local config.js');
            return;
        }
        
        const data: LanguageConfigResponse = await response.json();
        
        if (data && data.languages && typeof data.languages === 'object') {
            const windowAny = window as any;
            windowAny.CONFIG = windowAny.CONFIG || {};
            windowAny.CONFIG.languages = data.languages;
            console.log('Loaded languages from remote language_config.json');
            // If dashboard exists, refresh language-dependent UI
            const winAny = window as any;
            if (winAny.dashboard) {
                winAny.dashboard.languages = winAny.CONFIG.languages;
                if (document.getElementById('tabButtons')) {
                    (document.getElementById('tabButtons') as HTMLElement).innerHTML = '';
                }
                if (document.getElementById('tabContent')) {
                    (document.getElementById('tabContent') as HTMLElement).innerHTML = '';
                }
                winAny.dashboard.createTabs();
                winAny.dashboard.populateVoices();
            }
        } else {
            console.log('Invalid language config format; using local config.js');
        }
    } catch (error) {
        console.log('Failed to load remote language_config.json; using local config.js');
    }
}

// Load remote configuration immediately
loadRemoteLanguagesIntoConfig();

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
