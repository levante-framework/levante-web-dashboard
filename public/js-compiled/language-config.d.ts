/**
 * Opens the language configuration modal
 */
declare function openLanguageConfigModal(): void;
/**
 * Closes the language configuration modal
 */
declare function closeLanguageConfigModal(): void;
declare function normalizeLanguageDisplayNamesConfig(languages: Record<string, any> | undefined): Record<string, any>;
interface LanguageConfig {
    lang_code: string;
    service: 'ElevenLabs' | 'PlayHT';
    voice: string;
    display_name?: string;
}
//# sourceMappingURL=language-config.d.ts.map