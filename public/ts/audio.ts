// Utilities are available globally - no imports needed in non-module mode

// Audio metadata types
interface AudioMetadata {
    fileName?: string;
    size?: number;
    contentType?: string;
    created?: string;
    language?: string;
    note?: string;
    comment?: string;
    id3Tags?: {
        // Standard ID3 tags
        title?: string;
        artist?: string;
        album?: string;
        genre?: string;
        service?: string;
        voice?: string;
        note?: string;
        
        // Custom Levante ID3 tags
        lang_code?: string;
        text?: string;
        created?: string;
        copyright?: string;
        comment?: string;
        
        // Debug information
        debug_raw_tags?: Record<string, any>;
    };
}

interface AudioMetadataResponse {
    error?: string;
    details?: string;
    // Include all possible AudioMetadata fields
    fileName?: string;
    size?: number;
    contentType?: string;
    created?: string;
    language?: string;
    note?: string;
    comment?: string;
    id3Tags?: AudioMetadata['id3Tags'];
}

// Language code mapping for bucket paths
type LanguageCode = 'en' | 'es-CO' | 'de' | 'fr-CA' | 'nl';
type BucketLanguageCode = 'en' | 'es-CO' | 'es' | 'de' | 'fr-CA' | 'nl';

const BUCKET_LANG_CODE_MAP: Record<LanguageCode, BucketLanguageCode> = {
    'en': 'en',
    'es-CO': 'es-CO',  // Try es-CO first, fallback to es
    'de': 'de',
    'fr-CA': 'fr-CA',
    'nl': 'nl'
} as const;

/**
 * Safely gets an element by ID with proper type checking
 */
function getElementByIdSafe<T extends HTMLElement = HTMLElement>(id: string): T | null {
    const element = document.getElementById(id);
    return element as T | null;
}

/**
 * Sets text content for an element if it exists
 */
function setElementText(id: string, text: string): void {
    const element = getElementByIdSafe(id);
    if (element) {
        element.textContent = text;
    } else {
        console.warn(`Element with id '${id}' not found`);
    }
}

/**
 * Sets display style for an element if it exists
 */
function setElementDisplay(id: string, display: string): void {
    const element = getElementByIdSafe<HTMLElement>(id);
    if (element) {
        element.style.display = display;
    } else {
        console.warn(`Element with id '${id}' not found`);
    }
}

/**
 * Plays audio for a specific item and language
 * @param itemId - The item identifier
 * @param langCode - The language code
 */
