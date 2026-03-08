// Map Levante language codes to Google Translate compatible codes
function mapToGoogleTranslateCode(langCode) {
    const langMapping = {
        'es-CO': 'es',      // Colombian Spanish -> Spanish
        'fr-CA': 'fr',      // Canadian French -> French
        'de-CH': 'de',      // Swiss German -> German
        'en': 'en',         // English
        'es': 'es',         // Spanish
        'fr': 'fr',         // French
        'de': 'de',         // German
        'nl': 'nl',         // Dutch
        'pt': 'pt',         // Portuguese
        'it': 'it',         // Italian
        'ja': 'ja',         // Japanese
        'ko': 'ko',         // Korean
        'zh': 'zh',         // Chinese
        'ar': 'ar',         // Arabic
        'hi': 'hi',         // Hindi
        'ru': 'ru',         // Russian
    };
    
    return langMapping[langCode] || langCode.split('-')[0]; // Fallback: use base language code
}

function resolveValidationLangCode(dashboard, langCode) {
    if (dashboard && typeof dashboard.resolvePreferredLangCode === 'function') {
        return dashboard.resolvePreferredLangCode(langCode);
    }
    return langCode;
}

function getValidationResult(dashboard, itemId, langCode) {
    if (!dashboard) return null;
    if (typeof dashboard.getValidationEntry === 'function') {
        return dashboard.getValidationEntry(itemId, langCode);
    }
    return dashboard.validation_results?.[itemId]?.[langCode] || null;
}

function toggleValidationPanel() {
    const header = document.querySelector('.validation-header');
    const content = document.getElementById('validationContent');
    header.classList.toggle('collapsed');
    content.classList.toggle('expanded');
}

function validateSelected() {
    const selectedRows = document.querySelectorAll('.data-row.selected');
    if (selectedRows.length === 0) {
        alert('Please select one or more translations to validate.');
        return;
    }
    selectedRows.forEach(row => {
        const validateBtn = row.querySelector('.validate-btn');
        if (validateBtn && validateBtn.onclick) validateBtn.click();
    });
}

function getAiJudgeMode() {
    const el = document.getElementById('aiJudgeMode');
    const mode = String(el?.value || 'hybrid').toLowerCase();
    return mode === 'all' ? 'all' : 'hybrid';
}

function getValidateSpeedMode() {
    const el = document.getElementById('validateSpeedMode');
    const mode = String(el?.value || 'turbo').toLowerCase();
    return mode === 'safe' ? 'safe' : 'turbo';
}

function getValidateAllTuning(aiMode, speedMode, jobCount) {
    const safe = speedMode === 'safe';
    const baseConcurrency = aiMode === 'all'
        ? (safe ? 4 : 8)
        : (safe ? 4 : 6);
    const perItemDelayMs = aiMode === 'all'
        ? 0
        : (safe ? 75 : 10);
    return {
        concurrency: Math.min(baseConcurrency, jobCount),
        perItemDelayMs
    };
}

function shouldRetryValidationError(errorMessage) {
    const msg = String(errorMessage || '').toLowerCase();
    return msg.includes('429')
        || msg.includes('rate')
        || msg.includes('timeout')
        || msg.includes('network')
        || msg.includes('fetch')
        || msg.includes('503')
        || msg.includes('502')
        || msg.includes('500');
}

function waitMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toPlainValidationText(value) {
    const input = String(value || '');
    if (!input) return '';
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(input, 'text/html');
        const text = (doc.body && doc.body.textContent) ? doc.body.textContent : input;
        return text.replace(/\s+/g, ' ').trim();
    } catch (_) {
        return input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
}

let _aiJudgeHealthCache = null;
let _aiJudgeHealthCheckedAt = 0;
const AI_HEALTH_TTL_MS = 30000;

async function checkAiJudgeHealth(force = false) {
    const now = Date.now();
    if (!force && _aiJudgeHealthCache && (now - _aiJudgeHealthCheckedAt) < AI_HEALTH_TTL_MS) {
        return _aiJudgeHealthCache;
    }
    try {
        const resp = await fetch('/api/translation-ai-judge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                originalText: 'Health check source',
                translatedText: 'Health check target',
                backTranslation: 'Health check back',
                langCode: 'en'
            })
        });
        if (!resp.ok) {
            _aiJudgeHealthCache = { ok: false, reason: `HTTP ${resp.status}` };
        } else {
            const data = await resp.json();
            if (data && data.ok === true && typeof data.ai_score === 'number') {
                _aiJudgeHealthCache = { ok: true, reason: '' };
            } else {
                _aiJudgeHealthCache = { ok: false, reason: data?.reason || 'AI judge unavailable' };
            }
        }
    } catch (e) {
        _aiJudgeHealthCache = { ok: false, reason: e?.message || 'Network error' };
    }
    _aiJudgeHealthCheckedAt = now;
    return _aiJudgeHealthCache;
}

