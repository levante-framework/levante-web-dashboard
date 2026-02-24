function normalizeAudioItemId(itemId) {
    const raw = String(itemId || '').trim();
    if (!raw) return '';
    // Crowdin/XLIFF rows can use composite IDs like "path/to/file.xliff::item-id".
    // Audio assets are stored by bare item ID only.
    return raw.includes('::') ? raw.split('::').pop() : raw;
}

function playAudio(itemId, langCode) {
    const audioItemId = normalizeAudioItemId(itemId);
    console.log(`🎯 Attempting to play audio for: ${audioItemId} in ${langCode}`);
    window.dashboard.setStatus(`🔄 Loading audio: ${audioItemId}...`, 'info');

    function tryPlayAudio(bucketLangCode, isRetry = false) {
        const audioUrl = `https://storage.googleapis.com/levante-assets-dev/audio/${bucketLangCode}/${audioItemId}.mp3`;
        console.log(`🎵 ${isRetry ? 'Trying fallback' : 'Playing'} audio: ${audioUrl}`);
        const audio = new Audio(audioUrl);
        audio.volume = 0.8;
        const timeout = setTimeout(() => {
            console.warn('⏰ Audio loading timeout');
            window.dashboard.setStatus('⏰ Audio loading timeout - check your internet connection', 'warning');
        }, 10000);

        audio.addEventListener('canplaythrough', () => {
            clearTimeout(timeout);
            console.log(`🎵 Audio loaded, attempting to play: ${audioUrl}`);
            audio.play().then(() => {
                console.log(`✅ Audio playing: ${audioItemId} in ${bucketLangCode}`);
                window.dashboard.setStatus(`🎵 Playing audio: ${audioItemId}`, 'success');
            }).catch((error) => {
                console.error('❌ Audio play failed (likely autoplay restriction):', error);
                if (error.name === 'NotAllowedError') {
                    const message = `🔇 Browser blocked autoplay. Click here to play audio for "${audioItemId}"`;
                    window.dashboard.setStatus(message, 'warning');
                    if (confirm(`Browser blocked autoplay. Click OK to play audio for "${audioItemId}"`)) {
                        audio.play().then(() => {
                            console.log(`✅ Audio playing after user interaction: ${audioItemId}`);
                            window.dashboard.setStatus(`🎵 Playing audio: ${audioItemId}`, 'success');
                        }).catch((playError) => {
                            console.error('❌ Manual play also failed:', playError);
                            window.dashboard.setStatus(`❌ Audio play failed: ${playError.message}`, 'error');
                        });
                    }
                } else {
                    window.dashboard.setStatus(`❌ Audio play failed: ${error.message}`, 'error');
                }
            });
        });

        audio.addEventListener('error', (e) => {
            clearTimeout(timeout);
            console.error(`❌ Audio not found: ${audioUrl}`);
            if (langCode === 'es-CO' && bucketLangCode === 'es-CO' && !isRetry) {
                console.log('🔄 Trying es fallback for es-CO...');
                window.dashboard.setStatus('🔄 Trying es fallback for es-CO audio...', 'info');
                tryPlayAudio('es', true);
            } else if (langCode === 'es-CO' && bucketLangCode === 'es' && !isRetry) {
                console.log('🔄 Trying es-CO directly...');
                window.dashboard.setStatus('🔄 Trying es-CO direct audio...', 'info');
                tryPlayAudio('es-CO', true);
            } else {
                const message = `Audio file not found for ${audioItemId} in ${langCode}. Please generate it first using the "Generate Audio" button.`;
                alert(message);
                window.dashboard.setStatus(`❌ ${message}`, 'error');
            }
        });
    }

    const bucketLangCodeMap = { 'en': 'en', 'es-CO': 'es-CO', 'de': 'de', 'fr-CA': 'fr-CA', 'nl': 'nl' };
    const bucketLangCode = bucketLangCodeMap[langCode] || langCode;
    tryPlayAudio(bucketLangCode);
}

