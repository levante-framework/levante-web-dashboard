declare function getCredentials(): Credentials;
declare function setCredentials(creds: Credentials): void;
declare function updateValidationAvailability(): void;
interface Credentials {
    playht_api_key?: string;
    playht_user_id?: string;
    elevenlabs_api_key?: string;
    google_translate_api_key?: string;
}
declare const CREDENTIAL_ELEMENT_IDS: {
    readonly modal: "credentialsModal";
    readonly playhtApiKey: "playhtApiKey";
    readonly playhtUserId: "playhtUserId";
    readonly elevenlabsApiKey: "elevenlabsApiKey";
    readonly googleTranslateApiKey: "googleTranslateApiKey";
};
/**
 * Type-safe helper to get credential input element
 */
declare function getCredentialInput(id: string): HTMLInputElement | null;
/**
 * Type-safe helper to get modal element
 */
declare function getModal(): HTMLElement | null;
/**
 * Opens the credentials modal and loads existing credentials
 */
declare function openCredentialsModal(): void;
/**
 * Saves credentials from form inputs to localStorage
 */
declare function saveCredentials(): void;
/**
 * Clears all stored credentials after user confirmation
 */
declare function clearCredentials(): void;
//# sourceMappingURL=credentials.d.ts.map