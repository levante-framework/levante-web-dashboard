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

function validateAll() {
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
    const langCode = dashboard.languages[currentLanguage].lang_code;
    const itemById = new Map((dashboard.data || []).map(item => [String(item.item_id || item.identifier || ''), item]));
    const visibleRows = Array.from(currentTable.querySelectorAll('.data-row'));
    const jobs = [];
    visibleRows.forEach(row => {
        const itemId = String(row.dataset.itemId || '');
        if (!itemId) return;
        const existing = dashboard.validation_results?.[itemId]?.[langCode];
        const alreadyValidated = existing && typeof existing.score === 'number';
        if (alreadyValidated) return; // Skip rows already validated
        const item = itemById.get(itemId);
        if (!item) return;
        let translatedText = item[langCode];
        if (!translatedText && langCode.includes('-')) translatedText = item[langCode.split('-')[0]];
        if (!translatedText) {
            const key = Object.keys(item).find(k => k.toLowerCase() === langCode.toLowerCase());
            translatedText = key ? item[key] : '';
        }
        if (!translatedText) translatedText = item.en || '';
        jobs.push({
            itemId,
            originalText: item.en || '',
            translatedText: String(translatedText || ''),
            langCode
        });
    });

    if (jobs.length === 0) {
        alert('No pending translations to validate in the current language/filter.');
        return;
    }

    const concurrency = Math.min(4, jobs.length);
    if (confirm(`This will validate ${jobs.length} pending ${currentLanguage.toUpperCase()} translations (${validateBtns.length - jobs.length} already validated skipped). Continue?`)) {
        let nextIndex = 0;
        let completed = 0;
        const total = jobs.length;
        const worker = async () => {
            while (nextIndex < total) {
                const idx = nextIndex++;
                const job = jobs[idx];
                await validateSingle(job.itemId, job.originalText, job.translatedText, job.langCode);
                completed++;
                dashboard.setStatus(`Validating ${currentLanguage}: ${completed}/${total}`, 'loading');
                // Small gap helps avoid API burst/rate limits while still much faster than 1-by-1.
                await new Promise(r => setTimeout(r, 75));
            }
        };
        Promise.all(Array.from({ length: concurrency }, () => worker()))
            .then(() => {
                if (typeof updateValidationSummary === 'function') updateValidationSummary();
                dashboard.setStatus(`✅ Validation complete: ${total} pending ${currentLanguage.toUpperCase()} items`, 'success');
            })
            .catch((err) => {
                dashboard.setStatus(`⚠️ Validation finished with errors: ${err.message || err}`, 'warning');
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
            window.dashboard.setStatus(`💾 Saved ${result.itemCount} items (${result.validationCount} validations) to browser storage & shared team storage`, 'success');
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
        if (langCode === 'en') {
            // For English, just mark as good since it's the source language
            const similarity = 1.0; // Perfect score for source language
            
            // Store validation result
            if (!window.dashboard.validation_results[itemId]) {
                window.dashboard.validation_results[itemId] = {};
            }
            
            window.dashboard.validation_results[itemId][langCode] = {
                score: similarity,
                originalText: originalText,
                translatedText: translatedText,
                backTranslation: 'N/A (source language)',
                timestamp: new Date().toISOString(),
                notes: 'Source language - no translation validation needed'
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

            // Update the validate button text and functionality
            if (button) {
                button.textContent = 'Good match';
                button.title = 'Source text (no validation needed)';
                // Remove the original onclick attribute and replace with our handler
                button.removeAttribute('onclick');
                button.onclick = () => {
                    const result = window.dashboard.validation_results[itemId][langCode];
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
                const result = window.dashboard.validation_results[itemId][langCode];
                showValidationResults(itemId, langCode, result, '✅', 100, 'status-good');
            };

            window.dashboard.setStatus(`✅ Validated ${itemId}: Source language (100%)`, 'success');
            updatedButtonText = true;
            return;
        }

        // Map language codes to Google Translate compatible codes
        const googleLangCode = mapToGoogleTranslateCode(langCode);
        console.log('🌍 Language mapping:', { original: langCode, mapped: googleLangCode });

        // Call Google Translate API to back-translate from target language to English (uses server GOOGLE_TRANSLATE_APIKEY if user has no key)
        const headers = {};
        if (userKey) headers['Authorization'] = `Bearer ${userKey}`;
        const response = await fetch(`/api/google-translate?text=${encodeURIComponent(translatedText)}&from=${encodeURIComponent(googleLangCode)}&to=en`, {
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
        const backTranslation = data.translatedText;

        // Calculate similarity score (simple word overlap for now)
        const originalWords = originalText.toLowerCase().split(/\s+/);
        const backTranslatedWords = backTranslation.toLowerCase().split(/\s+/);
        const commonWords = originalWords.filter(word => backTranslatedWords.includes(word));
        const similarity = commonWords.length / Math.max(originalWords.length, backTranslatedWords.length);
        const score = Math.round((similarity * 100) * 100) / 100; // Round to 2 decimal places

        // Store validation result
        if (!window.dashboard.validation_results[itemId]) {
            window.dashboard.validation_results[itemId] = {};
        }
        
        window.dashboard.validation_results[itemId][langCode] = {
            score: score / 100, // Store as decimal for consistency
            originalText: originalText,
            translatedText: translatedText,
            backTranslation: backTranslation,
            timestamp: new Date().toISOString(),
            notes: score >= 85 ? 'Excellent translation' : score >= 70 ? 'Good translation, review recommended' : 'Poor translation quality'
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
        
        // Update the validate button text and functionality
        if (button) {
            button.textContent = buttonText;
            // Remove the original onclick attribute and replace with our handler
            button.removeAttribute('onclick');
            button.onclick = () => {
                const result = window.dashboard.validation_results[itemId][langCode];
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

        console.log('✅ Updated validation UI:', {
            indicatorClass: indicator.className,
            scoreBadgeText: scoreBadge.textContent,
            buttonText: button?.textContent,
            hasClickHandler: true
        });

        // Add click handler to show detailed results
        indicator.onclick = () => {
            const result = window.dashboard.validation_results[itemId][langCode];
            showValidationResults(itemId, langCode, result, scoreEmoji, score, statusClass);
        };

        window.dashboard.setStatus(`${scoreEmoji} Validated ${itemId}: ${score}% similarity`, 'success');

    } catch (error) {
        console.error('Validation error:', error);
        indicator.className = 'status-indicator status-error';
        indicator.title = `Validation failed: ${error.message}`;
        window.dashboard.setStatus(`❌ Validation failed for ${itemId}: ${error.message}`, 'error');
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
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (loading) el.innerHTML = spinner;
            else if (el.querySelector && el.querySelector('.fa-spinner')) el.textContent = '0';
        }
    });
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

