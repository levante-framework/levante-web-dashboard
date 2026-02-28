declare function loadCredentials(): void;
declare function closeCredentialsModal(): void;
declare function closeAudioInfoModal(): void;
declare function initLanguageConfigApp(): void;
interface LanguageConfigResponse {
    languages?: Record<string, any>;
    [key: string]: any;
}
declare function normalizeLanguageDisplayNamesBootstrap(languages: Record<string, any> | undefined): Record<string, any>;
declare function languageSignature(languages: Record<string, any> | undefined): string;
/**
 * Loads remote language configuration from the API
 */
declare function loadRemoteLanguagesIntoConfig(): Promise<void>;
//# sourceMappingURL=bootstrap.d.ts.map