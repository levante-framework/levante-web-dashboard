// Shared types for the dashboard application

// Re-declare Credentials interface here to avoid imports
interface Credentials {
    playht_api_key?: string;
    playht_user_id?: string;
    elevenlabs_api_key?: string;
    google_translate_api_key?: string;
}

// Language configuration interface (defined here to avoid circular imports)
interface LanguageConfig {
    lang_code: string;
    service: 'ElevenLabs' | 'PlayHT';
    voice: string;
    approver1_userid?: string;
    approver1_password?: string;
    approver2_userid?: string;
    approver2_password?: string;
    approver3_userid?: string;
    approver3_password?: string;
    approver4_userid?: string;
    approver4_password?: string;
}

// Status types for the dashboard
type StatusType = 'success' | 'error' | 'warning' | 'info' | 'loading';

// Voice data structure
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

// Translation data structure
interface TranslationItem {
    item_id: string;
    labels?: string;
    task?: string;
    en?: string;
    [langCode: string]: string | undefined;
}

// Validation result structure
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

// Dashboard class interface
interface Dashboard {
    // Properties
    languages: Record<string, LanguageConfig>;
    data: TranslationItem[];
    currentLanguage: string;
    selectedRow: TranslationItem | null;
    voices: VoiceCollections;
    validation_results: ValidationResults;

    // Methods
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
    
    // Validation methods
    loadValidationResults(): Promise<void>;
    saveValidationResults(): { success: boolean; itemCount: number; validationCount: number; error?: string };
    storeValidationResult(itemId: string, langCode: string, score: number, notes?: string): void;
    updateValidationUI(itemId: string, langCode: string, score: number, notes: string): void;
    applyStoredValidationResultsForCurrentLanguage(): void;
    loadFromSharedStorage(): Promise<boolean>;
    saveToSharedStorage(): Promise<void>;
    setupAutoSave(): void;
    
    // Audio generation methods
    generateAudioFromText(): Promise<void>;
    generatePlayHTAudio(text: string, voiceId: string): Promise<void>;
    generateElevenLabsAudio(text: string, voiceId: string): Promise<void>;
    populateSelectedText(): void;
    
    // CSV parsing methods
    parseCSV(csvText: string): TranslationItem[];
    parseCSVWithEmbeddedNewlines(csvText: string): string[][];
    parseCSVLine(line: string): string[];
    loadSampleData(): TranslationItem[];
    cacheDataLocally(csvText: string): void;
    
    // Voice loading methods
    loadRealElevenLabsVoices(): Promise<Record<string, Voice[]>>;
}

interface LocationBuildOptions {
    populationThreshold?: number;
    baselineResolution?: number;
    maxResolution?: number;
    populationByResolution?: Record<string, number | null | undefined>;
    estimatePopulationForCell?: (cellId: string, resolution: number) => Promise<number | null>;
    latLonSource?: 'gps' | 'h3_center' | 'approximate';
    blurRadiusMeters?: number;
    computedAt?: string;
}

interface H3PopulationSource {
    name: 'kontur' | 'worldpop' | 'unknown' | string;
    getPopulation: (cellId: string, resolution: number) => Promise<number | null> | number | null;
}

interface PopulationSourceComparisonResult {
    kontur: LocationBuildResult;
    worldpop: LocationBuildResult;
    comparison: {
        confidence: 'high' | 'medium' | 'low';
        sameEffectiveCell: boolean;
        sameEffectiveResolution: boolean;
        konturEffective: {
            cellId: string;
            resolution: number;
            population: number | null;
            thresholdMet: boolean;
        };
        worldpopEffective: {
            cellId: string;
            resolution: number;
            population: number | null;
            thresholdMet: boolean;
        };
    };
}

interface LocationBuildResult {
    location: {
        schemaVersion: 'location_v1';
        latLon: {
            lat: number;
            lon: number;
            source: 'gps' | 'h3_center' | 'approximate';
            blurRadiusMeters?: number;
        };
        h3: {
            scheme: 'h3_v1';
            baseline: {
                cellId: string;
                resolution: number;
            };
            effective: {
                cellId: string;
                resolution: number;
            };
            populationThreshold: number;
        };
        computedAt: string;
        populationSource: 'unknown';
    };
    analysis: {
        thresholdMet: boolean;
        populationDataAvailable: boolean;
        candidates: Array<{
            resolution: number;
            cellId: string;
            population: number | null;
            privacyMet: boolean;
        }>;
    };
}

// Global window extensions
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
        h3?: {
            latLngToCell: (lat: number, lon: number, resolution: number) => string;
            cellToLatLng: (cellId: string) => [number, number];
        };
        buildObfuscatedLocationFromLatLon?: (
            lat: number,
            lon: number,
            options?: LocationBuildOptions
        ) => Promise<LocationBuildResult>;
        buildObfuscatedLocationFromLatLonWithPopulationSource?: (
            lat: number,
            lon: number,
            populationSource: H3PopulationSource,
            options?: LocationBuildOptions
        ) => Promise<LocationBuildResult>;
        createKonturPopulationSource?: (
            cacheByResolution: Record<string, Record<string, number | null | undefined>>
        ) => H3PopulationSource;
        createWorldpopPopulationSource?: (
            cacheByResolution: Record<string, Record<string, number | null | undefined>>
        ) => H3PopulationSource;
        compareKonturAndWorldpopLocationBuild?: (
            lat: number,
            lon: number,
            konturSource: H3PopulationSource,
            worldpopSource: H3PopulationSource,
            options?: LocationBuildOptions
        ) => Promise<PopulationSourceComparisonResult>;
    }
}

// API Response types
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

// Export all types
export type {
    StatusType,
    Voice,
    VoiceCollections,
    TranslationItem,
    ValidationResult,
    ValidationResults,
    Dashboard,
    GoogleTranslateResponse,
    ElevenLabsVoice,
    ElevenLabsVoicesResponse,
    LanguageConfig,
    Credentials
};