function playAudio(itemId: string, langCode: string): void {
    console.log(`🎯 Attempting to play audio for: ${itemId} in ${langCode}`);
    
    if (!window.dashboard) {
        console.error('Dashboard not initialized');
        return;
    }
    
    window.dashboard.setStatus(`🔄 Loading audio: ${itemId}...`, 'info');

    /**
     * Internal function to attempt audio playback with fallback logic
     */
    function tryPlayAudio(bucketLangCode: BucketLanguageCode, isRetry: boolean = false): void {
        const audioUrl = `https://storage.googleapis.com/levante-assets-dev/audio/${bucketLangCode}/${itemId}.mp3`;
        console.log(`🎵 ${isRetry ? 'Trying fallback' : 'Playing'} audio: ${audioUrl}`);
        
        const audio = new Audio(audioUrl);
        audio.volume = 0.8;
        
        const timeout = setTimeout(() => {
            console.warn('⏰ Audio loading timeout');
            window.dashboard?.setStatus('⏰ Audio loading timeout - check your internet connection', 'warning');
        }, 10000);

        audio.addEventListener('canplaythrough', () => {
            clearTimeout(timeout);
            console.log(`🎵 Audio loaded, attempting to play: ${audioUrl}`);
            
            audio.play().then(() => {
                console.log(`✅ Audio playing: ${itemId} in ${bucketLangCode}`);
                window.dashboard?.setStatus(`🎵 Playing audio: ${itemId}`, 'success');
            }).catch((error: Error) => {
                console.error('❌ Audio play failed (likely autoplay restriction):', error);
                
                if (error.name === 'NotAllowedError') {
                    const message = `🔇 Browser blocked autoplay. Click here to play audio for "${itemId}"`;
                    window.dashboard?.setStatus(message, 'warning');
                    
                    if (confirm(`Browser blocked autoplay. Click OK to play audio for "${itemId}"`)) {
                        audio.play().then(() => {
                            console.log(`✅ Audio playing after user interaction: ${itemId}`);
                            window.dashboard?.setStatus(`🎵 Playing audio: ${itemId}`, 'success');
                        }).catch((playError: Error) => {
                            console.error('❌ Manual play also failed:', playError);
                            window.dashboard?.setStatus(`❌ Audio play failed: ${playError.message}`, 'error');
                        });
                    }
                } else {
                    window.dashboard?.setStatus(`❌ Audio play failed: ${error.message}`, 'error');
                }
            });
        });

        audio.addEventListener('error', () => {
            clearTimeout(timeout);
            console.error(`❌ Audio not found: ${audioUrl}`);
            
            // Fallback logic for es-CO
            if (langCode === 'es-CO' && bucketLangCode === 'es-CO' && !isRetry) {
                console.log('🔄 Trying es fallback for es-CO...');
                window.dashboard?.setStatus('🔄 Trying es fallback for es-CO audio...', 'info');
                tryPlayAudio('es', true);
            } else if (langCode === 'es-CO' && bucketLangCode === 'es' && !isRetry) {
                console.log('🔄 Trying es-CO directly...');
                window.dashboard?.setStatus('🔄 Trying es-CO direct audio...', 'info');
                tryPlayAudio('es-CO', true);
            } else {
                const message = `Audio file not found for ${itemId} in ${langCode}. Please generate it first using the "Generate Audio" button.`;
                alert(message);
                window.dashboard?.setStatus(`❌ ${message}`, 'error');
            }
        });
    }

    // Map language code to bucket language code
    const bucketLangCode = BUCKET_LANG_CODE_MAP[langCode as LanguageCode] || langCode as BucketLanguageCode;
    tryPlayAudio(bucketLangCode);
}

async function regenerateItemAudio(itemId: string, langCode: string): Promise<void> {
    const dashboardInstance = window.dashboard as any;
    if (!dashboardInstance || typeof dashboardInstance.regenerateAudioForItem !== 'function') {
        console.warn('Dashboard regenerate handler unavailable');
        return;
    }

    try {
        await dashboardInstance.regenerateAudioForItem(itemId, langCode);
    } catch (error) {
        console.error('❌ Error regenerating audio:', error);
        const message = error instanceof Error ? error.message : String(error);
        window.dashboard?.setStatus(`❌ Error regenerating ${itemId}: ${message}`, 'error');
    }
}

async function saveItemAudio(itemId: string, langCode: string): Promise<void> {
    const dashboardInstance = window.dashboard as any;
    if (!dashboardInstance || typeof dashboardInstance.saveGeneratedAudioDraft !== 'function') {
        console.warn('Dashboard save handler unavailable');
        return;
    }

    try {
        await dashboardInstance.saveGeneratedAudioDraft(itemId, langCode);
    } catch (error) {
        console.error('❌ Error saving generated audio:', error);
        const message = error instanceof Error ? error.message : String(error);
        window.dashboard?.setStatus(`❌ Error saving ${itemId}: ${message}`, 'error');
    }
}

/**
 * Shows the audio info modal and fetches metadata
 * @param itemId - The item identifier
 * @param langCode - The language code
 */
function showAudioInfo(itemId: string, langCode: string): void {
    console.log(`🔍 Showing audio info for: ${itemId} in ${langCode}`);
    
    setElementDisplay('audioInfoModal', 'block');
    setElementDisplay('audioInfoLoading', 'block');
    setElementDisplay('audioInfoData', 'none');
    setElementDisplay('audioInfoError', 'none');
    
    fetchAudioMetadata(itemId, langCode);
}

