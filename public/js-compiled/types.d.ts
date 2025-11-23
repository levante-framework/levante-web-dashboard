interface Credentials {
    playht_api_key?: string;
    playht_user_id?: string;
    elevenlabs_api_key?: string;
    google_translate_api_key?: string;
}
interface LanguageConfig {
    lang_code: string;
    service: 'ElevenLabs' | 'PlayHT';
    voice: string;
}
type StatusType = 'success' | 'error' | 'warning' | 'info' | 'loading';
interface Voice {
    voice_id: string;
    name: string;
    language: string;
    gender?: string;
    lang_code?: string;
}
interface VoiceCollections {
    playht: Voice[];
    elevenlabs: Voice[];
}
interface TranslationItem {
    item_id: string;
    labels?: string;
    task?: string;
    en?: string;
    [langCode: string]: string | undefined;
}
interface ValidationResult {
    score: number;
    notes?: string;
    timestamp?: string;
    updated?: string;
}
interface ValidationResults {
    [itemId: string]: {
        [langCode: string]: ValidationResult;
    };
}
interface Dashboard {
    languages: Record<string, LanguageConfig>;
    data: TranslationItem[];
    currentLanguage: string;
    selectedRow: TranslationItem | null;
    voices: VoiceCollections;
    validation_results: ValidationResults;
    init(): Promise<void>;
    loadData(): Promise<void>;
    createTabs(): void;
    populateDataTable(): void;
    populateVoices(): void;
    switchTab(language: string, button: HTMLElement): void;
    selectRow(rowElement: HTMLElement, item: TranslationItem): void;
    setStatus(message: string, type?: StatusType): void;
    setupEventListeners(): void;
    loadComprehensiveVoices(): Promise<void>;
    getFlagForLanguage(language: string): string;
    loadValidationResults(): Promise<void>;
    saveValidationResults(): {
        success: boolean;
        itemCount: number;
        validationCount: number;
        error?: string;
    };
    storeValidationResult(itemId: string, langCode: string, score: number, notes?: string): void;
    updateValidationUI(itemId: string, langCode: string, score: number, notes: string): void;
    applyStoredValidationResultsForCurrentLanguage(): void;
    loadFromSharedStorage(): Promise<boolean>;
    saveToSharedStorage(): Promise<void>;
    setupAutoSave(): void;
    generateAudioFromText(): Promise<void>;
    generatePlayHTAudio(text: string, voiceId: string): Promise<void>;
    generateElevenLabsAudio(text: string, voiceId: string): Promise<void>;
    populateSelectedText(): void;
    parseCSV(csvText: string): TranslationItem[];
    parseCSVWithEmbeddedNewlines(csvText: string): string[][];
    parseCSVLine(line: string): string[];
    loadSampleData(): TranslationItem[];
    cacheDataLocally(csvText: string): void;
    loadRealElevenLabsVoices(): Promise<Record<string, Voice[]>>;
}
declare global {
    interface Window {
        dashboard?: Dashboard;
        CONFIG?: {
            languages?: Record<string, LanguageConfig>;
        };
        Vue?: {
            createApp: (options: any) => any;
            reactive: <T>(obj: T) => T;
        };
        marked?: {
            parse: (markdown: string) => string;
        };
    }
}
interface GoogleTranslateResponse {
    original_english: string;
    source_text: string;
    back_translated: string;
    similarity_score: number;
    error?: boolean;
    message?: string;
    details?: string;
}
interface ElevenLabsVoice {
    voice_id: string;
    name: string;
    labels?: {
        language?: string;
        gender?: string;
    };
    category?: string;
}
interface ElevenLabsVoicesResponse {
    voices: ElevenLabsVoice[];
}
export type { StatusType, Voice, VoiceCollections, TranslationItem, ValidationResult, ValidationResults, Dashboard, GoogleTranslateResponse, ElevenLabsVoice, ElevenLabsVoicesResponse, LanguageConfig, Credentials };
//# sourceMappingURL=types.d.ts.map