async function runAiJudge({ originalText, translatedText, backTranslation, langCode, baseScore }) {
    const mode = getAiJudgeMode();
    // Hybrid mode runs AI judge only for borderline scores.
    if (mode !== 'all' && (typeof baseScore !== 'number' || baseScore < 20 || baseScore > 90)) {
        return { used: false, modelUsed: null };
    }
    try {
        const resp = await fetch('/api/translation-ai-judge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ originalText, translatedText, backTranslation, langCode })
        });
        if (!resp.ok) return { used: false, modelUsed: null };
        const data = await resp.json();
        if (!data || data.ok !== true || typeof data.ai_score !== 'number') {
            // Keep noisy warnings out of UI, but log useful reasons once we get data.
            if (data && data.reason) console.warn('AI judge skipped:', data.reason);
            return { used: false, modelUsed: data?.modelUsed || null };
        }
        const aiScore = Math.round(Number(data.ai_score) * 100) / 100;
        // In AI-only mode, use direct AI score (no baseline blending).
        if (mode === 'all') {
            return { used: true, aiScore, finalScore: aiScore, aiNotes: data.notes || '', modelUsed: data.modelUsed || null };
        }
        // Hybrid mode blends baseline + AI score for continuity.
        const blended = Math.round((0.6 * baseScore + 0.4 * aiScore) * 100) / 100;
        return { used: true, aiScore, finalScore: blended, aiNotes: data.notes || '', modelUsed: data.modelUsed || null };
    } catch (_) {
        return { used: false, modelUsed: null };
    }
}

function inferScoreSource(result) {
    if (!result) return '';
    if (result.manualApproved || String(result.scoreSource || '').toLowerCase() === 'manual') return 'manual';
    if (String(result.scoreSource || '').toLowerCase() === 'ai' || result.aiUsed || Number.isFinite(Number(result.aiScore))) return 'ai';
    if (typeof result.score === 'number') return 'calculated';
    return '';
}

function ensureScoreSourceBadge(containerEl, source, aiModel = '') {
    if (!containerEl) return;
    let badge = containerEl.querySelector('.score-source-badge');
    if (!source) {
        if (badge) badge.remove();
        return;
    }
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'score-source-badge';
        containerEl.appendChild(badge);
    }
    badge.style.cssText = 'font-size: 10px; font-weight: 700; margin-left: 4px; opacity: 0.95; border-radius: 3px; padding: 1px 4px;';
    if (source === 'manual') {
        badge.textContent = 'Manual';
        badge.title = 'Manually approved';
        badge.style.color = '#4a148c';
        badge.style.background = '#f3e5f5';
        badge.style.border = '1px solid #ce93d8';
    } else if (source === 'ai') {
        const modelName = String(aiModel || 'gpt-4.1').trim();
        badge.textContent = modelName ? `AI ${modelName}` : 'AI';
        badge.title = modelName ? `AI-refined score via ${modelName}` : 'AI-refined score';
        badge.style.color = '#0d47a1';
        badge.style.background = '#e3f2fd';
        badge.style.border = '1px solid #90caf9';
    } else {
        badge.textContent = 'Calculated';
        badge.title = 'Calculated from back-translation overlap';
        badge.style.color = '#1b5e20';
        badge.style.background = '#e8f5e9';
        badge.style.border = '1px solid #a5d6a7';
    }
}

function findCurrentTableRowByItemId(itemId) {
    const currentLanguage = window.dashboard?.currentLanguage;
    const table = document.getElementById(`table-${currentLanguage}`);
    if (!table) return null;
    const rows = Array.from(table.querySelectorAll('.data-row'));
    return rows.find(r => String(r.dataset.itemId || '') === String(itemId)) || null;
}

function syncApprovedRowUi(row, approved) {
    if (!row) return;
    const reviewContainer = row.querySelector('.needs-review-container');
    const reasonContainer = row.querySelector('.reason-container');
    const needsReviewCheckbox = row.querySelector('.needs-review-checkbox');
    const approvedIndicator = row.querySelector('.approved-indicator');
    const approvedLabel = row.querySelector('.approved-toggle-label');
    if (reviewContainer) reviewContainer.style.display = approved ? 'none' : 'flex';
    if (reasonContainer) {
        const shouldShowReason = !approved && !!needsReviewCheckbox?.checked;
        reasonContainer.style.display = shouldShowReason ? 'flex' : 'none';
    }
    if (approvedIndicator) approvedIndicator.style.display = approved ? 'inline-flex' : 'none';
    if (approvedLabel) approvedLabel.style.color = approved ? '#2e7d32' : '#6c757d';
    row.dataset.approved = approved ? '1' : '0';
    row.style.outline = approved ? '2px solid rgba(76,175,80,0.45)' : '';
    row.style.outlineOffset = approved ? '-2px' : '';
    row.style.background = approved ? 'rgba(46,125,50,0.08)' : '';
}