async function regenerateItemAudio(itemId, langCode) {
    const audioItemId = normalizeAudioItemId(itemId);
    if (!window.dashboard || typeof window.dashboard.regenerateAudioForItem !== 'function') {
        console.warn('Dashboard regenerate handler unavailable');
        return;
    }
    try {
        await window.dashboard.regenerateAudioForItem(audioItemId, langCode);
    } catch (error) {
        console.error('❌ Error regenerating audio:', error);
        window.dashboard.setStatus(`❌ Error regenerating ${audioItemId}: ${error.message}`, 'error');
    }
}

async function saveItemAudio(itemId, langCode) {
    const audioItemId = normalizeAudioItemId(itemId);
    if (!window.dashboard || typeof window.dashboard.saveGeneratedAudioDraft !== 'function') {
        console.warn('Dashboard save handler unavailable');
        return;
    }
    try {
        await window.dashboard.saveGeneratedAudioDraft(audioItemId, langCode);
    } catch (error) {
        console.error('❌ Error saving generated audio:', error);
        window.dashboard.setStatus(`❌ Error saving ${audioItemId}: ${error.message}`, 'error');
    }
}

function showAudioInfo(itemId, langCode) {
    const audioItemId = normalizeAudioItemId(itemId);
    console.log(`🔍 Showing audio info for: ${audioItemId} in ${langCode}`);
    document.getElementById('audioInfoModal').style.display = 'block';
    document.getElementById('audioInfoLoading').style.display = 'block';
    document.getElementById('audioInfoData').style.display = 'none';
    document.getElementById('audioInfoError').style.display = 'none';
    fetchAudioMetadata(audioItemId, langCode);
}

function closeAudioInfoModal() {
    document.getElementById('audioInfoModal').style.display = 'none';
}

async function fetchAudioMetadata(itemId, langCode) {
    try {
        const response = await fetch(`/api/read-tags?itemId=${encodeURIComponent(itemId)}&langCode=${encodeURIComponent(langCode)}`);
        const data = await response.json();
        if (data.error) {
            showAudioInfoError(data.error, data.details);
        } else {
            showAudioInfoData(data);
        }
    } catch (error) {
        console.error('❌ Error fetching audio metadata:', error);
        showAudioInfoError('Network Error', `Failed to fetch metadata: ${error.message}`);
    }
}

function showAudioInfoData(metadata) {
    document.getElementById('audioInfoLoading').style.display = 'none';
    document.getElementById('audioInfoError').style.display = 'none';
    document.getElementById('audioInfoData').style.display = 'block';
    document.getElementById('info-fileName').textContent = metadata.fileName || 'N/A';
    document.getElementById('info-size').textContent = formatFileSize(metadata.size) || 'N/A';
    document.getElementById('info-contentType').textContent = metadata.contentType || 'N/A';
    document.getElementById('info-created').textContent = formatDate(metadata.created) || 'N/A';
    document.getElementById('info-language').textContent = metadata.language || 'N/A';
    const id3Tags = metadata.id3Tags || {};
    document.getElementById('info-title').textContent = id3Tags.title || 'Not set';
    document.getElementById('info-artist').textContent = id3Tags.artist || 'Not set';
    document.getElementById('info-album').textContent = id3Tags.album || 'Not set';
    document.getElementById('info-genre').textContent = id3Tags.genre || 'Not set';
    document.getElementById('info-service').textContent = id3Tags.service || 'Not set';
    document.getElementById('info-voice').textContent = id3Tags.voice || 'Not set';
    const noteElement = document.getElementById('info-note');
    if (metadata.note || id3Tags.note) {
        noteElement.textContent = metadata.note || id3Tags.note;
        noteElement.style.display = 'block';
    } else {
        noteElement.style.display = 'none';
    }
}

function showAudioInfoError(error, details) {
    document.getElementById('audioInfoLoading').style.display = 'none';
    document.getElementById('audioInfoData').style.display = 'none';
    document.getElementById('audioInfoError').style.display = 'block';
    document.getElementById('errorMessage').textContent = `${error}: ${details}`;
}

function closeDraftAudioModal() {
    const modal = document.getElementById('draftAudioModal');
    if (modal) {
        modal.style.display = 'none';
    }
}
