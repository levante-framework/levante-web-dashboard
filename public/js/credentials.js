function openCredentialsModal() {
    document.getElementById('credentialsModal').style.display = 'block';
    loadCredentials();
}

function closeCredentialsModal() {
    document.getElementById('credentialsModal').style.display = 'none';
}

function saveCredentials() {
    const credentials = {
        playhtApiKey: document.getElementById('playhtApiKey').value,
        playhtUserId: document.getElementById('playhtUserId').value,
        elevenlabsApiKey: document.getElementById('elevenlabsApiKey').value,
        googleTranslateApiKey: document.getElementById('googleTranslateApiKey').value
    };
    localStorage.setItem('levante_credentials', JSON.stringify(credentials));
    alert('Credentials saved successfully!');
    updateValidationAvailability(!!credentials.googleTranslateApiKey);
}

function loadCredentials() {
    try {
        const credentials = JSON.parse(localStorage.getItem('levante_credentials') || '{}');
        
        // Check if credential input elements exist before setting values
        const playhtApiKey = document.getElementById('playhtApiKey');
        const playhtUserId = document.getElementById('playhtUserId');
        const elevenlabsApiKey = document.getElementById('elevenlabsApiKey');
        const googleTranslateApiKey = document.getElementById('googleTranslateApiKey');
        
        if (playhtApiKey) playhtApiKey.value = credentials.playhtApiKey || '';
        if (playhtUserId) playhtUserId.value = credentials.playhtUserId || '';
        if (elevenlabsApiKey) elevenlabsApiKey.value = credentials.elevenlabsApiKey || '';
        if (googleTranslateApiKey) googleTranslateApiKey.value = credentials.googleTranslateApiKey || '';
        
        updateValidationAvailability(!!credentials.googleTranslateApiKey);
    } catch (error) {
        console.error('Error loading credentials:', error);
    }
}

function clearCredentials() {
    if (confirm('Are you sure you want to clear all credentials?')) {
        localStorage.removeItem('levante_credentials');
        document.getElementById('playhtApiKey').value = '';
        document.getElementById('playhtUserId').value = '';
        document.getElementById('elevenlabsApiKey').value = '';
        document.getElementById('googleTranslateApiKey').value = '';
        updateValidationAvailability(false);
        alert('All credentials cleared.');
    }
}
