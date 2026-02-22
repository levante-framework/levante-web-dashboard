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
    const enabled = true;
    validateButtons.forEach(btn => {
        btn.disabled = !enabled;
        btn.title = 'Run back-translation validation (uses server API key if needed)';
    });
    validateBtns.forEach(btn => {
        btn.disabled = !enabled;
        btn.title = 'Click to validate';
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
