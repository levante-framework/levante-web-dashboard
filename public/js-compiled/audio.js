"use strict";
// Utilities are available globally - no imports needed in non-module mode
const BUCKET_LANG_CODE_MAP = {
    'en': 'en',
    'es-CO': 'es-CO', // Try es-CO first, fallback to es
    'de': 'de',
    'fr-CA': 'fr-CA',
    'nl': 'nl'
};
function normalizeAudioItemId(itemId) {
    const raw = String(itemId || '').trim();
    if (!raw)
        return '';
    // Crowdin/XLIFF rows can use composite IDs like "path/to/file.xliff::item-id".
    // Audio assets are stored by bare item ID only.
    return raw.includes('::') ? raw.split('::').pop() || raw : raw;
}
/**
 * Safely gets an element by ID with proper type checking
 */
function getElementByIdSafe(id) {
    const element = document.getElementById(id);
    return element;
}
/**
 * Sets text content for an element if it exists
 */
function setElementText(id, text) {
    const element = getElementByIdSafe(id);
    if (element) {
        element.textContent = text;
    }
    else {
        console.warn(`Element with id '${id}' not found`);
    }
}
/**
 * Sets display style for an element if it exists
 */
function setElementDisplay(id, display) {
    const element = getElementByIdSafe(id);
    if (element) {
        element.style.display = display;
    }
    else {
        console.warn(`Element with id '${id}' not found`);
    }
}
/**
 * Plays audio for a specific item and language
 * @param itemId - The item identifier
 * @param langCode - The language code
 */
function playAudio(itemId, langCode) {
    const audioItemId = normalizeAudioItemId(itemId);
    console.log(`🎯 Attempting to play audio for: ${audioItemId} in ${langCode}`);
    if (!window.dashboard) {
        console.error('Dashboard not initialized');
        return;
    }
    window.dashboard.setStatus(`🔄 Loading audio: ${audioItemId}...`, 'info');
    /**
     * Internal function to attempt audio playback from a specific bucket using exact dialect path only.
     */
    function tryPlayAudioFromBucket(bucketName, bucketLangCode, onMissing) {
        const audioUrl = `https://storage.googleapis.com/${bucketName}/audio/${bucketLangCode}/${audioItemId}.mp3`;
        console.log(`🎵 Playing audio: ${audioUrl}`);
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
                console.log(`✅ Audio playing: ${audioItemId} in ${bucketLangCode}`);
                const label = bucketName === 'levante-assets-draft' ? 'draft' : 'approved';
                window.dashboard?.setStatus(`🎵 Playing ${label} audio: ${audioItemId}`, 'success');
            }).catch((error) => {
                console.error('❌ Audio play failed (likely autoplay restriction):', error);
                if (error.name === 'NotAllowedError') {
                    const message = `🔇 Browser blocked autoplay. Click here to play audio for "${audioItemId}"`;
                    window.dashboard?.setStatus(message, 'warning');
                    if (confirm(`Browser blocked autoplay. Click OK to play audio for "${audioItemId}"`)) {
                        audio.play().then(() => {
                            console.log(`✅ Audio playing after user interaction: ${audioItemId}`);
                            window.dashboard?.setStatus(`🎵 Playing audio: ${audioItemId}`, 'success');
                        }).catch((playError) => {
                            console.error('❌ Manual play also failed:', playError);
                            window.dashboard?.setStatus(`❌ Audio play failed: ${playError.message}`, 'error');
                        });
                    }
                }
                else {
                    window.dashboard?.setStatus(`❌ Audio play failed: ${error.message}`, 'error');
                }
            });
        });
        audio.addEventListener('error', () => {
            clearTimeout(timeout);
            console.error(`❌ Audio not found: ${audioUrl}`);
            if (typeof onMissing === 'function') {
                onMissing();
                return;
            }
            const message = `There isn't any generated audio for this translation.`;
            alert(message);
            window.dashboard?.setStatus(`❌ ${message}`, 'error');
        });
    }
    const exactLangCode = String(langCode || '').trim();
    if (!exactLangCode) {
        const message = `There isn't any generated audio for this translation.`;
        window.dashboard?.setStatus(`❌ ${message}`, 'error');
        return;
    }
    // Strict dialect match; fallback is bucket-only (approved -> draft), never language alias.
    tryPlayAudioFromBucket('levante-assets-dev', exactLangCode, () => {
        window.dashboard?.setStatus(`🔄 Approved audio missing; checking draft audio...`, 'info');
        tryPlayAudioFromBucket('levante-assets-draft', exactLangCode);
    });
}
async function regenerateItemAudio(itemId, langCode) {
    const audioItemId = normalizeAudioItemId(itemId);
    const dashboardInstance = window.dashboard;
    if (!dashboardInstance || typeof dashboardInstance.regenerateAudioForItem !== 'function') {
        console.warn('Dashboard regenerate handler unavailable');
        return;
    }
    try {
        await dashboardInstance.regenerateAudioForItem(audioItemId, langCode);
    }
    catch (error) {
        console.error('❌ Error regenerating audio:', error);
        const message = error instanceof Error ? error.message : String(error);
        window.dashboard?.setStatus(`❌ Error regenerating ${audioItemId}: ${message}`, 'error');
    }
}
async function saveItemAudio(itemId, langCode) {
    const audioItemId = normalizeAudioItemId(itemId);
    const dashboardInstance = window.dashboard;
    if (!dashboardInstance || typeof dashboardInstance.saveGeneratedAudioDraft !== 'function') {
        console.warn('Dashboard save handler unavailable');
        return;
    }
    try {
        await dashboardInstance.saveGeneratedAudioDraft(audioItemId, langCode);
    }
    catch (error) {
        console.error('❌ Error saving generated audio:', error);
        const message = error instanceof Error ? error.message : String(error);
        window.dashboard?.setStatus(`❌ Error saving ${audioItemId}: ${message}`, 'error');
    }
}
/**
 * Shows the audio info modal and fetches metadata
 * @param itemId - The item identifier
 * @param langCode - The language code
 */
