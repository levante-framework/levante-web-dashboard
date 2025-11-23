function getCredentials() {
    try {
        return JSON.parse(localStorage.getItem('levante_credentials') || '{}');
    } catch (error) {
        return {};
    }
}

function updateValidationAvailability(hasGoogleTranslateKey) {
    const validateButtons = document.querySelectorAll('.validation-button');
    const validateBtns = document.querySelectorAll('.validate-btn');
    
    validateButtons.forEach(btn => {
        btn.disabled = !hasGoogleTranslateKey;
        btn.title = hasGoogleTranslateKey ? 'Validation enabled' : 'Add Google Translate API key';
    });
    validateBtns.forEach(btn => {
        btn.disabled = !hasGoogleTranslateKey;
        btn.title = hasGoogleTranslateKey ? 'Click to validate' : 'Add Google Translate API key';
    });
}

function formatFileSize(bytes) {
    if (!bytes) return 'N/A';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < sizes.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${bytes.toFixed(1)} ${sizes[i]}`;
}

function formatDate(dateString) {
    if (!dateString) return 'N/A';
    try {
        return new Date(dateString).toLocaleString();
    } catch (error) {
        return dateString;
    }
}

function clearCacheAndReload() {
    if (confirm('Clear translation data cache and reload? This will fetch fresh data from GitHub.')) {
        console.log('🗑️ Clearing localStorage cache and reloading...');
        localStorage.removeItem('levante_translations_cache');
        alert('Cache cleared! Page will reload to fetch fresh data.');
        location.reload();
    }
}
