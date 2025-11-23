// Global function and type declarations
declare function getCredentials(): Credentials;
declare function setCredentials(creds: Credentials): void;
declare function updateValidationAvailability(): void;

// Re-declare the Credentials interface here for this file
interface Credentials {
    playht_api_key?: string;
    playht_user_id?: string;
    elevenlabs_api_key?: string;
    google_translate_api_key?: string;
}

// DOM element IDs for type safety
const CREDENTIAL_ELEMENT_IDS = {
    modal: 'credentialsModal',
    playhtApiKey: 'playhtApiKey',
    playhtUserId: 'playhtUserId',
    elevenlabsApiKey: 'elevenlabsApiKey',
    googleTranslateApiKey: 'googleTranslateApiKey'
} as const;

/**
 * Type-safe helper to get credential input element
 */
function getCredentialInput(id: string): HTMLInputElement | null {
    const element = document.getElementById(id);
    return element instanceof HTMLInputElement ? element : null;
}

/**
 * Type-safe helper to get modal element
 */
function getModal(): HTMLElement | null {
    return document.getElementById(CREDENTIAL_ELEMENT_IDS.modal);
}

/**
 * Opens the credentials modal and loads existing credentials
 */
function openCredentialsModal(): void {
    const modal = getModal();
    if (!modal) {
        console.error('Credentials modal not found');
        return;
    }
    
    modal.style.display = 'block';
    loadCredentials();
}

/**
 * Closes the credentials modal
 */
function closeCredentialsModal(): void {
    const modal = getModal();
    if (!modal) {
        console.error('Credentials modal not found');
        return;
    }
    
    modal.style.display = 'none';
}

/**
 * Saves credentials from form inputs to localStorage
 */
function saveCredentials(): void {
    const playhtApiKeyInput = getCredentialInput(CREDENTIAL_ELEMENT_IDS.playhtApiKey);
    const playhtUserIdInput = getCredentialInput(CREDENTIAL_ELEMENT_IDS.playhtUserId);
    const elevenlabsApiKeyInput = getCredentialInput(CREDENTIAL_ELEMENT_IDS.elevenlabsApiKey);
    const googleTranslateApiKeyInput = getCredentialInput(CREDENTIAL_ELEMENT_IDS.googleTranslateApiKey);
    
    if (!playhtApiKeyInput || !playhtUserIdInput || !elevenlabsApiKeyInput || !googleTranslateApiKeyInput) {
        alert('Error: Could not find all credential input fields');
        return;
    }
    
            const credentials: Credentials = {
                        playht_api_key: playhtApiKeyInput.value.trim() || undefined,
            playht_user_id: playhtUserIdInput.value.trim() || undefined,
            elevenlabs_api_key: elevenlabsApiKeyInput.value.trim() || undefined,
            google_translate_api_key: googleTranslateApiKeyInput.value.trim() || undefined
        };
    
    try {
        localStorage.setItem('levante_credentials', JSON.stringify(credentials));
        alert('Credentials saved successfully!');
        updateValidationAvailability();
    } catch (error) {
        console.error('Error saving credentials:', error);
        alert('Error saving credentials. Please try again.');
    }
}

/**
 * Loads credentials from localStorage and populates form inputs
 */
function loadCredentials(): void {
    try {
        const storedData = localStorage.getItem('levante_credentials');
        const credentials: Credentials = storedData ? JSON.parse(storedData) : {};
        
        // Type-safe element retrieval with null checks
        const elements = {
            playhtApiKey: getCredentialInput(CREDENTIAL_ELEMENT_IDS.playhtApiKey),
            playhtUserId: getCredentialInput(CREDENTIAL_ELEMENT_IDS.playhtUserId),
            elevenlabsApiKey: getCredentialInput(CREDENTIAL_ELEMENT_IDS.elevenlabsApiKey),
            googleTranslateApiKey: getCredentialInput(CREDENTIAL_ELEMENT_IDS.googleTranslateApiKey)
        };
        
        // Safely set values only if elements exist
        if (elements.playhtApiKey) {
            elements.playhtApiKey.value = credentials.playht_api_key || '';
        }
        if (elements.playhtUserId) {
            elements.playhtUserId.value = credentials.playht_user_id || '';
        }
        if (elements.elevenlabsApiKey) {
            elements.elevenlabsApiKey.value = credentials.elevenlabs_api_key || '';
        }
        if (elements.googleTranslateApiKey) {
            elements.googleTranslateApiKey.value = credentials.google_translate_api_key || '';
        }
        
        updateValidationAvailability();
        
    } catch (error) {
        console.error('Error loading credentials:', error);
    }
}

/**
 * Clears all stored credentials after user confirmation
 */
function clearCredentials(): void {
    if (!confirm('Are you sure you want to clear all credentials?')) {
        return;
    }
    
    try {
        localStorage.removeItem('levante_credentials');
        
        // Clear form inputs
        const inputs = [
            getCredentialInput(CREDENTIAL_ELEMENT_IDS.playhtApiKey),
            getCredentialInput(CREDENTIAL_ELEMENT_IDS.playhtUserId),
            getCredentialInput(CREDENTIAL_ELEMENT_IDS.elevenlabsApiKey),
            getCredentialInput(CREDENTIAL_ELEMENT_IDS.googleTranslateApiKey)
        ];
        
        inputs.forEach(input => {
            if (input) {
                input.value = '';
            }
        });
        
        updateValidationAvailability();
        alert('All credentials cleared.');
        
    } catch (error) {
        console.error('Error clearing credentials:', error);
        alert('Error clearing credentials. Please try again.');
    }
}

// Functions are globally available - no exports needed in non-module mode
