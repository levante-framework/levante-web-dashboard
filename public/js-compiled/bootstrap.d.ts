declare function loadCredentials(): void;
declare function closeCredentialsModal(): void;
declare function closeAudioInfoModal(): void;
declare function initLanguageConfigApp(): void;
interface LanguageConfigResponse {
    languages?: Record<string, any>;
    [key: string]: any;
}
/**
 * Loads remote language configuration from the API
 */
declare function loadRemoteLanguagesIntoConfig(): Promise<void>;
//# sourceMappingURL=bootstrap.d.ts.map