/**
 * Closes the audio info modal
 */
function closeAudioInfoModal(): void {
    setElementDisplay('audioInfoModal', 'none');
}

/**
 * Closes the draft audio modal
 */
function closeDraftAudioModal(): void {
    const modal = getElementByIdSafe<HTMLElement>('draftAudioModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Fetches audio metadata from the API
 * @param itemId - The item identifier
 * @param langCode - The language code
 */
async function fetchAudioMetadata(itemId: string, langCode: string): Promise<void> {
    try {
        const url = `/api/read-tags?itemId=${encodeURIComponent(itemId)}&langCode=${encodeURIComponent(langCode)}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data: AudioMetadataResponse = await response.json();
        
        if (data.error) {
            showAudioInfoError(data.error, data.details || 'Unknown error');
        } else {
            showAudioInfoData(data);
        }
    } catch (error) {
        console.error('❌ Error fetching audio metadata:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        showAudioInfoError('Network Error', `Failed to fetch metadata: ${errorMessage}`);
    }
}

/**
 * Displays audio metadata in the info modal
 * @param metadata - The audio metadata object
 */
function showAudioInfoData(metadata: AudioMetadata): void {
    setElementDisplay('audioInfoLoading', 'none');
    setElementDisplay('audioInfoError', 'none');
    setElementDisplay('audioInfoData', 'block');
    
    // Set basic file information
    setElementText('info-fileName', metadata.fileName || 'N/A');
    setElementText('info-size', formatFileSize(metadata.size) || 'N/A');
    setElementText('info-contentType', metadata.contentType || 'N/A');
    setElementText('info-created', formatDate(metadata.created) || 'N/A');
    setElementText('info-language', metadata.language || 'N/A');
    
    // Set ID3 tag information
    const id3Tags = metadata.id3Tags || {};
    setElementText('info-title', id3Tags.title || 'Not set');
    setElementText('info-artist', id3Tags.artist || 'Not set');
    setElementText('info-album', id3Tags.album || 'Not set');
    setElementText('info-genre', id3Tags.genre || 'Not set');
    setElementText('info-service', id3Tags.service || 'Not set');
    setElementText('info-voice', id3Tags.voice || 'Not set');
    
    // Set custom Levante ID3 tag information
    setElementText('info-lang-code', id3Tags.lang_code || metadata.language || 'Not set');
    setElementText('info-text', id3Tags.text || 'Not available');
    setElementText('info-created-date', id3Tags.created || 'Not set');
    setElementText('info-copyright', id3Tags.copyright || 'Not set');
    setElementText('info-comment', id3Tags.comment || metadata.comment || 'Not set');
    
    // Handle note display
    const noteElement = getElementByIdSafe('info-note');
    let noteText = metadata.note || id3Tags.note;
    
    // Add debug information if available
    if (id3Tags.debug_raw_tags) {
        const debugInfo = Object.entries(id3Tags.debug_raw_tags)
            .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
            .join('\n');
        noteText += `\n\nDebug - Raw ID3 Tags Found:\n${debugInfo}`;
    }
    
    if (noteElement) {
        if (noteText) {
            noteElement.textContent = noteText;
            noteElement.style.display = 'block';
        } else {
            noteElement.style.display = 'none';
        }
    }
}

/**
 * Displays an error in the audio info modal
 * @param error - The error message
 * @param details - Additional error details
 */
function showAudioInfoError(error: string, details: string): void {
    setElementDisplay('audioInfoLoading', 'none');
    setElementDisplay('audioInfoData', 'none');
    setElementDisplay('audioInfoError', 'block');
    
    setElementText('errorMessage', `${error}: ${details}`);
}

// Functions are globally available - no exports needed in non-module mode
// Types are available through declaration files