function applyValidationUiFromResult(itemId, langCode, rowOverride = null) {
    const row = rowOverride || findCurrentTableRowByItemId(itemId);
    if (!row) return;
    const result = window.dashboard?.validation_results?.[itemId]?.[langCode];
    if (!result) return;

    // Pending/no-score state.
    if (typeof result.score !== 'number') {
        const indicator = row.querySelector('.status-indicator');
        const button = row.querySelector('.validate-btn');
        const statusWrap = indicator ? indicator.parentElement : null;
        if (indicator) {
            indicator.className = 'status-indicator status-pending';
            indicator.title = 'Not validated yet';
            indicator.onclick = null;
        }
        row.dataset.score = '-1';
        if (button) {
            button.textContent = 'Validate';
        }
        if (statusWrap) {
            const scoreBadge = statusWrap.querySelector('.score-badge');
            if (scoreBadge) scoreBadge.remove();
            ensureScoreSourceBadge(statusWrap, '');
        }
        syncApprovedRowUi(row, !!result.manualApproved);
        return;
    }

    const indicator = row.querySelector('.status-indicator');
    const button = row.querySelector('.validate-btn');
    const statusWrap = indicator ? indicator.parentElement : null;
    if (!indicator || !statusWrap) return;

    const score = Math.round(Number(result.score) * 10000) / 100;
    let statusClass = 'status-error';
    let statusTitle = `❌ Poor: ${score}% similarity`;
    let buttonText = '❌ View Issues';
    let scoreEmoji = '❌';
    if (score >= 85) {
        statusClass = 'status-good';
        statusTitle = `✅ Excellent: ${score}% similarity`;
        buttonText = '✅ View Results';
        scoreEmoji = '✅';
    } else if (score >= 70) {
        statusClass = 'status-warning';
        statusTitle = `⚠️ Warning: ${score}% similarity`;
        buttonText = '⚠️ View Warning';
        scoreEmoji = '⚠️';
    }

    indicator.className = `status-indicator ${statusClass}`;
    indicator.title = statusTitle;
    row.dataset.score = String(score);

    let scoreBadge = statusWrap.querySelector('.score-badge');
    if (!scoreBadge) {
        scoreBadge = document.createElement('span');
        scoreBadge.className = 'score-badge';
        scoreBadge.style.cssText = 'font-size: 10px; font-weight: bold; margin-left: 4px; opacity: 0.9;';
        statusWrap.appendChild(scoreBadge);
    }
    scoreBadge.textContent = `${score.toFixed(2)}%`;
    scoreBadge.style.color = score >= 85 ? '#155724' : score >= 70 ? '#856404' : '#721c24';

    ensureScoreSourceBadge(statusWrap, inferScoreSource(result), result?.aiModel || '');
    syncApprovedRowUi(row, !!result.manualApproved);

    if (button) {
        button.textContent = buttonText;
        button.removeAttribute('onclick');
        button.onclick = () => {
            const latest = getValidationResult(window.dashboard, itemId, langCode);
            showValidationResults(itemId, langCode, latest, scoreEmoji, score, statusClass);
        };
    }

    indicator.onclick = () => {
        const latest = getValidationResult(window.dashboard, itemId, langCode);
        showValidationResults(itemId, langCode, latest, scoreEmoji, score, statusClass);
    };
}

function showStoredValidationResult(itemId, langCode) {
    const result = getValidationResult(window.dashboard, itemId, langCode);
    if (!result || typeof result.score !== 'number') return;
    const score = Math.round(Number(result.score) * 10000) / 100;
    const scoreEmoji = score >= 85 ? '✅' : score >= 70 ? '⚠️' : '❌';
    const statusClass = score >= 85 ? 'status-good' : score >= 70 ? 'status-warning' : 'status-error';
    if (typeof showValidationResults === 'function') {
        showValidationResults(itemId, langCode, result, scoreEmoji, score, statusClass);
    }
}

function resolveTranslatedTextForLang(item, langCode) {
    if (!item) return '';
    let translatedText = item[langCode];
    if (!translatedText && String(langCode).includes('-')) translatedText = item[String(langCode).split('-')[0]];
    if (!translatedText) {
        const key = Object.keys(item).find((k) => k.toLowerCase() === String(langCode).toLowerCase());
        translatedText = key ? item[key] : '';
    }
    return toPlainValidationText(String(translatedText || ''));
}

function validateByItemId(itemId, langCode) {
    const dashboard = window.dashboard;
    if (!dashboard || !Array.isArray(dashboard.data)) return;
    const targetId = String(itemId || '');
    const item = dashboard.data.find((row) => String(row.item_id || row.identifier || '') === targetId);
    if (!item) {
        dashboard.setStatus(`❌ Could not find item data for ${targetId}`, 'error');
        return false;
    }
    const originalText = toPlainValidationText(item.en || '');
    const translatedText = resolveTranslatedTextForLang(item, langCode);
    const isSourceEnglish = String(langCode).split('-')[0].toLowerCase() === 'en';
    if (!isSourceEnglish && !translatedText) {
        dashboard.setStatus(`⚠️ Missing ${langCode} translation for ${targetId}; skipped validation.`, 'warning');
        return false;
    }
    validateSingle(targetId, toPlainValidationText(originalText || ''), translatedText, langCode);
    return true;
}

function setManualApprovalForValidation(itemId, langCode, approved, rowEl = null) {
    const dashboard = window.dashboard;
    if (!dashboard) return;
    const langKey = resolveValidationLangCode(dashboard, langCode);
    if (!dashboard.validation_results[itemId]) dashboard.validation_results[itemId] = {};
    const result = dashboard.validation_results[itemId][langKey] || {};
    const priorSource = inferScoreSource(result);

    if (approved) {
        if (typeof result.score === 'number') result.manualOverridePreviousScore = result.score;
        if (priorSource) result.manualOverridePreviousSource = priorSource;
        result.manualApproved = true;
        result.score = 1.0;
        result.scoreSource = 'manual';
        result.notes = 'Manually approved';
        result.timestamp = new Date().toISOString();
    } else {
        result.manualApproved = false;
        if (typeof result.manualOverridePreviousScore === 'number') {
            result.score = result.manualOverridePreviousScore;
            delete result.manualOverridePreviousScore;
        } else {
            // If this item was only manually approved (no prior score), return to pending.
            delete result.score;
        }
        const restoredSource = String(result.manualOverridePreviousSource || '').toLowerCase();
        if (restoredSource === 'ai' || restoredSource === 'calculated') {
            result.scoreSource = restoredSource;
            delete result.manualOverridePreviousSource;
        } else {
            if (typeof result.score === 'number') {
                result.scoreSource = (result.aiUsed || Number.isFinite(Number(result.aiScore))) ? 'ai' : 'calculated';
            } else {
                delete result.scoreSource;
            }
        }
        result.timestamp = new Date().toISOString();
    }
    dashboard.validation_results[itemId][langKey] = result;
    applyValidationUiFromResult(itemId, langCode, rowEl);
    // Persist immediately so manual approval is saved/reloaded with other validation metadata.
    try { dashboard.saveValidationResults(); } catch (_) {}
    if (typeof updateValidationSummary === 'function') updateValidationSummary();
}

