function normalizeAudioItemId(itemId) {
    const raw = String(itemId || '').trim();
    if (!raw) return '';
    // Crowdin/XLIFF rows can use composite IDs like "path/to/file.xliff::item-id".
    // Audio assets are stored by bare item ID only.
    return raw.includes('::') ? raw.split('::').pop() : raw;
}

function mapAudioBucketLangCode(langCode) {
    const normalized = String(langCode || '').trim().toLowerCase();
    if (normalized === 'en-us') return 'en';
    if (normalized === 'de-de') return 'de';
    return String(langCode || '').trim();
}

function getAudioLangCandidates(langCode) {
    const canonical = mapAudioBucketLangCode(langCode);
    const requested = String(langCode || '').trim();
    return Array.from(new Set([canonical, requested].filter(Boolean)));
}

function playAudio(itemId, langCode) {
    const audioItemId = normalizeAudioItemId(itemId);
    const canonicalLangCode = mapAudioBucketLangCode(langCode);
    console.log(`🎯 Attempting to play audio for: ${audioItemId} in ${canonicalLangCode}`);
    window.dashboard.setStatus(`🔄 Loading audio: ${audioItemId}...`, 'info');

    function tryPlayAudioFromBucket(bucketName, bucketLangCode, onMissing) {
        const audioUrl = `https://storage.googleapis.com/${bucketName}/audio/${bucketLangCode}/${audioItemId}.mp3`;
        console.log(`🎵 Playing audio: ${audioUrl}`);
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
                const label = bucketName === 'levante-assets-draft' ? 'draft' : 'approved';
                window.dashboard.setStatus(`🎵 Playing ${label} audio: ${audioItemId}`, 'success');
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

        audio.addEventListener('error', () => {
            clearTimeout(timeout);
            console.error(`❌ Audio not found: ${audioUrl}`);
            if (typeof onMissing === 'function') {
                onMissing();
                return;
            }
            const message = `There isn't any generated audio for this translation.`;
            alert(message);
            window.dashboard.setStatus(`❌ ${message}`, 'error');
        });
    }

    const exactLangCode = String(canonicalLangCode || '').trim();
    if (!exactLangCode) {
        const message = `There isn't any generated audio for this translation.`;
        window.dashboard.setStatus(`❌ ${message}`, 'error');
        return;
    }
    tryPlayAudioFromBucket('levante-assets-dev', exactLangCode, () => {
        window.dashboard.setStatus(`🔄 Approved audio missing; checking draft audio...`, 'info');
        tryPlayAudioFromBucket('levante-assets-draft', exactLangCode);
    });
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
    const canonicalLangCode = mapAudioBucketLangCode(langCode);
    if (!window.dashboard || typeof window.dashboard.saveGeneratedAudioDraft !== 'function') {
        console.warn('Dashboard save handler unavailable');
        return;
    }
    try {
        await window.dashboard.saveGeneratedAudioDraft(audioItemId, canonicalLangCode);
    } catch (error) {
        console.error('❌ Error saving generated audio:', error);
        window.dashboard.setStatus(`❌ Error saving ${audioItemId}: ${error.message}`, 'error');
    }
}

function showAudioInfo(itemId, langCode) {
    const audioItemId = normalizeAudioItemId(itemId);
    const canonicalLangCode = mapAudioBucketLangCode(langCode);
    console.log(`🔍 Showing audio info for: ${audioItemId} in ${canonicalLangCode}`);
    document.getElementById('audioInfoModal').style.display = 'block';
    document.getElementById('audioInfoLoading').style.display = 'block';
    document.getElementById('audioInfoData').style.display = 'none';
    document.getElementById('audioInfoError').style.display = 'none';
    fetchAudioMetadata(audioItemId, canonicalLangCode);
}

function closeAudioInfoModal() {
    document.getElementById('audioInfoModal').style.display = 'none';
}

async function fetchAudioMetadata(itemId, langCode) {
    try {
        const candidates = getAudioLangCandidates(langCode);
        for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i];
            const response = await fetch(`/api/read-tags?itemId=${encodeURIComponent(itemId)}&langCode=${encodeURIComponent(candidate)}`);
            const data = await response.json();
            if (!data.error) {
                showAudioInfoData(data);
                return;
            }
        }
        showAudioInfoError('File not accessible', `No metadata found for ${itemId} in ${candidates.join(', ')}`);
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
