interface AudioMetadata {
    fileName?: string;
    size?: number;
    contentType?: string;
    created?: string;
    language?: string;
    note?: string;
    comment?: string;
    id3Tags?: {
        title?: string;
        artist?: string;
        album?: string;
        genre?: string;
        service?: string;
        voice?: string;
        note?: string;
        lang_code?: string;
        text?: string;
        created?: string;
        copyright?: string;
        comment?: string;
        debug_raw_tags?: Record<string, any>;
    };
}
interface AudioMetadataResponse {
    error?: string;
    details?: string;
    fileName?: string;
    size?: number;
    contentType?: string;
    created?: string;
    language?: string;
    note?: string;
    comment?: string;
    id3Tags?: AudioMetadata['id3Tags'];
}
type LanguageCode = 'en' | 'es-CO' | 'de' | 'fr-CA' | 'nl';
type BucketLanguageCode = 'en' | 'es-CO' | 'es' | 'de' | 'fr-CA' | 'nl';
declare const BUCKET_LANG_CODE_MAP: Record<LanguageCode, BucketLanguageCode>;
/**
 * Safely gets an element by ID with proper type checking
 */
declare function getElementByIdSafe<T extends HTMLElement = HTMLElement>(id: string): T | null;
/**
 * Sets text content for an element if it exists
 */
declare function setElementText(id: string, text: string): void;
/**
 * Sets display style for an element if it exists
 */
declare function setElementDisplay(id: string, display: string): void;
/**
 * Plays audio for a specific item and language
 * @param itemId - The item identifier
 * @param langCode - The language code
 */
declare function playAudio(itemId: string, langCode: string): void;
declare function regenerateItemAudio(itemId: string, langCode: string): Promise<void>;
declare function saveItemAudio(itemId: string, langCode: string): Promise<void>;
/**
 * Shows the audio info modal and fetches metadata
 * @param itemId - The item identifier
 * @param langCode - The language code
 */
declare function showAudioInfo(itemId: string, langCode: string): void;
/**
 * Closes the draft audio modal
 */
declare function closeDraftAudioModal(): void;
/**
 * Fetches audio metadata from the API
 * @param itemId - The item identifier
 * @param langCode - The language code
 */
declare function fetchAudioMetadata(itemId: string, langCode: string): Promise<void>;
/**
 * Displays audio metadata in the info modal
 * @param metadata - The audio metadata object
 */
declare function showAudioInfoData(metadata: AudioMetadata): void;
/**
 * Displays an error in the audio info modal
 * @param error - The error message
 * @param details - Additional error details
 */
declare function showAudioInfoError(error: string, details: string): void;
//# sourceMappingURL=audio.d.ts.map