const validationRunState = {
    active: false,
    cancelRequested: false,
    completed: 0,
    total: 0,
    language: '',
    sourceCounts: { ai: 0, calculated: 0, error: 0 }
};

function setValidationRunUi(active) {
    const validateAllBtn = document.getElementById('validateAll');
    if (validateAllBtn) {
        validateAllBtn.disabled = false;
        if (active) {
            validateAllBtn.innerHTML = '<i class="fas fa-stop-circle"></i> Cancel Validate All';
            validateAllBtn.title = 'Cancel the current Validate All run (stops queued items)';
            validateAllBtn.style.background = '#c62828';
            validateAllBtn.style.borderColor = '#8e0000';
            validateAllBtn.style.color = '#fff';
        } else {
            validateAllBtn.innerHTML = '<i class="fas fa-check-circle"></i> Validate All';
            validateAllBtn.title = 'Validate visible rows for the current language';
            validateAllBtn.style.background = '';
            validateAllBtn.style.borderColor = '';
            validateAllBtn.style.color = '';
        }
    }
}

function toggleValidateAllRun() {
    if (validationRunState.active) {
        cancelValidateAll();
        return;
    }
    validateAll();
}

function cancelValidateAll() {
    if (!validationRunState.active) return;
    validationRunState.cancelRequested = true;
    if (window.dashboard) {
        window.dashboard.setStatus(
            `🛑 Cancel requested for ${validationRunState.language || 'current language'} (${validationRunState.completed}/${validationRunState.total} completed)`,
            'warning'
        );
    }
}

