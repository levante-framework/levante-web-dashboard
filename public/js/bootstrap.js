document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new Dashboard();
    
    // Wait for modals to load before initializing credentials and language config
    function initializeAfterModals() {
        // Check if modals are loaded by looking for a modal element
        if (document.getElementById('credentialsModal')) {
            loadCredentials();
            initLanguageConfigApp();
            initAudioValidationApp();
        } else {
            // Retry in 50ms if modals aren't loaded yet
            setTimeout(initializeAfterModals, 50);
        }
    }
    
    setTimeout(initializeAfterModals, 100);
});

function loadRemoteLanguagesIntoConfig() {
    (async () => {
        try {
            const resp = await fetch('/api/language-config');
            if (!resp.ok) return;
            const data = await resp.json();
            if (data && data.languages && typeof data.languages === 'object') {
                window.CONFIG = window.CONFIG || {};
                window.CONFIG.languages = data.languages;
                console.log('Loaded languages from remote language_config.json');
            } else {
                console.log('No remote language_config.json found; using local config.js');
            }
        } catch (e) {
            console.log('Failed to load remote language_config.json; using local config.js');
        }
    })();
}
loadRemoteLanguagesIntoConfig();

// Global click handler to close modals when clicking outside
window.onclick = function(event) {
    const credentialsModal = document.getElementById('credentialsModal');
    const audioInfoModal = document.getElementById('audioInfoModal');
    const audioValidationModal = document.getElementById('audioValidationModal');
    const draftAudioModal = document.getElementById('draftAudioModal');
    if (event.target === credentialsModal) {
        closeCredentialsModal();
    }
    if (event.target === audioInfoModal) {
        closeAudioInfoModal();
    }
    if (event.target === audioValidationModal) {
        closeAudioValidationModal();
    }
    if (event.target === draftAudioModal) {
        closeDraftAudioModal();
    }
};
