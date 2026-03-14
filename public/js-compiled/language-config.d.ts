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
    voice_id?: string;
    display_name?: string;
    approver1_userid?: string;
    approver1_password?: string;
    approver2_userid?: string;
    approver2_password?: string;
}
//# sourceMappingURL=language-config.d.ts.map