async function validateAll() {
    if (validationRunState.active) {
        alert('A Validate All run is already active. Cancel it first or wait for completion.');
        return;
    }
    const currentLanguage = window.dashboard?.currentLanguage;
    if (!currentLanguage) {
        alert('No active language found.');
        return;
    }
    const currentTable = document.getElementById(`table-${currentLanguage}`);
    if (!currentTable) {
        alert(`Current language table not found: table-${currentLanguage}`);
        return;
    }
    const validateBtns = currentTable.querySelectorAll('.validate-btn');
    if (validateBtns.length === 0) {
        alert('No translations available to validate in the current language.');
        return;
    }
    const dashboard = window.dashboard;
    if (dashboard && typeof dashboard.ensureLanguageFullyRendered === 'function') {
        dashboard.ensureLanguageFullyRendered(currentLanguage);
    }
    const langCode = dashboard.languages[currentLanguage].lang_code;
    const validateModeEl = document.getElementById('validateAllMode');
    const validateMode = validateModeEl ? String(validateModeEl.value || 'pending') : 'pending';
    const forceAll = validateMode === 'force';
    const aiMode = getAiJudgeMode();
    const speedMode = getValidateSpeedMode();
    if (aiMode === 'all') {
        const health = await checkAiJudgeHealth();
        if (!health.ok) {
            const proceed = confirm(
                `AI mode is set to All, but AI judge is unavailable: ${health.reason || 'unknown reason'}.\n\n` +
                `If you continue, rows will be marked as Calculated (fallback). Continue anyway?`
            );
            if (!proceed) return;
        }
    }
    const itemById = new Map((dashboard.data || []).map(item => [String(item.item_id || item.identifier || ''), item]));
    const visibleRows = Array.from(currentTable.querySelectorAll('.data-row'));
    const jobs = [];
    let skippedAlreadyValidated = 0;
    let skippedMissingTranslation = 0;
    visibleRows.forEach(row => {
        const itemId = String(row.dataset.itemId || '');
        if (!itemId) return;
        const existing = dashboard.validation_results?.[itemId]?.[langCode];
        const alreadyValidated = existing && typeof existing.score === 'number';
        if (alreadyValidated && !forceAll) {
            skippedAlreadyValidated++;
            return;
        }
        const item = itemById.get(itemId);
        if (!item) return;
        const translatedText = resolveTranslatedTextForLang(item, langCode);
        const isSourceEnglish = String(langCode).split('-')[0].toLowerCase() === 'en';
        if (!isSourceEnglish && !translatedText) {
            skippedMissingTranslation++;
            return;
        }
        const cleanOriginalText = toPlainValidationText(item.en || '');
        const cleanTranslatedText = translatedText;
        jobs.push({
            itemId,
            originalText: cleanOriginalText,
            translatedText: cleanTranslatedText,
            langCode
        });
    });

    if (jobs.length === 0) {
        if (forceAll) {
            alert('No translations available to validate in the current language/filter.');
        } else {
            alert('No pending translations to validate in the current language/filter (or translations are missing).');
        }
        return;
    }

    const tuning = getValidateAllTuning(aiMode, speedMode, jobs.length);
    const perItemDelayMs = tuning.perItemDelayMs;
    const concurrency = tuning.concurrency;
    const actionLabel = forceAll ? 're-validate' : 'validate';
    const skippedCount = forceAll ? 0 : skippedAlreadyValidated;
    const skippedMissing = forceAll ? 0 : skippedMissingTranslation;
    if (confirm(
        `This will ${actionLabel} ${jobs.length} ${currentLanguage.toUpperCase()} translations ` +
        `(${skippedCount} already validated skipped${skippedMissing ? `, ${skippedMissing} missing translation skipped` : ''}).\n` +
        `Mode: ${speedMode.toUpperCase()} | Concurrency: ${concurrency} | Delay: ${perItemDelayMs}ms\n\nContinue?`
    )) {
        validationRunState.active = true;
        validationRunState.cancelRequested = false;
        validationRunState.completed = 0;
        validationRunState.total = jobs.length;
        validationRunState.language = currentLanguage.toUpperCase();
        validationRunState.sourceCounts = { ai: 0, calculated: 0, error: 0 };
        setValidationRunUi(true);

        let nextIndex = 0;
        let completed = 0;
        const total = jobs.length;
        let lastStatusUpdateAt = 0;
        const worker = async () => {
            while (nextIndex < total && !validationRunState.cancelRequested) {
                const idx = nextIndex++;
                const job = jobs[idx];
                let res = null;
                let attempt = 0;
                const maxRetries = speedMode === 'turbo' ? 2 : 1;
                while (!validationRunState.cancelRequested && attempt <= maxRetries) {
                    res = await validateSingle(job.itemId, job.originalText, job.translatedText, job.langCode);
                    const canRetry = res?.scoreSource === 'error' && shouldRetryValidationError(res?.errorMessage);
                    if (!canRetry || attempt === maxRetries) break;
                    const backoff = Math.min(1500, 250 * (2 ** attempt)) + Math.floor(Math.random() * 125);
                    await waitMs(backoff);
                    attempt += 1;
                }
                completed++;
                validationRunState.completed = completed;
                if (res && res.scoreSource === 'ai') validationRunState.sourceCounts.ai++;
                else if (res && res.scoreSource === 'calculated') validationRunState.sourceCounts.calculated++;
                else if (res && res.scoreSource === 'error') validationRunState.sourceCounts.error++;
                const cancelNote = validationRunState.cancelRequested ? ' (stopping...)' : '';
                const now = Date.now();
                if (completed === total || completed % 5 === 0 || (now - lastStatusUpdateAt) > 500) {
                    dashboard.setStatus(`Validating ${currentLanguage}: ${completed}/${total}${cancelNote}`, 'loading');
                    lastStatusUpdateAt = now;
                }
                // Small gap helps avoid API burst/rate limits; remove it for fast AI-only mode.
                if (perItemDelayMs > 0) await new Promise(r => setTimeout(r, perItemDelayMs));
            }
        };
        Promise.all(Array.from({ length: concurrency }, () => worker()))
            .then(() => {
                if (typeof updateValidationSummary === 'function') updateValidationSummary();
                const doneLabel = forceAll ? 're-validated' : 'pending';
                const src = validationRunState.sourceCounts;
                if (validationRunState.cancelRequested) {
                    dashboard.setStatus(
                        `🛑 Validation cancelled: ${completed}/${total} ${currentLanguage.toUpperCase()} items processed (AI: ${src.ai}, Calculated: ${src.calculated}, Errors: ${src.error})`,
                        'warning'
                    );
                } else {
                    dashboard.setStatus(
                        `✅ Validation complete: ${total} ${doneLabel} ${currentLanguage.toUpperCase()} items in ${speedMode.toUpperCase()} mode (AI: ${src.ai}, Calculated: ${src.calculated}, Errors: ${src.error})`,
                        'success'
                    );
                }
                if (getAiJudgeMode() === 'all' && src.ai === 0 && src.calculated > 0) {
                    dashboard.setStatus(
                        `⚠️ AI mode was set to All, but 0 rows used AI (likely AI endpoint not configured/reachable).`,
                        'warning'
                    );
                }
            })
            .catch((err) => {
                dashboard.setStatus(`⚠️ Validation finished with errors: ${err.message || err}`, 'warning');
            })
            .finally(() => {
                validationRunState.active = false;
                validationRunState.cancelRequested = false;
                setValidationRunUi(false);
            });
    }
}

async function saveValidationsManually() {
    const button = document.getElementById('saveValidations');
    const originalText = button.innerHTML;
    try {
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        button.disabled = true;
        const result = await window.dashboard.saveValidationResults();
        if (result && result.success) {
            button.innerHTML = '<i class="fas fa-check"></i> Saved!';
            const localMode = result.localStorageMode || 'full';
            const sharedLabel = result.sharedSaved ? 'shared bucket' : 'no shared bucket';
            window.dashboard.setStatus(
                `💾 Saved ${result.itemCount} items (${result.validationCount} validations) [local: ${localMode}, shared: ${sharedLabel}]`,
                result.sharedSaved ? 'success' : 'warning'
            );
            setTimeout(() => { button.innerHTML = originalText; button.disabled = false; }, 2000);
        } else {
            const errMsg = (result && result.error) ? result.error : 'Unknown error';
            button.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error!';
            window.dashboard.setStatus(`❌ Error saving validations: ${errMsg}`, 'error');
            setTimeout(() => { button.innerHTML = originalText; button.disabled = false; }, 3000);
        }
    } catch (error) {
        button.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error!';
        window.dashboard.setStatus(`❌ Error saving validations: ${error.message}`, 'error');
        setTimeout(() => { button.innerHTML = originalText; button.disabled = false; }, 3000);
    }
}