function showAudioInfo(itemId, langCode) {
    const audioItemId = normalizeAudioItemId(itemId);
    console.log(`🔍 Showing audio info for: ${audioItemId} in ${langCode}`);
    setElementDisplay('audioInfoModal', 'block');
    setElementDisplay('audioInfoLoading', 'block');
    setElementDisplay('audioInfoData', 'none');
    setElementDisplay('audioInfoError', 'none');
    fetchAudioMetadata(audioItemId, langCode);
}
/**
 * Closes the audio info modal
 */
function closeAudioInfoModal() {
    setElementDisplay('audioInfoModal', 'none');
}
/**
 * Closes the draft audio modal
 */
function closeDraftAudioModal() {
    const modal = getElementByIdSafe('draftAudioModal');
    if (modal) {
        modal.style.display = 'none';
    }
}
/**
 * Fetches audio metadata from the API
 * @param itemId - The item identifier
 * @param langCode - The language code
 */
async function fetchAudioMetadata(itemId, langCode) {
    try {
        const buckets = ['levante-assets-dev', 'levante-assets-draft'];
        const errors = [];
        for (const bucket of buckets) {
            const url = `/api/read-tags?itemId=${encodeURIComponent(itemId)}&langCode=${encodeURIComponent(langCode)}&bucket=${encodeURIComponent(bucket)}`;
            const response = await fetch(url);
            let data = null;
            try {
                data = await response.json();
            }
            catch {
                data = null;
            }
            if (response.ok && data && !data.error) {
                data.bucket = bucket;
                data.note = data.note || `Loaded from ${bucket}`;
                showAudioInfoData(data);
                return;
            }
            const detail = data?.details || data?.error || `${response.status} ${response.statusText}`.trim();
            errors.push(`${bucket}: ${detail}`);
        }
        showAudioInfoError('File not accessible', `No metadata found for ${itemId} in ${langCode}. ${errors.join(' | ')}`);
    }
    catch (error) {
        console.error('❌ Error fetching audio metadata:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        showAudioInfoError('Network Error', `Failed to fetch metadata: ${errorMessage}`);
    }
}
/**
 * Displays audio metadata in the info modal
 * @param metadata - The audio metadata object
 */
function showAudioInfoData(metadata) {
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
        }
        else {
            noteElement.style.display = 'none';
        }
    }
}
/**
 * Displays an error in the audio info modal
 * @param error - The error message
 * @param details - Additional error details
 */
function showAudioInfoError(error, details) {
    setElementDisplay('audioInfoLoading', 'none');
    setElementDisplay('audioInfoData', 'none');
    setElementDisplay('audioInfoError', 'block');
    setElementText('errorMessage', `${error}: ${details}`);
}
// Functions are globally available - no exports needed in non-module mode
// Types are available through declaration files
//# sourceMappingURL=audio.js.map