async function loadValidationsFromShared() {
    const button = document.getElementById('loadValidations');
    const originalText = button.innerHTML;
    try {
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
        button.disabled = true;
        const success = await window.dashboard.loadFromSharedStorage();
        if (success) {
            // Re-render the table to show updated validation results (pre-computed in HTML)
            window.dashboard.populateDataTable();
            button.innerHTML = '<i class="fas fa-check"></i> Loaded!';
            window.dashboard.setStatus('🌐 Successfully loaded validation results from shared session storage', 'success');
            setTimeout(() => { button.innerHTML = originalText; button.disabled = false; }, 2000);
        } else {
            button.innerHTML = '<i class="fas fa-exclamation-triangle"></i> No Data';
            window.dashboard.setStatus('⚠️ No shared validation data found', 'warning');
            setTimeout(() => { button.innerHTML = originalText; button.disabled = false; }, 2000);
        }
    } catch (error) {
        button.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error!';
        window.dashboard.setStatus(`❌ Error loading shared validations: ${error.message}`, 'error');
        setTimeout(() => { button.innerHTML = originalText; button.disabled = false; }, 3000);
    }
}

async function validateSingle(itemId, originalText, translatedText, langCode) {
    const normalizedOriginalText = toPlainValidationText(originalText);
    const normalizedTranslatedText = toPlainValidationText(translatedText);
    const credentials = getCredentials();
    const userKey = credentials.google_translate_api_key && credentials.google_translate_api_key.trim() ? credentials.google_translate_api_key.trim() : null;

    // Find the status indicator by data-item-id - but only in the current active tab
    const currentLanguage = window.dashboard?.currentLanguage;
    const activeTabContent = document.getElementById(`tab-${currentLanguage}`);
    const indicator = activeTabContent ? 
        activeTabContent.querySelector(`.status-indicator[data-item-id="${itemId}"]`) :
        document.querySelector(`.status-indicator[data-item-id="${itemId}"]`);
    // Find the validate button in the same validation-status container
    const button = indicator ? indicator.parentElement.querySelector('.validate-btn') : null;
    
    console.log('🎯 DOM elements found:', { 
        button: !!button, 
        indicator: !!indicator,
        itemId: itemId,
        buttonText: button?.textContent,
        indicatorClass: indicator?.className,
        indicatorTitle: indicator?.title,
        validationStatusContainer: !!indicator?.parentElement,
        isConnected: indicator?.isConnected,
        parentRow: indicator?.closest('.data-row')?.style.display || 'visible'
    });

    if (!button || !indicator) {
        console.error('❌ Could not find button or indicator for item:', itemId);
        window.dashboard.setStatus(`❌ UI error: Could not find validation elements for ${itemId}`, 'error');
        return;
    }
    
    // Show loading state
    const originalButtonText = button.innerHTML;
    let updatedButtonText = false; // prevents finally from restoring old label after success
    button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    button.disabled = true;
    indicator.className = 'status-indicator status-info';
    indicator.title = 'Validating...';

    try {
        // Skip validation for English (can't back-translate English to English)
        if (String(langCode).split('-')[0] === 'en') {
            // For English, just mark as good since it's the source language
            const similarity = 1.0; // Perfect score for source language
            
            // Store validation result
            if (!window.dashboard.validation_results[itemId]) {
                window.dashboard.validation_results[itemId] = {};
            }
            const langKey = resolveValidationLangCode(window.dashboard, langCode);
            
            const existingResult = getValidationResult(window.dashboard, itemId, langCode) || {};
            window.dashboard.validation_results[itemId][langKey] = {
                score: similarity,
                originalText: normalizedOriginalText,
                translatedText: normalizedTranslatedText,
                backTranslation: 'N/A (source language)',
                timestamp: new Date().toISOString(),
                notes: 'Source language - no translation validation needed',
                scoreSource: 'calculated',
                manualApproved: false,
                needsReview: !!existingResult.needsReview,
                reason: existingResult.reason || ''
            };

            // Update UI
            console.log('🔄 Updating English indicator:', {
                beforeClass: indicator.className,
                afterClass: 'status-indicator status-good'
            });
            
            indicator.className = 'status-indicator status-good';
            indicator.title = 'Source language - 100% accuracy';
            const rowEl = indicator.closest('.data-row');
            if (rowEl) rowEl.dataset.score = '100';

            // Add score badge to parent container (not inside the indicator circle)
            let scoreBadge = indicator.parentElement.querySelector('.score-badge');
            if (!scoreBadge) {
                scoreBadge = document.createElement('span');
                scoreBadge.className = 'score-badge';
                scoreBadge.style.cssText = 'font-size: 10px; font-weight: bold; margin-left: 4px; opacity: 0.9; color: #155724;';
                indicator.parentElement.appendChild(scoreBadge);
            }
            scoreBadge.textContent = '100.00%';
            ensureScoreSourceBadge(indicator.parentElement, 'calculated');
            const approvedCheckbox = indicator.parentElement.querySelector('.approved-checkbox');
            if (approvedCheckbox) approvedCheckbox.checked = false;

            // Update the validate button text and functionality
            if (button) {
                button.textContent = 'Good match';
                button.title = 'Source text (no validation needed)';
                // Remove the original onclick attribute and replace with our handler
                button.removeAttribute('onclick');
                button.onclick = () => {
                    const result = getValidationResult(window.dashboard, itemId, langCode);
                    showValidationResults(itemId, langCode, result, '✅', 100, 'status-good');
                };
            }

            console.log('✅ Updated English validation UI:', {
                indicatorClass: indicator.className,
                scoreBadgeText: scoreBadge.textContent,
                buttonText: button?.textContent
            });

            // Add click handler to show details (keeping both button and indicator clickable)
            indicator.onclick = () => {
                const result = getValidationResult(window.dashboard, itemId, langCode);
                showValidationResults(itemId, langCode, result, '✅', 100, 'status-good');
            };

            window.dashboard.setStatus(`✅ Validated ${itemId}: Source language (100%)`, 'success');
            updatedButtonText = true;
            return { scoreSource: 'calculated' };
        }

        const aiMode = getAiJudgeMode();
        let backTranslation = '';
        let baselineScore = null;
        let aiJudge = { used: false, aiScore: null, finalScore: null, aiNotes: '', modelUsed: null };
        let score = null;

        // Fast path: AI-only mode skips Google back-translation.
        if (aiMode === 'all') {
            aiJudge = await runAiJudge({
                originalText: normalizedOriginalText,
                translatedText: normalizedTranslatedText,
                backTranslation: '',
                langCode,
                baseScore: 0
            });
            if (aiJudge.used) {
                score = aiJudge.finalScore;
                backTranslation = 'N/A (AI-only mode)';
            }
        }

        // Fallback path (hybrid mode, or AI-only when AI judge failed): use Google back-translation baseline.
        if (typeof score !== 'number') {
            const googleLangCode = mapToGoogleTranslateCode(langCode);
            console.log('🌍 Language mapping:', { original: langCode, mapped: googleLangCode });

            // Call Google Translate API to back-translate from target language to English.
            const headers = {};
            if (userKey) headers['Authorization'] = `Bearer ${userKey}`;
            const response = await fetch(`/api/google-translate?text=${encodeURIComponent(normalizedTranslatedText)}&from=${encodeURIComponent(googleLangCode)}&to=en`, {
                method: 'GET',
                headers
            });

            if (!response.ok) {
                let errorDetails = `Translation API error: ${response.status}`;
                try {
                    const errorData = await response.json();
                    console.error('🚨 Translation API error details:', errorData);
                    errorDetails += ` - ${errorData.details || errorData.error || 'Unknown error'}`;
                } catch (e) {
                    console.error('🚨 Could not parse error response');
                }
                throw new Error(errorDetails);
            }

            const data = await response.json();
            backTranslation = toPlainValidationText(data.translatedText);

            // Calculate similarity score (simple word overlap for now).
            const originalWords = normalizedOriginalText.toLowerCase().split(/\s+/);
            const backTranslatedWords = backTranslation.toLowerCase().split(/\s+/);
            const commonWords = originalWords.filter(word => backTranslatedWords.includes(word));
            const similarity = commonWords.length / Math.max(originalWords.length, backTranslatedWords.length);
            baselineScore = Math.round((similarity * 100) * 100) / 100;

            aiJudge = await runAiJudge({
                originalText: normalizedOriginalText,
                translatedText: normalizedTranslatedText,
                backTranslation,
                langCode,
                baseScore: baselineScore
            });
            score = aiJudge.used ? aiJudge.finalScore : baselineScore;
        }

        // Store validation result
        if (!window.dashboard.validation_results[itemId]) {
            window.dashboard.validation_results[itemId] = {};
        }
        const langKey = resolveValidationLangCode(window.dashboard, langCode);
        
        const existingResult = getValidationResult(window.dashboard, itemId, langCode) || {};
        window.dashboard.validation_results[itemId][langKey] = {
            score: score / 100, // Store as decimal for consistency
            originalText: normalizedOriginalText,
            translatedText: normalizedTranslatedText,
            backTranslation: backTranslation,
            timestamp: new Date().toISOString(),
            notes: score >= 85 ? 'Excellent translation' : score >= 70 ? 'Good translation, review recommended' : 'Poor translation quality',
            baselineScore: baselineScore,
            aiScore: aiJudge.used ? aiJudge.aiScore : null,
            aiUsed: aiJudge.used === true,
            aiNotes: aiJudge.used ? aiJudge.aiNotes : '',
            aiModel: aiJudge.used ? (aiJudge.modelUsed || '') : '',
            scoreSource: aiJudge.used ? 'ai' : 'calculated',
            manualApproved: false,
            needsReview: !!existingResult.needsReview,
            reason: existingResult.reason || ''
        };

        // Determine status based on score (using original dashboard-core.js logic)
        let statusClass, statusTitle, buttonText, scoreEmoji;
        if (score >= 85) {
            statusClass = 'status-good';
            statusTitle = `✅ Excellent: ${score}% similarity`;
            buttonText = 'Good match';
            scoreEmoji = '✅';
        } else if (score >= 70) {
            statusClass = 'status-warning';
            statusTitle = `⚠️ Warning: ${score}% similarity`;
            buttonText = 'View Warning';
            scoreEmoji = '⚠️';
        } else {
            statusClass = 'status-error';
            statusTitle = `❌ Poor: ${score}% similarity`;
            buttonText = 'View Issues';
            scoreEmoji = '❌';
        }
        
        // Update indicator
        console.log('🔄 Updating indicator:', {
            beforeClass: indicator.className,
            afterClass: `status-indicator ${statusClass}`,
            statusTitle: statusTitle,
            score: score,
            buttonText: buttonText
        });
        
        indicator.className = `status-indicator ${statusClass}`;
        indicator.title = statusTitle;
        const rowEl = indicator.closest('.data-row');
        if (rowEl) rowEl.dataset.score = String(score);
        const approvedCheckbox = indicator.parentElement.querySelector('.approved-checkbox');
        if (approvedCheckbox) approvedCheckbox.checked = false;
        
        // Update the validate button text and functionality
        if (button) {
            button.textContent = buttonText;
            // Remove the original onclick attribute and replace with our handler
            button.removeAttribute('onclick');
            button.onclick = () => {
                const result = getValidationResult(window.dashboard, itemId, langCode);
                showValidationResults(itemId, langCode, result, scoreEmoji, score, statusClass);
            };
            console.log('🔄 Updated button:', { 
                oldText: 'Validate', 
                newText: buttonText,
                hasNewClickHandler: true 
            });
            updatedButtonText = true;
        }
        
        // Update or create score badge in parent container (not inside indicator circle)
        let scoreBadge = indicator.parentElement.querySelector('.score-badge');
        if (!scoreBadge) {
            scoreBadge = document.createElement('span');
            scoreBadge.className = 'score-badge';
            scoreBadge.style.cssText = 'font-size: 10px; font-weight: bold; margin-left: 4px; opacity: 0.9;';
            indicator.parentElement.appendChild(scoreBadge);
        }
        scoreBadge.textContent = `${score}%`;
        scoreBadge.style.color = score >= 85 ? '#155724' : score >= 70 ? '#856404' : '#721c24';

        ensureScoreSourceBadge(indicator.parentElement, aiJudge.used ? 'ai' : 'calculated', aiJudge.modelUsed || '');

        console.log('✅ Updated validation UI:', {
            indicatorClass: indicator.className,
            scoreBadgeText: scoreBadge.textContent,
            buttonText: button?.textContent,
            hasClickHandler: true
        });

        // Add click handler to show detailed results
        indicator.onclick = () => {
            const result = getValidationResult(window.dashboard, itemId, langCode);
            showValidationResults(itemId, langCode, result, scoreEmoji, score, statusClass);
        };

        window.dashboard.setStatus(`${scoreEmoji} Validated ${itemId}: ${score}% similarity`, 'success');
        return { scoreSource: aiJudge.used ? 'ai' : 'calculated' };

    } catch (error) {
        console.error('Validation error:', error);
        indicator.className = 'status-indicator status-error';
        indicator.title = `Validation failed: ${error.message}`;
        window.dashboard.setStatus(`❌ Validation failed for ${itemId}: ${error.message}`, 'error');
        return { scoreSource: 'error', errorMessage: error?.message || 'Validation failed' };
            } finally {
            // Restore button state without clobbering new label if we updated it
            if (button) {
                if (!updatedButtonText) {
                    button.innerHTML = originalButtonText;
                }
                button.disabled = false;
            }
            
            // Update summary counts
            setTimeout(updateValidationSummary, 100);
        }
}

function exportValidationsToJSONFile() {
    let totalValidations = 0;
    Object.keys(window.dashboard.validation_results).forEach(itemId => { totalValidations += Object.keys(window.dashboard.validation_results[itemId]).length; });
    const exportData = {
        metadata: {
            exported_at: new Date().toISOString(),
            exported_by: 'Levante Pitwall Dashboard',
            version: '1.0',
            total_items: Object.keys(window.dashboard.validation_results).length,
            total_validations: totalValidations,
            languages: Object.keys(window.dashboard.languages)
        },
        validation_results: window.dashboard.validation_results
    };
    const dataStr = JSON.stringify(exportData, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', 'validation_results.json');
    linkElement.click();
}

function setValidationSummaryLoading(loading) {
    const ids = ['goodCount', 'warningCount', 'errorCount', 'pendingCount'];
    const spinner = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i>';
    const loadingLabel = document.getElementById('validationSummaryLoadingLabel');
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (loading) el.innerHTML = spinner;
            else if (el.querySelector && el.querySelector('.fa-spinner')) el.textContent = '0';
        }
    });
    if (loadingLabel) loadingLabel.style.display = loading ? 'inline-block' : 'none';
}

function updateValidationSummary() {
    const currentLanguage = window.dashboard?.currentLanguage;
    if (!currentLanguage) return;
    const currentTable = document.getElementById(`table-${currentLanguage}`);
    if (!currentTable) return;
    const indicators = currentTable.querySelectorAll('.status-indicator');
    const allowedIds = typeof getReviewTableAllowedItemIds === 'function' ? getReviewTableAllowedItemIds() : null;
    let good = 0, warning = 0, error = 0, pending = 0;
    indicators.forEach(indicator => {
        const row = indicator.closest('.data-row');
        const itemId = row ? row.dataset.itemId : indicator.getAttribute('data-item-id');
        if (allowedIds && itemId != null && !allowedIds.has(String(itemId))) return;
        if (indicator.classList.contains('status-good')) good++;
        else if (indicator.classList.contains('status-warning')) warning++;
        else if (indicator.classList.contains('status-error')) error++;
        else pending++;
    });
    const goodEl = document.getElementById('goodCount');
    const warningEl = document.getElementById('warningCount');
    const errorEl = document.getElementById('errorCount');
    const pendingEl = document.getElementById('pendingCount');
    if (goodEl) goodEl.textContent = good;
    if (warningEl) warningEl.textContent = warning;
    if (errorEl) errorEl.textContent = error;
    if (pendingEl) pendingEl.textContent = pending;
}

// Ensure inline HTML handlers can resolve these functions.
if (typeof window !== 'undefined') {
    window.setManualApprovalForValidation = setManualApprovalForValidation;
    window.showStoredValidationResult = showStoredValidationResult;
    window.validateByItemId = validateByItemId;
    window.toggleValidateAllRun = toggleValidateAllRun;
}

