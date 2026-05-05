const DEFAULT_AUDIO_COPYRIGHT = 'This file was created for the LEVANTE project and is released under a Creative Commons BY-NC-SA 4.0 license';
const CROWDIN_CACHE_SCHEMA_VERSION = '2026-04-16-main-all-files-v1';

        class Dashboard {
            constructor() {
                // Load languages from external config if available; fallback to defaults
                this.languages = (window.CONFIG && window.CONFIG.languages) ? window.CONFIG.languages : {
                    'English': { lang_code: 'en', service: 'ElevenLabs', voice: 'Clara - Children\'s Storyteller' },
                    'Spanish': { lang_code: 'es-CO', service: 'ElevenLabs', voice: 'Malena Tango' },
                    'German': { lang_code: 'de', service: 'ElevenLabs', voice: 'Julia' },
                    'French': { lang_code: 'fr-CA', service: 'ElevenLabs', voice: 'Caroline - Top France - Narrative, warm, sweet', display_name: 'French (Canada)' },
                    'Dutch': { lang_code: 'nl', service: 'ElevenLabs', voice: 'Emma - Natural conversations in Dutch' },
                    'German (Switzerland)': { lang_code: 'de-CH', service: 'ElevenLabs', voice: 'Julia' }
                };
                
                this.data = [];
                this.crowdinFilesUsed = null;
                this.crowdinCacheState = '';
                this.currentLanguage = 'English';
                this.selectedRow = null;
                this.voices = { playht: [], elevenlabs: [] };
                this.dataVersion = 0;
                /** Bumped when validation_results change so lazy-render cache invalidates (DOM row datasets stay in sync). */
                this.validationResultsRevision = 0;
                this.renderSignatureByLanguage = new Map();
                this.activeRenderJobId = 0;
                this.inFlightRenderSignatureByLanguage = new Map();
                this.lazyRenderStateByLanguage = new Map();
                this.fileFilterByLanguage = new Map();
                this.approvalFilterByLanguage = new Map();
                
                // Persistent validation results dictionary
                // Structure: { item_id: { lang_code: { score: number, notes: string } } }
                this.validation_results = {};
                /** Stable snapshot string for unsaved-change detection (tab switch / leave page). */
                this.validationSaveBaseline = null;
                /** Deep clone of validation_results when baseline was last set (used for Discard). */
                this.validationSnapshotAtBaseline = null;
                this._unsavedValidationResolve = null;
                this.sharedValidationSource = 'unknown';
                this.loadedValidationLanguageCodes = new Set();
                this.excludedValidationPrefixes = [
                    'main/Z_LEGACY_DO_NOT_TRANSLATE/',
                    'main/LEGACY_DO_NOT_TRANSLATE/'
                ];
                this.reasonAutoSaveTimers = new Map();
                this.embeddingAdvisoryEnabled = (window.CONFIG?.embeddingAdvisoryEnabled !== false);
                this.embeddingAdvisoryMeta = null;
                this.embeddingAdvisoryByItem = {};
                this.latestGeneratedAudio = null;
                this.audioCopyright = DEFAULT_AUDIO_COPYRIGHT;
                this.audioMetadataCache = new Map();
                this.draftPublicBaseUrl = (window.CONFIG && window.CONFIG.draftBucketPublicBase) || 'https://storage.googleapis.com/levante-assets-draft/';
                const origin = (typeof window !== 'undefined' && window.location && window.location.origin)
                    ? window.location.origin.replace(/\/+$/, '')
                    : '';
                const defaultShareBase = origin ? `${origin}/draft-share.html` : '';
                this.draftSharePageBase = (window.CONFIG && window.CONFIG.draftSharePageBase) || defaultShareBase;
                this.selectedDraftAudio = null;
                this.approvedDrafts = new Set();
                this.pendingSaveKey = null;
                this.isRefreshingTranslations = false;
                this.elevenLabsStability = 0.65;
                this.elevenLabsStyle = 0.0;
                
                this.setupGlobalActions();
                this.init();
            }

            refreshLanguagesFromConfig() {
                try {
                    if (window.CONFIG && window.CONFIG.languages) {
                        const nextLanguages = window.CONFIG.languages;
                        if (nextLanguages && typeof nextLanguages === 'object') {
                            const sanitized = {};
                            Object.entries(nextLanguages).forEach(([name, cfg]) => {
                                if (!cfg || typeof cfg !== 'object') return;
                                sanitized[name] = {
                                    ...cfg,
                                    lang_code: String(cfg.lang_code || '').trim(),
                                    service: String(cfg.service || ''),
                                    voice: String(cfg.voice || '')
                                };
                            });
                            if (Object.keys(sanitized).length > 0) {
                                this.languages = sanitized;
                            }
                        }
                    }

                    const languageNames = Object.keys(this.languages || {});
                    if (languageNames.length > 0) {
                        if (!this.languages[this.currentLanguage]) {
                            this.currentLanguage = languageNames[0];
                        }
                        const currentCfg = this.languages[this.currentLanguage];
                        if (!currentCfg || !String(currentCfg.lang_code || '').trim()) {
                            const withLangCode = languageNames.find((name) => String(this.languages[name]?.lang_code || '').trim());
                            this.currentLanguage = withLangCode || languageNames[0];
                        }
                    }
                } catch (e) {
                    // ignore
                }
            }

            isExcludedValidationItemId(itemId) {
                const normalized = String(itemId || '').trim().toLowerCase();
                if (!normalized) return false;
                return (this.excludedValidationPrefixes || []).some((prefix) => normalized.startsWith(String(prefix).toLowerCase()));
            }

            isExcludedCrowdinPath(path) {
                const normalized = String(path || '').replace(/\\/g, '/').trim();
                if (!normalized) return false;
                const compact = normalized.replace(/^[a-z]{2}(?:-[A-Za-z]{2,4})?\//i, '').toLowerCase();
                const segments = compact.split('/').filter(Boolean);
                return segments.some((segment) => (
                    segment.startsWith('z_')
                    || segment === 'legacy_do_not_translate'
                    || segment === 'z_legacy_do_not_translate'
                ));
            }

            isSupportedCrowdinZipPath(path) {
                const normalized = String(path || '').replace(/\\/g, '/').trim();
                if (!normalized) return false;
                const lower = normalized.toLowerCase();
                if (!(lower.endsWith('.csv') || lower.endsWith('.xlf') || lower.endsWith('.xliff'))) return false;
                return this.isSupportedCrowdinSourcePath(lower);
            }

            isSupportedCrowdinSourcePath(path) {
                const normalized = String(path || '').replace(/\\/g, '/').trim().toLowerCase();
                if (!normalized) return false;
                const segments = normalized.split('/').filter(Boolean);
                if (segments.length < 3) return false;
                let baseIdx = 0;
                if (/^[a-z]{2}(?:-[a-z0-9]{2,4})?$/.test(segments[0])) {
                    if (segments[1] !== 'main') return false;
                    baseIdx = 1;
                } else if (segments[0] === 'main') {
                    baseIdx = 0;
                } else {
                    return false;
                }
                const contentGroup = segments[baseIdx + 1];
                return contentGroup === 'dashboard' || contentGroup === 'itembank_by_task' || contentGroup === 'surveys';
            }

            isExcludedCrowdinItem(item) {
                if (!item || typeof item !== 'object') return false;
                const itemId = String(item.item_id || item.identifier || item.id || item.ID || '').trim();
                if (itemId) {
                    const idPath = itemId.includes('::') ? itemId.split('::')[0] : itemId;
                    if (this.isExcludedCrowdinPath(idPath)) return true;
                }
                const sourcePaths = Array.isArray(item._sourcePaths) ? item._sourcePaths : [];
                if (sourcePaths.some((p) => this.isExcludedCrowdinPath(p))) return true;
                if (this.isExcludedCrowdinPath(item._path || '')) return true;
                return false;
            }

            sanitizeCrowdinRows(rows) {
                const data = Array.isArray(rows) ? rows : [];
                const filtered = data.filter((row) => !this.isExcludedCrowdinItem(row));
                const removed = data.length - filtered.length;
                if (removed > 0) {
                    console.log(`🧹 Removed ${removed} Z_ rows from imported translation data`);
                }
                return filtered;
            }

            sanitizeValidationResultsStore() {
                const source = this.validation_results || {};
                let removed = 0;
                Object.keys(source).forEach((itemId) => {
                    if (this.isExcludedValidationItemId(itemId)) {
                        delete source[itemId];
                        removed += 1;
                    }
                });
                this.validation_results = source;
                if (removed > 0) console.log(`🧹 Removed ${removed} excluded legacy validation items from in-memory store`);
            }

            setupGlobalActions() {
                setTimeout(() => this.bindCopyDraftLinkButton(), 0);
            }

            bindCopyDraftLinkButton(root = document) {
                const copyBtn = root.querySelector('#copyDraftBucketLink');
                if (copyBtn && !copyBtn.dataset.bound) {
                    copyBtn.addEventListener('click', () => this.copyDraftBucketLink());
                    copyBtn.dataset.bound = 'true';
                }
            }

            copyDraftBucketLink() {
                const button = document.getElementById('copyDraftBucketLink');
                const bucketName = this.selectedDraftAudio?.bucketName || this.currentDraftBucketName;
                const folder = this.selectedDraftAudio?.folder;
                const link = this.buildDraftFolderLink(folder, bucketName);
                if (!link) {
                    this.setStatus('Draft bucket link is not configured', 'warning');
                    this.showButtonFeedback(button, 'Link unavailable', 'error', 'fa-times');
                    return;
                }
                if (!folder) {
                    this.setStatus('No draft selected — copied base bucket link.', 'warning');
                }
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(link)
                        .then(() => {
                            this.setStatus(`Copied draft link${folder ? '' : ' (base only)'}`, 'success');
                            const label = folder ? 'Copied!' : 'Copied base link';
                            this.showButtonFeedback(button, label, 'success', 'fa-check');
                        })
                        .catch((error) => {
                            console.warn('Clipboard copy failed', error);
                            this.setStatus('Unable to copy link automatically. Please copy manually.', 'warning');
                            window.prompt('Copy draft bucket link:', link);
                            this.showButtonFeedback(button, 'Copy failed', 'error', 'fa-times');
                        });
                } else {
                    this.setStatus('Clipboard API unavailable. Showing link to copy manually.', 'warning');
                    window.prompt('Copy draft bucket link:', link);
                    this.showButtonFeedback(button, 'Copy manually', 'warning', 'fa-exclamation-triangle');
                }
            }

            buildDraftFolderLink(folder = '', bucketName = '') {
                const normalizedFolder = folder ? folder.replace(/^\/+/, '').replace(/\/+$/, '') : '';
                const bucket = bucketName || this.currentDraftBucketName || 'levante-assets-draft';

                if (this.draftSharePageBase) {
                    try {
                        const shareUrl = this.draftSharePageBase.startsWith('http')
                            ? new URL(this.draftSharePageBase)
                            : new URL(this.draftSharePageBase, window.location.origin);
                        if (bucket) {
                            shareUrl.searchParams.set('bucket', bucket);
                        }
                        if (normalizedFolder) {
                            const folderParam = normalizedFolder.endsWith('/') ? normalizedFolder : `${normalizedFolder}/`;
                            shareUrl.searchParams.set('folder', folderParam);
                        }
                        shareUrl.searchParams.set('mode', 'site');
                        return shareUrl.toString();
                    } catch (error) {
                        console.warn('Failed to build draft share link, falling back to bucket URL', error);
                    }
                }

                if (!this.draftPublicBaseUrl) return null;
                const base = this.draftPublicBaseUrl.replace(/\/+$/, '');
                const bucketSegment = bucket ? bucket.replace(/\/+$/, '') : '';
                const parts = [base];
                if (bucketSegment) {
                    const normalizedBase = base.replace(/\/+$/, '');
                    const baseHasBucket = normalizedBase.endsWith(`/${bucketSegment}`) || normalizedBase === bucketSegment;
                    if (!baseHasBucket) {
                        parts.push(bucketSegment);
                    }
                }
                if (normalizedFolder) parts.push(normalizedFolder);
                return `${parts.join('/')}/`;
            }

            getDisplayName(languageKey) {
                const lang = this.languages[languageKey];
                if (lang && lang.display_name) return lang.display_name;
                const langCode = String(lang?.lang_code || '').trim().toLowerCase();
                if (langCode === 'fr-ca' && /^french$/i.test(String(languageKey || ''))) return 'French (Canada)';
                return languageKey;
            }

            getCurrentLanguageCode() {
                const currentCode = String(this.languages?.[this.currentLanguage]?.lang_code || '').trim();
                if (currentCode) return currentCode;
                const fallbackLanguage = Object.keys(this.languages || {}).find((name) => String(this.languages?.[name]?.lang_code || '').trim());
                if (!fallbackLanguage) return '';
                this.currentLanguage = fallbackLanguage;
                return String(this.languages?.[fallbackLanguage]?.lang_code || '').trim();
            }

            getFlagForLanguage(language) {
                // Use small flag images (50% bigger than before)
                const flagMap = {
                    'English': '<img src="https://flagcdn.com/24x18/us.png" alt="US" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'Spanish': '<img src="https://flagcdn.com/24x18/co.png" alt="CO" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'German': '<img src="https://flagcdn.com/24x18/de.png" alt="DE" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'French': '<img src="https://flagcdn.com/24x18/ca.png" alt="CA" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'French (Canada)': '<img src="https://flagcdn.com/24x18/ca.png" alt="CA" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'Dutch': '<img src="https://flagcdn.com/24x18/nl.png" alt="NL" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    // Regional variants
                    'German (Switzerland)': '<img src="https://flagcdn.com/24x18/ch.png" alt="CH" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'Spanish (Argentina)': '<img src="https://flagcdn.com/24x18/ar.png" alt="AR" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'English (Ghana)': '<img src="https://flagcdn.com/24x18/gh.png" alt="GH" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">',
                    'Portuguese': '<img src="https://flagcdn.com/24x18/pt.png" alt="PT" style="width: 24px; height: 18px; margin-right: 6px; vertical-align: middle;">'
                };
                return flagMap[language] || '🌐'; // fallback to globe emoji
            }

            async init() {
                this.setStatus('Loading translation data...', 'loading');
                
                try {
                    // Load translation data
                    await this.loadData();
                    // Pick up any remote language config loaded by bootstrap
                    this.refreshLanguagesFromConfig();
                    
                    // Create tabs
                    this.createTabs();
                    
                    // Setup event listeners
                    this.setupEventListeners();
                    this.syncElevenLabsSettingsFromUi();
                    this.setupDataSourceControl();
                    
                    // Load comprehensive voices
                    await this.loadComprehensiveVoices();
                    
                    // Load validation results from previous sessions (but don't apply yet)
                    await this.loadValidationResults();
                    await this.loadEmbeddingAdvisory();
                    
                    // Setup auto-save on page unload
                    this.setupAutoSave();
                    this.setupUnsavedValidationWarning();
                    
                    this.setStatus('Dashboard ready - Select a language to begin', 'success');
                } catch (error) {
                    console.error('Dashboard initialization error:', error);
                    this.setStatus('Error loading dashboard', 'error');
                }
            }

            getDataSourcePreference() {
                try {
                    const stored = localStorage.getItem('levante_data_source');
                    return (stored === 'crowdin' || stored === 'csv') ? stored : 'crowdin';
                } catch (e) {
                    return 'crowdin';
                }
            }
            setDataSourcePreference(value) {
                try {
                    localStorage.setItem('levante_data_source', value);
                } catch (e) { /* ignore */ }
            }

            setupDataSourceControl() {
                const selectEl = document.getElementById('dataSourceSelect');
                const reloadBtn = document.getElementById('reloadDataBtn');
                if (selectEl) {
                    selectEl.value = this.getDataSourcePreference();
                    selectEl.addEventListener('change', () => {
                        this.setDataSourcePreference(selectEl.value);
                        this.loadData({ forceRefresh: false }).then(() => {
                            this.createTabs();
                            this.setStatus('Data source changed. Table refreshed.', 'success');
                        });
                    });
                }
                if (reloadBtn) {
                    reloadBtn.addEventListener('click', () => {
                        if (this.isRefreshingTranslations) {
                            this.setStatus('Update already in progress. Please wait...', 'warning');
                            return;
                        }
                        this.isRefreshingTranslations = true;
                        reloadBtn.disabled = true;
                        const originalHtml = reloadBtn.innerHTML;
                        reloadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating...';
                        this.loadData({ forceRefresh: true }).then(() => {
                            this.createTabs();
                            this.setStatus('Translations updated from source.', 'success');
                        }).finally(() => {
                            this.isRefreshingTranslations = false;
                            reloadBtn.disabled = false;
                            reloadBtn.innerHTML = originalHtml;
                        });
                    });
                }
            }

            async loadData(options = {}) {
                const forceRefresh = options && options.forceRefresh === true;
                const dataSource = this.getDataSourcePreference();
                const selectEl = document.getElementById('dataSourceSelect');
                if (selectEl) selectEl.value = dataSource;
                this.updateDataSourceLabel(null);

                if (dataSource === 'crowdin') {
                    const loaded = await this.loadDataFromCrowdin({ forceRefresh });
                    if (loaded) return;
                    if (forceRefresh) {
                        console.warn('Crowdin refresh failed; keeping Crowdin mode without CSV fallback');
                    } else {
                        // New sessions (or different logins/browsers) may not have local Crowdin cache yet.
                        // Attempt one automatic network refresh before falling back to partial CSV bundles.
                        const autoLoaded = await this.loadDataFromCrowdin({ forceRefresh: true, suppressAlert: true, auto: true });
                        if (autoLoaded) return;
                        console.info('No cached Crowdin data found yet; Crowdin mode requires successful refresh.');
                    }
                    // Important: legacy CSV fallback uses different identifiers than shared validation storage
                    // for many locales (notably es-CO and pt-BR), causing missing score/back-translation UI.
                    // In Crowdin mode, fail closed instead of silently loading incompatible CSV data.
                    this.setStatus('Could not load Crowdin translations. Shared validation/back-translation data will not align with CSV fallback. Please retry "Update Translations".', 'error');
                    this.updateDataSourceLabel('Crowdin unavailable');
                    return;
                }

                await this.loadDataFromCSV();
            }

            updateDataSourceLabel(source) {
                if (source !== undefined && source !== null) this.currentDataSource = source;
                const label = document.getElementById('dataSourceLabel');
                if (!label) return;
                const displaySource = (source !== undefined && source !== null) ? source : this.currentDataSource;
                if (displaySource) {
                    const cacheState = String(this.crowdinCacheState || '').trim();
                    const cacheSuffix = cacheState ? ` | Cache: ${cacheState}` : '';
                    label.textContent = `Currently loaded: ${displaySource}${cacheSuffix}`;
                }
                else label.textContent = '';
            }

            setLoadedData(rows) {
                this.data = this.sanitizeCrowdinRows(rows);
                this.attachDerivedDisplayFields(this.data);
                this.dataVersion += 1;
                this.renderSignatureByLanguage.clear();
                this.inFlightRenderSignatureByLanguage.clear();
                this.lazyRenderStateByLanguage.clear();
                this.fileFilterByLanguage.clear();
                this.activeRenderJobId += 1;
            }

            normalizeComparableText(value) {
                return String(value || '').replace(/\s+/g, ' ').trim();
            }

            simpleStableHash(value) {
                const s = this.normalizeComparableText(value);
                let hash = 2166136261;
                for (let i = 0; i < s.length; i++) {
                    hash ^= s.charCodeAt(i);
                    hash = Math.imul(hash, 16777619);
                }
                return `h${(hash >>> 0).toString(16)}`;
            }

            getConfiguredLanguageCodes() {
                return Array.from(new Set(
                    Object.values(this.languages || {})
                        .map((cfg) => String(cfg?.lang_code || '').trim())
                        .filter(Boolean)
                ));
            }

            getLanguageLikeKeys(row) {
                if (!row || typeof row !== 'object') return [];
                return Object.keys(row)
                    .map((key) => String(key || '').trim())
                    .filter((key) => /^[a-z]{2}(?:-[A-Za-z0-9]{2,4})?$/.test(key));
            }

            findExistingValidationLangKey(byItem, langCode) {
                const map = byItem && typeof byItem === 'object' ? byItem : null;
                if (!map) return '';
                const preferred = this.resolvePreferredLangCode(langCode);
                const aliases = this.getLanguageAliasCodes(langCode);
                const candidates = Array.from(new Set([preferred, langCode, ...aliases].map((c) => String(c || '').trim()).filter(Boolean)));
                for (let i = 0; i < candidates.length; i++) {
                    if (map[candidates[i]]) return candidates[i];
                }
                return '';
            }

            applyCrowdinImportChangeFlags(previousRows, nextRows) {
                const prevData = Array.isArray(previousRows) ? previousRows : [];
                const nextData = Array.isArray(nextRows) ? nextRows : [];
                if (!prevData.length || !nextData.length) return { changedEntries: 0, changedItems: 0 };
                const prevById = new Map();
                prevData.forEach((row) => {
                    const itemId = String(row?.item_id || row?.identifier || '').trim();
                    if (itemId) prevById.set(itemId, row);
                });
                const nowIso = new Date().toISOString();
                let changedEntries = 0;
                const changedItems = new Set();

                nextData.forEach((nextRow) => {
                    const itemId = String(nextRow?.item_id || nextRow?.identifier || '').trim();
                    if (!itemId) return;
                    const prevRow = prevById.get(itemId);
                    if (!prevRow) return;
                    const byItem = this.validation_results?.[itemId];
                    if (!byItem || typeof byItem !== 'object') return;

                    const sourceChanged = this.normalizeComparableText(prevRow?.en) !== this.normalizeComparableText(nextRow?.en);
                    const langCandidates = new Set([
                        ...Object.keys(byItem),
                        ...this.getConfiguredLanguageCodes(),
                        ...this.getLanguageLikeKeys(prevRow),
                        ...this.getLanguageLikeKeys(nextRow)
                    ]);

                    langCandidates.forEach((langCode) => {
                        const lang = String(langCode || '').trim();
                        if (!lang) return;
                        const existingLangKey = this.findExistingValidationLangKey(byItem, lang);
                        if (!existingLangKey) return;
                        const existingEntry = byItem[existingLangKey];
                        if (!existingEntry || typeof existingEntry !== 'object') return;
                        const prevTranslation = this.getTranslationTextForLanguage(prevRow, lang);
                        const nextTranslation = this.getTranslationTextForLanguage(nextRow, lang);
                        const translationChanged = this.normalizeComparableText(prevTranslation) !== this.normalizeComparableText(nextTranslation);
                        if (!sourceChanged && !translationChanged) return;

                        const changeKind = sourceChanged && translationChanged
                            ? 'source+translation'
                            : (sourceChanged ? 'source' : 'translation');

                        byItem[existingLangKey] = {
                            ...existingEntry,
                            requiresRevalidation: true,
                            changeKind,
                            changeDetectedAt: nowIso,
                            lastSeenSourceHash: this.simpleStableHash(nextRow?.en || ''),
                            lastSeenTranslationHash: this.simpleStableHash(nextTranslation || '')
                        };
                        changedEntries += 1;
                        changedItems.add(itemId);
                    });
                });

                if (changedEntries > 0) {
                    this.noteValidationResultsChanged();
                }
                return { changedEntries, changedItems: changedItems.size };
            }

            hasUsableTranslationsDataset(rows) {
                const data = Array.isArray(rows) ? rows : [];
                if (data.length === 0) return false;
                let withEnglish = 0;
                let withAnyTranslated = 0;
                for (let i = 0; i < data.length; i++) {
                    const row = data[i] && typeof data[i] === 'object' ? data[i] : {};
                    const enText = String(row.en || '').trim();
                    if (enText) withEnglish++;
                    const hasTranslated = Object.keys(row).some((key) => {
                        const normalized = String(key || '').trim();
                        if (!normalized || normalized.toLowerCase() === 'en') return false;
                        if (!/^[a-z]{2}(?:-[A-Za-z0-9]{2,4})?$/.test(normalized)) return false;
                        return !!String(row[key] || '').trim();
                    });
                    if (hasTranslated) withAnyTranslated++;
                    if (withEnglish > 25 && withAnyTranslated > 25) return true;
                }
                return withEnglish > 0 && withAnyTranslated > 0;
            }

            normalizeCrowdinCacheRows(rows) {
                const data = Array.isArray(rows) ? rows : [];
                const normalized = [];
                for (let i = 0; i < data.length; i++) {
                    const row = data[i] && typeof data[i] === 'object' ? { ...data[i] } : null;
                    if (!row) continue;
                    const itemId = String(row.item_id || row.identifier || row.id || row.ID || row.Item_ID || '').trim();
                    if (!itemId) continue;
                    row.item_id = itemId;
                    row.en = String(row.en || row.source || row.source_phrase || row.english || row['en-US'] || row['en_US'] || row.text || '').trim();
                    const sourcePaths = [];
                    if (Array.isArray(row._sourcePaths)) {
                        row._sourcePaths.forEach((p) => {
                            const v = String(p || '').replace(/\\/g, '/').trim();
                            if (!v) return;
                            if (this.isSupportedCrowdinSourcePath(v)) sourcePaths.push(v);
                        });
                    }
                    if (row._path) {
                        const p = String(row._path || '').replace(/\\/g, '/').trim();
                        if (p && this.isSupportedCrowdinSourcePath(p)) sourcePaths.push(p);
                    }
                    if (sourcePaths.length > 0) {
                        row._sourcePaths = Array.from(new Set(sourcePaths));
                        row._path = row._sourcePaths[0];
                    }
                    normalized.push(row);
                }
                return normalized;
            }

            attachDerivedDisplayFields(rows) {
                (rows || []).forEach((item) => {
                    if (!item || typeof item !== 'object') return;
                    const rawId = String(item.item_id || item.identifier || item.id || item.ID || '');
                    const displayItemId = rawId.includes('::') ? rawId.split('::').pop() : rawId;
                    const compactItemId = displayItemId.length > 36 ? `${displayItemId.slice(0, 33)}...` : displayItemId;
                    const meta = {
                        displayItemId,
                        compactItemId,
                        taskName: String(item.labels || item.task || 'general'),
                        contentType: String(item.contentType || 'general')
                    };
                    try {
                        Object.defineProperty(item, '__displayMeta', {
                            value: meta,
                            writable: true,
                            configurable: true,
                            enumerable: false
                        });
                    } catch (_) {
                        item.__displayMeta = meta;
                    }
                });
            }

            getCurrentRenderSignature(language) {
                const filterValue = (document.getElementById('reviewTablePathFilter')?.value || 'all');
                const fileFilterValue = this.fileFilterByLanguage.get(language) || 'all';
                const approvalFilterValue = this.getApprovalFilterForLanguage(language);
                return `${language}::${this.dataVersion}::${filterValue}::${fileFilterValue}::${approvalFilterValue}::vr${this.validationResultsRevision}`;
            }

            noteValidationResultsChanged() {
                this.validationResultsRevision += 1;
            }

            /** Rows currently shown in the main grid for a language tab (path filter + per-file filter). */
            getVisibleValidationRowsForLanguage(language) {
                const lang = language || this.currentLanguage;
                const baseRows = this.getFilteredItemsForLanguage(lang);
                const selectedFile = this.fileFilterByLanguage.get(lang) || 'all';
                if (selectedFile === 'all') return baseRows;
                return baseRows.filter((item) => this.getItemSourcePaths(item).includes(selectedFile));
            }

            getLanguageAliasCodes(langCode) {
                const raw = String(langCode || '').trim();
                if (!raw) return [];
                const normalizedHyphen = raw.replace(/_/g, '-');
                const normalizedUnderscore = raw.replace(/-/g, '_');
                const out = new Set([raw, normalizedHyphen, normalizedUnderscore]);
                const lower = normalizedHyphen.toLowerCase();
                out.add(lower);
                out.add(lower.replace(/-/g, '_'));
                const base = normalizedHyphen.includes('-') ? normalizedHyphen.split('-')[0] : normalizedHyphen;
                if (base && base !== raw) out.add(base);
                const aliasMap = {
                    'en': ['en', 'en-US'],
                    'en-us': ['en', 'en-US'],
                    'en-gb': ['en-GB', 'en-gb'],
                    'en-gh': ['en-GH', 'en-gh'],
                    'de': ['de', 'de-DE'],
                    'de-de': ['de', 'de-DE'],
                    // Treat Portuguese regional variants as aliases for validation result retrieval.
                    // This prevents saved notes/back-translations from appearing "missing" after sync
                    // when one client uses pt-BR and another uses pt-PT.
                    'pt': ['pt', 'pt-BR', 'pt-br', 'pt-PT', 'pt-pt'],
                    'pt-br': ['pt', 'pt-BR', 'pt-br', 'pt-PT', 'pt-pt'],
                    'pt-pt': ['pt', 'pt-BR', 'pt-br', 'pt-PT', 'pt-pt']
                };
                (aliasMap[lower] || []).forEach((code) => out.add(code));
                // Include case and separator variants for every alias candidate.
                Array.from(out).forEach((code) => {
                    const s = String(code || '').trim();
                    if (!s) return;
                    out.add(s.toLowerCase());
                    out.add(s.replace(/_/g, '-'));
                    out.add(s.replace(/-/g, '_'));
                    out.add(s.toLowerCase().replace(/_/g, '-'));
                    out.add(s.toLowerCase().replace(/-/g, '_'));
                });
                return Array.from(out);
            }

            /**
             * Text for the active language column: tries configured language code plus regional/base aliases
             * so CSV columns like pt-PT still show under the pt-BR tab (Crowdin headers vary by locale).
             */
            getTranslationTextForLanguage(item, langCode) {
                if (!item) return '';
                const aliases = this.getLanguageAliasCodes(langCode);
                for (let i = 0; i < aliases.length; i++) {
                    const code = aliases[i];
                    const v = item[code];
                    if (v != null && String(v).trim() !== '') return String(v).trim();
                }
                for (const key of Object.keys(item)) {
                    const keyNorm = String(key).replace(/_/g, '-').toLowerCase();
                    for (let j = 0; j < aliases.length; j++) {
                        const a = String(aliases[j]).replace(/_/g, '-').toLowerCase();
                        if (keyNorm === a) {
                            const v = item[key];
                            if (v != null && String(v).trim() !== '') return String(v).trim();
                        }
                    }
                }
                return '';
            }

            resolvePreferredLangCode(langCode) {
                const aliases = this.getLanguageAliasCodes(langCode);
                const configured = new Set(
                    Object.values(this.languages || {})
                        .map((cfg) => String(cfg?.lang_code || '').trim())
                        .filter(Boolean)
                );
                const preferred = aliases.find((code) => configured.has(code));
                return preferred || String(langCode || '');
            }

            isManualApprovedEntry(entry) {
                const result = entry && typeof entry === 'object' ? entry : {};
                const manualFlag = result.manualApproved;
                if (manualFlag === true) return true;
                if (String(manualFlag || '').trim().toLowerCase() === 'true') return true;
                if (String(manualFlag || '').trim() === '1') return true;
                const source = String(result.scoreSource || '').trim().toLowerCase();
                if (source === 'manual') return true;
                const notes = String(result.notes || '').trim().toLowerCase();
                if (notes === 'manually approved') return true;
                return false;
            }

            getValidationEntryForDisplay(itemOrId, langCode) {
                const direct = this.getValidationEntry(itemOrId, langCode);
                if (direct) return direct;
                const itemId = String(
                    (itemOrId && typeof itemOrId === 'object')
                        ? (itemOrId.item_id || itemOrId.identifier || '')
                        : (itemOrId || '')
                ).trim();
                if (!itemId) return null;
                const itemIdLower = itemId.toLowerCase();
                const storedKeys = Object.keys(this.validation_results || {});
                const matches = storedKeys.filter((storedKey) => {
                    const lower = String(storedKey || '').trim().toLowerCase();
                    if (!lower) return false;
                    return lower === itemIdLower || lower.endsWith(`::${itemIdLower}`);
                });
                if (matches.length !== 1) return null;
                const byItem = this.validation_results?.[matches[0]];
                if (!byItem || typeof byItem !== 'object') return null;
                const preferred = this.resolvePreferredLangCode(langCode);
                const aliases = this.getLanguageAliasCodes(langCode);
                const langCandidates = Array.from(new Set(
                    [preferred, langCode, ...aliases]
                        .map((code) => String(code || '').trim())
                        .filter(Boolean)
                ));
                for (let i = 0; i < langCandidates.length; i++) {
                    const candidateLang = langCandidates[i];
                    if (byItem[candidateLang]) return byItem[candidateLang];
                }
                return null;
            }

            normalizeValidationPathKey(rawPath) {
                const normalized = String(rawPath || '').replace(/\\/g, '/').trim();
                if (!normalized) return '';
                const parts = normalized.split('/').filter(Boolean);
                if (parts.length >= 2 && /^([a-z]{2}(?:-[a-z0-9]{2,4})?)$/i.test(parts[0]) && parts[1].toLowerCase() === 'main') {
                    return parts.slice(1).join('/').toLowerCase();
                }
                return normalized.toLowerCase();
            }

            getValidationEntry(itemOrId, langCode) {
                const rawItemId = String(
                    (itemOrId && typeof itemOrId === 'object')
                        ? (itemOrId.item_id || itemOrId.identifier || '')
                        : (itemOrId || '')
                ).trim();
                if (!rawItemId) return null;
                const sourcePathHints = (() => {
                    if (!itemOrId || typeof itemOrId !== 'object') return [];
                    try {
                        return this.getItemSourcePaths(itemOrId).map((p) => this.normalizeValidationPathKey(p)).filter(Boolean);
                    } catch (_) {
                        return [];
                    }
                })();

                const normalizedRaw = rawItemId
                    .replace(/\.xliff(?=::|$)/ig, '.xlf')
                    .replace(/\.xlf(?=::|$)/ig, '.xliff');
                const tail = normalizedRaw.includes('::')
                    ? String(normalizedRaw.split('::').pop() || '').trim()
                    : '';
                const tailNoQuery = tail.split(/[?#]/)[0] || tail;
                const tailPrimary = tailNoQuery.split('|')[0] || tailNoQuery;
                const tailSlashLeaf = tailPrimary.includes('/') ? tailPrimary.split('/').pop() : tailPrimary;
                const rawVariants = new Set(
                    [rawItemId, normalizedRaw]
                        .map((v) => String(v || '').trim())
                        .filter(Boolean)
                );
                [tail, tailNoQuery, tailPrimary, tailSlashLeaf].forEach((v) => {
                    const s = String(v || '').trim();
                    if (!s) return;
                    rawVariants.add(s);
                    rawVariants.add(s.toLowerCase());
                });
                const candidates = Array.from(rawVariants);
                const exactNeedles = new Set(
                    Array.from(rawVariants).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
                );
                const suffixNeedles = new Set(
                    [tail, tailNoQuery, tailPrimary, tailSlashLeaf]
                        .map((v) => String(v || '').trim().toLowerCase())
                        .filter((v) => v && v.length >= 2)
                );
                const storedKeys = Object.keys(this.validation_results || {});
                const exactMatches = storedKeys.filter((storedKey) => {
                    const lower = String(storedKey || '').trim().toLowerCase();
                    return !!lower && exactNeedles.has(lower);
                });
                exactMatches.forEach((m) => candidates.push(m));

                // Extension-swapped suffix compatibility for legacy .xlf/.xliff drift.
                const extSwapNeedles = new Set();
                Array.from(exactNeedles).forEach((needle) => {
                    if (needle.includes('.xliff')) extSwapNeedles.add(needle.replace(/\.xliff(?=::|$)/g, '.xlf'));
                    if (needle.includes('.xlf')) extSwapNeedles.add(needle.replace(/\.xlf(?=::|$)/g, '.xliff'));
                });
                if (extSwapNeedles.size > 0) {
                    storedKeys.forEach((storedKey) => {
                        const lower = String(storedKey || '').trim().toLowerCase();
                        if (extSwapNeedles.has(lower)) candidates.push(storedKey);
                    });
                }

                const suffixMatches = storedKeys.filter((storedKey) => {
                    const lower = String(storedKey || '').trim().toLowerCase();
                    if (!lower) return false;
                    for (const needle of suffixNeedles) {
                        if (lower.endsWith(`::${needle}`)) return true;
                    }
                    return false;
                });
                if (suffixMatches.length === 1) {
                    candidates.push(suffixMatches[0]);
                } else if (suffixMatches.length > 1 && sourcePathHints.length > 0) {
                    const byPath = suffixMatches.filter((storedKey) => {
                        const pathPart = String(storedKey || '').split('::')[0] || '';
                        const normalizedPath = this.normalizeValidationPathKey(pathPart);
                        return normalizedPath && sourcePathHints.some((hint) => normalizedPath.endsWith(hint) || hint.endsWith(normalizedPath));
                    });
                    if (byPath.length === 1) candidates.push(byPath[0]);
                }

                const legacyTail = rawItemId.includes('::')
                    ? String(rawItemId.split('::').pop() || '').trim()
                    : '';
                // Last-resort compatibility with historic short keys.
                if (legacyTail) {
                    const tailLower = legacyTail.toLowerCase();
                    const tailMatches = storedKeys.filter((storedKey) => {
                        const s = String(storedKey || '').trim().toLowerCase();
                        return !!s && s.endsWith(`::${tailLower}`);
                    });
                    if (tailMatches.length === 1) {
                        candidates.push(tailMatches[0]);
                    }
                }
                const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));
                const preferred = this.resolvePreferredLangCode(langCode);
                const aliases = this.getLanguageAliasCodes(langCode);
                const langCandidates = Array.from(new Set(
                    [preferred, langCode, ...aliases]
                        .map((code) => String(code || '').trim())
                        .filter(Boolean)
                ));

                // Search all matching item-id candidates before giving up.
                // This avoids stale local short-ids masking path::id keys loaded from shared storage.
                for (let i = 0; i < uniqueCandidates.length; i++) {
                    const key = uniqueCandidates[i];
                    const byItem = this.validation_results?.[key];
                    if (!byItem || typeof byItem !== 'object') continue;
                    for (let j = 0; j < langCandidates.length; j++) {
                        const candidateLang = langCandidates[j];
                        if (byItem[candidateLang]) return byItem[candidateLang];
                    }
                }
                return null;
            }

            getEmbeddingAdvisoryUrls() {
                const configured = window.CONFIG?.embeddingAdvisoryUrl;
                if (Array.isArray(configured)) return configured.filter(Boolean);
                if (typeof configured === 'string' && configured.trim()) return [configured.trim()];
                return ['/api/embedding-advisory', './data/validation/embedding-advisory.json'];
            }

            async loadEmbeddingAdvisory() {
                this.embeddingAdvisoryByItem = {};
                this.embeddingAdvisoryMeta = null;
                if (!this.embeddingAdvisoryEnabled) {
                    console.log('Embedding advisory disabled by config.');
                    return false;
                }
                const urls = this.getEmbeddingAdvisoryUrls();
                for (const url of urls) {
                    try {
                        const response = await fetch(url, { cache: 'no-store' });
                        if (!response.ok) continue;
                        const payload = await response.json();
                        const entries = Array.isArray(payload?.entries) ? payload.entries : [];
                        if (!entries.length) continue;

                        const index = {};
                        const putIndex = (key, langCode, advisoryEntry) => {
                            const normalizedKey = String(key || '').trim();
                            if (!normalizedKey) return;
                            if (!index[normalizedKey]) index[normalizedKey] = {};
                            index[normalizedKey][langCode] = advisoryEntry;
                            const lowerKey = normalizedKey.toLowerCase();
                            if (!index[lowerKey]) index[lowerKey] = {};
                            index[lowerKey][langCode] = advisoryEntry;
                        };
                        entries.forEach((entryRaw) => {
                            const entry = entryRaw && typeof entryRaw === 'object' ? entryRaw : {};
                            const itemId = String(entry.itemId || '').trim();
                            const langCode = String(entry.langCode || '').trim();
                            if (!itemId || !langCode) return;
                            const advisoryEntry = {
                                itemId,
                                langCode,
                                dataset: String(entry.dataset || ''),
                                model: String(entry.model || ''),
                                score: Number(entry.score),
                                status: String(entry.status || ''),
                                source: String(entry.source || 'embedding_offline'),
                                advisoryOnly: true,
                            };
                            putIndex(itemId, langCode, advisoryEntry);
                            // Dashboard/advisory IDs are often "path::key"; rows may only carry "key".
                            if (itemId.includes('::')) {
                                const tail = String(itemId.split('::').pop() || '').trim();
                                if (tail) putIndex(tail, langCode, advisoryEntry);
                            }
                        });
                        this.embeddingAdvisoryByItem = index;
                        this.embeddingAdvisoryMeta = {
                            sourceUrl: url,
                            generatedAt: payload?.generatedAt || null,
                            schemaVersion: payload?.schemaVersion || null,
                            thresholds: payload?.thresholds || null,
                            entryCount: entries.length,
                            advisoryOnly: true,
                        };
                        console.log(`✅ Loaded embedding advisory entries: ${entries.length} from ${url}`);
                        return true;
                    } catch (error) {
                        console.log(`Embedding advisory load skipped for ${url}:`, error?.message || error);
                    }
                }
                console.log('No embedding advisory artifact found; continuing without advisory data.');
                return false;
            }

            getEmbeddingAdvisoryEntry(itemId, langCode) {
                const rawItemId = String(itemId || '').trim();
                if (!rawItemId) return null;
                const candidates = [rawItemId];
                if (rawItemId.includes('::')) {
                    candidates.push(String(rawItemId.split('::').pop() || '').trim());
                }
                candidates.push(rawItemId.toLowerCase());
                if (rawItemId.includes('::')) {
                    const tail = String(rawItemId.split('::').pop() || '').trim();
                    if (tail) candidates.push(tail.toLowerCase());
                }

                const aliases = this.getLanguageAliasCodes(langCode);
                const preferred = this.resolvePreferredLangCode(langCode);
                const langCandidates = [langCode, preferred, ...aliases]
                    .map((code) => String(code || '').trim())
                    .filter(Boolean);

                for (let i = 0; i < candidates.length; i++) {
                    const byItem = this.embeddingAdvisoryByItem?.[candidates[i]];
                    if (!byItem) continue;
                    for (let j = 0; j < langCandidates.length; j++) {
                        const code = langCandidates[j];
                        if (byItem[code]) return byItem[code];
                    }
                }
                return null;
            }

            getCanonicalAudioLangCode(langCode) {
                const normalized = String(langCode || '').trim().toLowerCase();
                if (normalized === 'en-us') return 'en';
                if (normalized === 'de-de') return 'de';
                return String(langCode || '').trim();
            }

            normalizeValidationResultsLanguageKeys() {
                const data = this.validation_results || {};
                const groups = [
                    ['en', 'en-US'],
                    ['de', 'de-DE'],
                    ['pt', 'pt-BR', 'pt-PT']
                ];
                const configured = new Set(
                    Object.values(this.languages || {})
                        .map((cfg) => String(cfg?.lang_code || '').trim())
                        .filter(Boolean)
                );
                const ts = (entry) => String(entry?.updated || entry?.timestamp || '');
                Object.keys(data).forEach((itemId) => {
                    const byLang = data[itemId] || {};
                    groups.forEach((group) => {
                        const existing = group.filter((code) => byLang[code]);
                        if (existing.length === 0) return;
                        const configuredTarget = group.find((code) => configured.has(code));
                        const target = configuredTarget || existing[0];
                        if (existing.length === 1 && existing[0] === target) return;
                        let merged = byLang[target] || {};
                        existing.forEach((code) => {
                            const candidate = byLang[code] || {};
                            if (code === target) return;
                            if (!merged || ts(candidate) > ts(merged)) {
                                merged = { ...merged, ...candidate };
                            } else {
                                merged = { ...candidate, ...merged };
                            }
                        });
                        byLang[target] = merged;
                        group.forEach((code) => {
                            if (code !== target) delete byLang[code];
                        });
                    });
                    data[itemId] = byLang;
                });
                this.validation_results = data;
            }

            getItemSourcePaths(item) {
                const normalizeSourcePath = (rawPath) => {
                    const normalized = String(rawPath || '').replace(/\\/g, '/').trim();
                    if (!normalized) return '';
                    const parts = normalized.split('/').filter(Boolean);
                    if (parts.length >= 2 && /^([a-z]{2}(?:-[a-z0-9]{2,4})?)$/i.test(parts[0]) && parts[1].toLowerCase() === 'main') {
                        return parts.slice(1).join('/');
                    }
                    return normalized;
                };
                const paths = [];
                if (Array.isArray(item?._sourcePaths)) {
                    item._sourcePaths.forEach((p) => {
                        const normalizedPath = normalizeSourcePath(p);
                        if (normalizedPath) paths.push(normalizedPath);
                    });
                }
                if (item?._path) {
                    const normalizedPath = normalizeSourcePath(item._path);
                    if (normalizedPath) paths.push(normalizedPath);
                }
                // Backward compatibility for older cached Crowdin rows that only stored item_id.
                // Crowdin merged IDs are often "path/to/file.xliff::unit-key".
                const stableId = String(item?.item_id || item?.identifier || '');
                if (stableId.includes('::')) {
                    const candidatePath = stableId.split('::')[0];
                    if (candidatePath && candidatePath.includes('/')) {
                        const normalizedPath = normalizeSourcePath(candidatePath);
                        if (normalizedPath) paths.push(normalizedPath);
                    }
                }
                return [...new Set(paths)];
            }

            isPathRelevantForLanguage(path, language) {
                const normalizedPath = String(path || '').replace(/\\/g, '/').trim();
                if (!normalizedPath) return false;
                const langCode = String(this.languages?.[language]?.lang_code || '').trim();
                if (!langCode) return true;
                const firstSegment = normalizedPath.split('/')[0] || '';
                const firstLower = firstSegment.toLowerCase();
                const isLanguageSegment = /^[a-z]{2}(?:-[a-z0-9]{2,4})?$/i.test(firstSegment);
                // Shared dashboard CSVs should be available in every language tab.
                if (normalizedPath.toLowerCase().includes('main/dashboard/') && normalizedPath.toLowerCase().endsWith('.csv')) return true;
                // Shared/non-language paths stay visible for all tabs.
                if (!isLanguageSegment) return true;
                const aliasSet = new Set(this.getLanguageAliasCodes(langCode).map((c) => c.toLowerCase()));
                return aliasSet.has(firstLower);
            }

            getSourceFilesForRows(rows, language) {
                const files = new Set();
                (rows || []).forEach((item) => {
                    this.getItemSourcePaths(item)
                        .filter((path) => this.isPathRelevantForLanguage(path, language))
                        .forEach((path) => files.add(path));
                });
                return Array.from(files).sort((a, b) => a.localeCompare(b));
            }

            refreshFileFilterOptions(language, baseRows) {
                const selectEl = document.getElementById(`file-filter-${language}`);
                if (!selectEl) return;
                const previousValue = this.fileFilterByLanguage.get(language) || selectEl.value || 'all';
                const files = this.getSourceFilesForRows(baseRows, language);
                selectEl.innerHTML = '';
                const defaultOption = document.createElement('option');
                defaultOption.value = 'all';
                defaultOption.textContent = 'All Files';
                selectEl.appendChild(defaultOption);
                files.forEach((file) => {
                    const option = document.createElement('option');
                    option.value = String(file);
                    option.textContent = String(file);
                    selectEl.appendChild(option);
                });
                const nextValue = files.includes(previousValue) ? previousValue : 'all';
                selectEl.value = nextValue;
                this.fileFilterByLanguage.set(language, nextValue);
                selectEl.disabled = files.length === 0;
                selectEl.title = files.length
                    ? 'Filter grid to a single source file'
                    : 'No source file metadata available for this dataset';
            }

            getFilteredItemsForLanguage(language) {
                const allowedIds = typeof window.getReviewTableAllowedItemIds === 'function' ? window.getReviewTableAllowedItemIds() : null;
                if (!allowedIds) return this.data;
                return this.data.filter(item => allowedIds.has(String(item.item_id || item.identifier || '')));
            }

            getApprovalFilterForLanguage(language) {
                const raw = String(this.approvalFilterByLanguage.get(language) || 'all').trim().toLowerCase();
                return raw === 'approved' || raw === 'not-approved' ? raw : 'all';
            }

            setApprovalFilterForCurrentLanguage(filterMode) {
                this.applyApprovalFilterForLanguage(this.currentLanguage, filterMode);
            }

            setApprovalFilterBusy(language, isBusy) {
                const lang = String(language || '').trim();
                if (!lang) return;
                document.querySelectorAll('.approval-filter-btn').forEach((btn) => {
                    if (String(btn.dataset.lang || '') !== lang) return;
                    const mode = String(btn.dataset.filter || '').trim().toLowerCase();
                    const baseText = mode === 'not-approved' ? 'Not Approved' : 'Approved';
                    btn.disabled = !!isBusy;
                    btn.dataset.busy = isBusy ? '1' : '0';
                    if (isBusy) {
                        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${baseText}...`;
                        btn.style.border = '1px solid #f57c00';
                        btn.style.background = '#fff3e0';
                        btn.style.color = '#e65100';
                        btn.style.fontWeight = '700';
                    } else {
                        btn.textContent = baseText;
                    }
                });
            }

            updateApprovalFilterButtonsForLanguage(language) {
                const lang = String(language || '').trim();
                if (!lang) return;
                const active = this.getApprovalFilterForLanguage(lang);
                document.querySelectorAll('.approval-filter-btn').forEach((btn) => {
                    if (String(btn.dataset.lang || '') !== lang) return;
                    const mode = String(btn.dataset.filter || '').trim().toLowerCase();
                    const isActive = active === mode;
                    const isBusy = btn.dataset.busy === '1';
                    const baseText = mode === 'not-approved' ? 'Not Approved' : 'Approved';
                    if (isBusy) return;
                    btn.textContent = baseText;
                    btn.style.border = `1px solid ${isActive ? '#0d47a1' : '#b0bec5'}`;
                    btn.style.background = isActive ? '#e3f2fd' : '#f8f9fa';
                    btn.style.color = isActive ? '#0d47a1' : '#546e7a';
                    btn.style.fontWeight = isActive ? '700' : '500';
                });
            }

            applyApprovalFilterForLanguage(language, filterMode) {
                const lang = String(language || this.currentLanguage || '').trim();
                if (!lang) return;
                const normalized = String(filterMode || 'all').trim().toLowerCase();
                const next = normalized === 'approved' || normalized === 'not-approved' ? normalized : 'all';
                const current = this.getApprovalFilterForLanguage(lang);
                const target = current === next ? 'all' : next;
                this.approvalFilterByLanguage.set(lang, target);
                this.setApprovalFilterBusy(lang, true);
                this.updateApprovalFilterButtonsForLanguage(lang);
                const langCode = String(this.languages?.[lang]?.lang_code || '').trim();
                const shouldSync = target !== 'all' && !!langCode && typeof this.loadFromSharedStorage === 'function';
                if (!shouldSync) {
                    this.populateDataTable();
                    return;
                }
                Promise.resolve(this.loadFromSharedStorage(langCode, { force: true }))
                    .catch(() => false)
                    .finally(() => {
                        this.populateDataTable();
                    });
            }

            applyApprovalFilterToRows(rows, langCode, language) {
                const filterMode = this.getApprovalFilterForLanguage(language || this.currentLanguage);
                if (filterMode === 'all') return rows;
                const normalizedLang = String(langCode || '').trim();
                return (rows || []).filter((item) => {
                    const storedResult = this.getValidationEntryForDisplay(item, normalizedLang);
                    const isApproved = this.isManualApprovedEntry(storedResult);
                    if (filterMode === 'approved') return isApproved;
                    if (filterMode === 'not-approved') return !isApproved;
                    return true;
                });
            }

            buildValidationEntryCacheForRows(rows, langCode) {
                const out = new Map();
                const normalizedLang = String(langCode || '').trim();
                (rows || []).forEach((item) => {
                    const itemId = String(item?.item_id || item?.identifier || '').trim();
                    if (!itemId) return;
                    out.set(itemId, this.getValidationEntryForDisplay(item, normalizedLang));
                });
                return out;
            }

            getCachedValidationEntry(entryCache, item, langCode) {
                const itemId = String(item?.item_id || item?.identifier || '').trim();
                if (entryCache instanceof Map && itemId && entryCache.has(itemId)) {
                    return entryCache.get(itemId);
                }
                return this.getValidationEntryForDisplay(item, langCode);
            }

            applyApprovalFilterToRowsWithCache(rows, langCode, language, entryCache) {
                const filterMode = this.getApprovalFilterForLanguage(language || this.currentLanguage);
                if (filterMode === 'all') return rows;
                const normalizedLang = String(langCode || '').trim();
                return (rows || []).filter((item) => {
                    const storedResult = this.getCachedValidationEntry(entryCache, item, normalizedLang);
                    const isApproved = this.isManualApprovedEntry(storedResult);
                    if (filterMode === 'approved') return isApproved;
                    if (filterMode === 'not-approved') return !isApproved;
                    return true;
                });
            }

            computeValidationSummaryCountsForRows(rows, langCode, entryCache = null) {
                let good = 0, warning = 0, error = 0, needsReview = 0, approved = 0, pending = 0;
                const normalizedLang = String(langCode || '').trim();
                const isSourceEnglishTab = String(normalizedLang).split('-')[0].toLowerCase() === 'en';
                (rows || []).forEach((item) => {
                    const itemId = item?.item_id || item?.identifier || '';
                    const storedResult = this.getCachedValidationEntry(entryCache, item, normalizedLang);
                    const requiresRevalidation = storedResult?.requiresRevalidation === true;
                    if (storedResult?.needsReview === true) needsReview++;
                    if (!requiresRevalidation && this.isManualApprovedEntry(storedResult)) approved++;

                    const translatedText = this.extractTextForItem(item || {}, normalizedLang);
                    const hasTranslatedText = !!String(translatedText || '').trim();
                    const canValidateTranslation = isSourceEnglishTab || hasTranslatedText;

                    if (requiresRevalidation) {
                        pending++;
                        return;
                    }
                    if (storedResult && storedResult.score !== undefined && canValidateTranslation) {
                        const scorePercent = Number(storedResult.score) * 100;
                        if (scorePercent >= 85) good++;
                        else if (scorePercent >= 70) warning++;
                        else error++;
                    } else {
                        pending++;
                    }
                });
                return { good, warning, error, needsReview, approved, pending };
            }

            setTableLoadingState(language, isLoading, loadedCount = 0, totalCount = 0) {
                const lang = String(language || '').trim();
                if (!lang) return;
                const statusEl = document.getElementById(`table-loading-${lang}`);
                const contentEl = document.getElementById(`content-${lang}`);
                const controls = contentEl
                    ? Array.from(contentEl.querySelectorAll('.sort-controls .btn, .sort-controls select'))
                    : [];
                controls.forEach((el) => { el.disabled = !!isLoading; });
                if (!statusEl) return;
                if (isLoading) {
                    const loadedSafe = Math.max(0, Number(loadedCount) || 0);
                    const totalSafe = Math.max(0, Number(totalCount) || 0);
                    statusEl.style.display = 'inline-flex';
                    statusEl.style.alignItems = 'center';
                    statusEl.style.gap = '6px';
                    statusEl.style.padding = '4px 10px';
                    statusEl.style.borderRadius = '999px';
                    statusEl.style.border = '1px solid #f57c00';
                    statusEl.style.background = '#fff3e0';
                    statusEl.style.color = '#e65100';
                    statusEl.style.fontWeight = '800';
                    statusEl.style.fontSize = '0.92em';
                    statusEl.style.letterSpacing = '0.01em';
                    statusEl.style.boxShadow = '0 0 0 2px rgba(245, 124, 0, 0.15)';
                    statusEl.innerHTML = `<i class="fas fa-spinner fa-spin" style="font-size:1.05em;"></i> Loading Table ${loadedSafe}/${totalSafe}`;
                    return;
                }
                statusEl.style.display = 'inline-flex';
                statusEl.style.alignItems = 'center';
                statusEl.style.gap = '6px';
                statusEl.style.padding = '4px 10px';
                statusEl.style.borderRadius = '999px';
                statusEl.style.border = '1px solid #2e7d32';
                statusEl.style.background = '#e8f5e9';
                statusEl.style.fontWeight = '800';
                statusEl.style.fontSize = '0.92em';
                statusEl.style.color = '#2e7d32';
                statusEl.style.letterSpacing = '0.01em';
                statusEl.style.boxShadow = '0 0 0 2px rgba(46, 125, 50, 0.14)';
                statusEl.innerHTML = '<i class="fas fa-check-circle" style="font-size:1.05em;"></i> Table Loaded';
            }

            appendRenderBatch(state, batchSize) {
                const end = Math.min(state.offset + batchSize, state.rows.length);
                const fragment = document.createDocumentFragment();
                for (let i = state.offset; i < end; i++) {
                    const row = this.buildDataRow(state.rows[i], i, state.langCode, state.entryCache);
                    if (row) fragment.appendChild(row);
                }
                state.tableContent.appendChild(fragment);
                state.offset = end;
                this.setTableLoadingState(state.renderLanguage, true, state.offset, state.rows.length);
                return state.offset < state.rows.length;
            }

            finalizeRenderState(state) {
                if (!state || state.completed) return;
                state.completed = true;
                this.inFlightRenderSignatureByLanguage.delete(state.renderLanguage);
                this.renderSignatureByLanguage.set(state.renderLanguage, state.signature);
                if (state.renderLanguage === this.currentLanguage) {
                    if (typeof setValidationSummaryLoading === 'function') setValidationSummaryLoading(false);
                    if (typeof updateValidationSummary === 'function') updateValidationSummary();
                }
                this.setTableLoadingState(state.renderLanguage, false);
                this.setApprovalFilterBusy(state.renderLanguage, false);
                this.updateApprovalFilterButtonsForLanguage(state.renderLanguage);
                this.setupSortAndReviewHandlers();
                this.logPerf(`Render table complete (${state.renderLanguage})`, state.renderStart, `rows=${state.rows.length}`);
            }

            ensureLanguageFullyRendered(language) {
                const state = this.lazyRenderStateByLanguage.get(language);
                if (!state || state.completed) return;
                while (this.appendRenderBatch(state, 250)) { /* flush all remaining rows */ }
                this.finalizeRenderState(state);
            }

            perfNow() {
                return (typeof performance !== 'undefined' && typeof performance.now === 'function')
                    ? performance.now()
                    : Date.now();
            }

            logPerf(label, startedAt, details = '') {
                const elapsed = this.perfNow() - startedAt;
                const suffix = details ? ` | ${details}` : '';
                console.log(`[Perf] ${label}: ${elapsed.toFixed(1)}ms${suffix}`);
            }

            loadFflate() {
                return new Promise((resolve, reject) => {
                    const g = typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : {};
                    if (g.fflate && g.fflate.unzipSync) {
                        resolve();
                        return;
                    }
                    const script = document.createElement('script');
                    script.src = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js';
                    script.crossOrigin = 'anonymous';
                    script.onload = () => resolve();
                    script.onerror = () => reject(new Error('Could not load fflate from cdn.jsdelivr.net'));
                    document.head.appendChild(script);
                });
            }

            async loadDataFromCrowdin(options = {}) {
                const forceRefresh = options && options.forceRefresh === true;
                const suppressAlert = options && options.suppressAlert === true;
                const totalStart = this.perfNow();
                try {
                    if (!forceRefresh) {
                        if (await this.loadCrowdinDataFromCache()) {
                            this.logPerf('Crowdin load (cache path)', totalStart);
                            return true;
                        }
                        // Callers may opt into auto-refresh after cache miss.
                        this.setStatus('No Crowdin cache found yet. Using CSV fallback now. Click "Update Translations" to fetch Crowdin and seed cache.', 'warning');
                        return false;
                    }
                    this.setStatus('Loading from Crowdin (approved only)...', 'loading');
                    const reqStart = this.perfNow();
                    const response = await fetch('/api/crowdin-approved-translations', { cache: 'no-cache' });
                    const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
                    this.logPerf('Crowdin build request', reqStart, `status=${response.status}`);
                    if (!response.ok) {
                        const text = await response.text();
                        let msg = `HTTP ${response.status}`;
                        try {
                            const err = JSON.parse(text);
                            if (err.details || err.error) msg = err.details || err.error;
                        } catch (_) {
                            if (response.status === 504) {
                                msg = 'Crowdin build took too long (timeout). Try again in a minute.';
                            } else if (response.status === 500) {
                                msg = 'Server error (500). Often caused by: Crowdin API token not set in Vercel (CROWDIN_API_TOKEN), or the build timed out.';
                            }
                        }
                        throw new Error(msg);
                    }
                    let zipBuffer;
                    if (contentType.includes('application/json')) {
                        const jsonStart = this.perfNow();
                        const json = await response.json();
                        this.logPerf('Crowdin build response parse', jsonStart);
                        if (json.details || json.error) throw new Error(json.details || json.error);
                        if (!json.zipUrl) throw new Error('API did not return zipUrl');
                        this.setStatus('Downloading Crowdin export...', 'loading');
                        let zipRes;
                        const zipDownloadStart = this.perfNow();
                        try {
                            zipRes = await fetch(json.zipUrl, { cache: 'no-cache' });
                        } catch (directErr) {
                            zipRes = null;
                        }
                        if (!zipRes || !zipRes.ok) {
                            const proxyRes = await fetch('/api/crowdin-download-zip', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ zipUrl: json.zipUrl }),
                                cache: 'no-cache'
                            });
                            if (!proxyRes.ok) throw new Error(`ZIP download failed: ${proxyRes.status}`);
                            zipBuffer = await proxyRes.arrayBuffer();
                        } else {
                            zipBuffer = await zipRes.arrayBuffer();
                        }
                        this.logPerf('Crowdin zip download', zipDownloadStart);
                    } else {
                        const zipDownloadStart = this.perfNow();
                        zipBuffer = await response.arrayBuffer();
                        this.logPerf('Crowdin zip download (direct)', zipDownloadStart);
                    }
                    const getFflate = () => (typeof window !== 'undefined' && window.fflate) || (typeof globalThis !== 'undefined' && globalThis.fflate);
                    let fflateLib = getFflate();
                    if (!fflateLib) {
                        const fflateLoadStart = this.perfNow();
                        await this.loadFflate();
                        this.logPerf('fflate library load', fflateLoadStart);
                        fflateLib = getFflate();
                    }
                    if (!fflateLib || !fflateLib.unzipSync) throw new Error('fflate library not loaded. Allow cdn.jsdelivr.net or check your network.');
                    const nameLower = (f) => (f.name || '').toLowerCase().replace(/\\/g, '/');
                    const unzipStart = this.perfNow();
                    const unzipped = fflateLib.unzipSync(new Uint8Array(zipBuffer), {
                        filter: (f) => {
                            const n = nameLower(f);
                            if (n.includes('archive')) return false;
                            return this.isSupportedCrowdinZipPath(n);
                        }
                    });
                    this.logPerf('Crowdin zip unzip', unzipStart, `files=${Object.keys(unzipped).length}`);
                    const filteredUnzipped = {};
                    Object.entries(unzipped).forEach(([path, fileData]) => {
                        if (!this.isSupportedCrowdinZipPath(path)) return;
                        if (this.isExcludedCrowdinPath(path)) return;
                        filteredUnzipped[path] = fileData;
                    });
                    this.crowdinFilesUsed = Object.keys(filteredUnzipped).sort();
                    const mergeStart = this.perfNow();
                    const merged = this.parseCrowdinZipToMerged(filteredUnzipped);
                    this.logPerf('Crowdin CSV/XLIFF merge', mergeStart, `rows=${Array.isArray(merged) ? merged.length : 0}`);
                    if (!Array.isArray(merged) || merged.length === 0) throw new Error('No CSV or XLIFF data in Crowdin export');
                    const previousRows = Array.isArray(this.data) ? this.data : [];
                    const setDataStart = this.perfNow();
                    this.setLoadedData(merged);
                    this.logPerf('Crowdin setLoadedData', setDataStart, `rows=${this.data.length}`);
                    const importChangeSummary = this.applyCrowdinImportChangeFlags(previousRows, this.data);
                    const source = 'Crowdin (approved only)';
                    this.crowdinCacheState = '';
                    console.log(`Loaded ${this.data.length} items from ${source}`);
                    if (importChangeSummary.changedEntries > 0) {
                        this.setStatus(
                            `Loaded ${this.data.length} items from ${source}. ${importChangeSummary.changedEntries} validation entries now require revalidation (${importChangeSummary.changedItems} item(s) changed).`,
                            'warning'
                        );
                    } else {
                        this.setStatus(`Loaded ${this.data.length} items from ${source}`, 'success');
                    }
                    this.updateDataSourceLabel(source);
                    const cacheStart = this.perfNow();
                    this.cacheDataLocally(null);
                    await this.cacheCrowdinDataLocally();
                    this.logPerf('Crowdin cache writes', cacheStart);
                    this.logPerf('Crowdin load total (network path)', totalStart);
                    return true;
                } catch (error) {
                    console.warn('Crowdin load failed:', error);
                    this.setStatus(`Crowdin refresh failed (${error.message}). Using CSV fallback for now.`, 'warning');
                    // Only interrupt users when they explicitly requested a Crowdin refresh.
                    if (forceRefresh && !suppressAlert) {
                        const message = error.message || String(error);
                        alert(`Crowdin refresh failed: ${message}\n\nUsing CSV fallback for now. You can retry "Update Translations".`);
                    }
                    return false;
                }
            }

            async loadCrowdinDataFromCache() {
                const cacheStart = this.perfNow();
                try {
                    const localStart = this.perfNow();
                    const raw = localStorage.getItem('levante_crowdin_cache');
                    this.logPerf('Crowdin cache localStorage read', localStart, raw ? 'hit' : 'miss');
                    if (raw) {
                        const parseStart = this.perfNow();
                        const cached = JSON.parse(raw);
                        this.logPerf('Crowdin cache localStorage parse', parseStart, `rows=${Array.isArray(cached?.data) ? cached.data.length : 0}`);
                        if (cached && Array.isArray(cached.data) && cached.data.length > 0) {
                            const normalizedRows = this.normalizeCrowdinCacheRows(cached.data);
                            const schemaMatches = String(cached.cacheSchemaVersion || '') === CROWDIN_CACHE_SCHEMA_VERSION;
                            const canMigrateLegacy = String(cached.cacheFormat || '') === 'crowdin-full-merge';
                            if (!schemaMatches && !canMigrateLegacy) {
                                console.warn('Ignoring outdated non-migratable Crowdin cache from localStorage; refreshing with current schema.');
                            } else if (!this.hasUsableTranslationsDataset(normalizedRows)) {
                                console.warn('Ignoring invalid cached Crowdin data from localStorage (missing base/translated text).');
                            } else {
                            const setDataStart = this.perfNow();
                            this.setLoadedData(normalizedRows);
                            this.logPerf('Crowdin cache setLoadedData (localStorage)', setDataStart, `rows=${this.data.length}`);
                            this.crowdinFilesUsed = Array.isArray(cached.crowdinFilesUsed) ? cached.crowdinFilesUsed : null;
                            this.crowdinCacheState = schemaMatches ? 'current' : 'migrated';
                            const cachedAt = cached.cachedAt ? new Date(cached.cachedAt).toLocaleString() : 'previous session';
                            this.setStatus(`Loaded ${this.data.length} items from cached Crowdin data (${cachedAt}, CSV + XLIFF)`, 'success');
                            this.updateDataSourceLabel(`cached Crowdin data (retrieved ${cachedAt})`);
                            if (!schemaMatches || normalizedRows.length !== cached.data.length) {
                                console.log('♻️ Migrating cached Crowdin data to latest schema.');
                                await this.cacheCrowdinDataLocally({
                                    rows: normalizedRows,
                                    files: Array.isArray(cached.crowdinFilesUsed) ? cached.crowdinFilesUsed : (this.crowdinFilesUsed || [])
                                });
                            }
                            this.logPerf('Crowdin cache load total (localStorage)', cacheStart);
                            return true;
                            }
                        }
                    }
                } catch (error) {
                    console.warn('Could not read Crowdin cache:', error);
                }
                try {
                    const idbReadStart = this.perfNow();
                    const cached = await this.readCrowdinCacheFromIndexedDB();
                    this.logPerf('Crowdin cache IndexedDB read', idbReadStart, cached ? 'hit' : 'miss');
                    if (!cached || !Array.isArray(cached.data) || cached.data.length === 0) return false;
                    const normalizedRows = this.normalizeCrowdinCacheRows(cached.data);
                    const schemaMatches = String(cached.cacheSchemaVersion || '') === CROWDIN_CACHE_SCHEMA_VERSION;
                    const canMigrateLegacy = String(cached.cacheFormat || '') === 'crowdin-full-merge';
                    if (!schemaMatches && !canMigrateLegacy) {
                        console.warn('Ignoring outdated non-migratable Crowdin cache from IndexedDB; refreshing with current schema.');
                        return false;
                    }
                    if (!this.hasUsableTranslationsDataset(normalizedRows)) {
                        console.warn('Ignoring invalid cached Crowdin data from IndexedDB (missing base/translated text).');
                        return false;
                    }
                    const setDataStart = this.perfNow();
                    this.setLoadedData(normalizedRows);
                    this.logPerf('Crowdin cache setLoadedData (IndexedDB)', setDataStart, `rows=${this.data.length}`);
                    this.crowdinFilesUsed = Array.isArray(cached.crowdinFilesUsed) ? cached.crowdinFilesUsed : null;
                    this.crowdinCacheState = schemaMatches ? 'current' : 'migrated';
                    const cachedAt = cached.cachedAt ? new Date(cached.cachedAt).toLocaleString() : 'previous session';
                    this.setStatus(`Loaded ${this.data.length} items from cached Crowdin data (${cachedAt}, CSV + XLIFF)`, 'success');
                    this.updateDataSourceLabel(`cached Crowdin data (retrieved ${cachedAt})`);
                    if (!schemaMatches || normalizedRows.length !== cached.data.length) {
                        console.log('♻️ Migrating cached Crowdin data to latest schema.');
                        await this.cacheCrowdinDataLocally({
                            rows: normalizedRows,
                            files: Array.isArray(cached.crowdinFilesUsed) ? cached.crowdinFilesUsed : (this.crowdinFilesUsed || [])
                        });
                    }
                    this.logPerf('Crowdin cache load total (IndexedDB)', cacheStart);
                    return true;
                } catch (error) {
                    console.warn('Could not read Crowdin IndexedDB cache:', error);
                    return false;
                }
            }

            sanitizeCrowdinDataForCache(rowsOverride = null) {
                // Reduce cache size by removing diagnostic-only fields (not needed by table rendering).
                const rows = Array.isArray(rowsOverride) ? rowsOverride : (this.data || []);
                return rows.map((row) => {
                    const cleaned = {};
                    Object.keys(row || {}).forEach((key) => {
                        if (String(key).startsWith('_') && key !== '_sourcePaths' && key !== '_path') return;
                        cleaned[key] = row[key];
                    });
                    return cleaned;
                });
            }

            openCrowdinCacheDb() {
                return new Promise((resolve, reject) => {
                    if (typeof indexedDB === 'undefined') {
                        reject(new Error('IndexedDB unavailable'));
                        return;
                    }
                    const req = indexedDB.open('levante-dashboard-cache', 1);
                    req.onupgradeneeded = () => {
                        const db = req.result;
                        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
                    };
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
                });
            }

            async writeCrowdinCacheToIndexedDB(payload) {
                const db = await this.openCrowdinCacheDb();
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('kv', 'readwrite');
                    tx.objectStore('kv').put(payload, 'levante_crowdin_cache');
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
                });
                db.close();
            }

            async readCrowdinCacheFromIndexedDB() {
                const db = await this.openCrowdinCacheDb();
                const value = await new Promise((resolve, reject) => {
                    const tx = db.transaction('kv', 'readonly');
                    const req = tx.objectStore('kv').get('levante_crowdin_cache');
                    req.onsuccess = () => resolve(req.result || null);
                    req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
                });
                db.close();
                return value;
            }

            async cacheCrowdinDataLocally(options = {}) {
                try {
                    const files = Array.isArray(options?.files) ? options.files : (this.crowdinFilesUsed || []);
                    const rowsForCache = Array.isArray(options?.rows) ? options.rows : (this.data || []);
                    const compactData = this.sanitizeCrowdinDataForCache(rowsForCache);
                    const payload = {
                        cachedAt: new Date().toISOString(),
                        cacheSchemaVersion: CROWDIN_CACHE_SCHEMA_VERSION,
                        data: compactData,
                        crowdinFilesUsed: files,
                        cacheFormat: 'crowdin-full-merge',
                        cacheIncludes: {
                            csv: files.filter((f) => String(f).toLowerCase().endsWith('.csv')).length,
                            xliff: files.filter((f) => {
                                const n = String(f).toLowerCase();
                                return n.endsWith('.xlf') || n.endsWith('.xliff');
                            }).length
                        }
                    };
                    const serialized = JSON.stringify(payload);
                    let localSaved = false;
                    try {
                        localStorage.setItem('levante_crowdin_cache', serialized);
                        localSaved = true;
                    } catch (storageError) {
                        if (!String(storageError && storageError.name).includes('QuotaExceededError')) {
                            console.warn('Could not write Crowdin cache to localStorage:', storageError);
                        }
                    }
                    try {
                        await this.writeCrowdinCacheToIndexedDB(payload);
                    } catch (idbError) {
                        console.warn('Could not write Crowdin cache to IndexedDB:', idbError);
                    }
                    if (!localSaved) {
                        console.warn('Crowdin cache exceeded localStorage quota; using IndexedDB cache');
                    }
                } catch (error) {
                    console.warn('Could not cache Crowdin data locally:', error);
                }
            }

            parseCrowdinZipToMerged(unzipped) {
                const LANG_ID_TO_CODE = {
                    en: 'en',
                    'es-CO': 'es-CO',
                    es: 'es-CO',
                    de: 'de',
                    'fr-CA': 'fr-CA',
                    fr: 'fr-CA',
                    nl: 'nl',
                    'de-CH': 'de-CH',
                    'es-AR': 'es-AR',
                    'en-GH': 'en-GH',
                    pt: 'pt-BR',
                    'pt-br': 'pt-BR',
                    'pt-pt': 'pt-PT'
                };
                function langFromFirstSegment(path) {
                    const parts = String(path || '').replace(/\\/g, '/').split('/');
                    const first = (parts[0] || '').trim();
                    if (!first) return 'en';
                    const lower = first.toLowerCase();
                    return LANG_ID_TO_CODE[first] || LANG_ID_TO_CODE[lower] || (lower === 'en-us' ? 'en' : first);
                }
                function parseCSVSimple(text) {
                    const rows = [];
                    let row = [];
                    let field = '';
                    let inQuotes = false;
                    for (let i = 0; i < text.length; i++) {
                        const c = text[i];
                        const next = text[i + 1];
                        if (c === '"') {
                            if (inQuotes && next === '"') { field += '"'; i++; } else { inQuotes = !inQuotes; }
                        } else if ((c === ',' && !inQuotes) || ((c === '\n' || c === '\r') && !inQuotes)) {
                            row.push(field.trim());
                            field = '';
                            if (c === '\n' || c === '\r') {
                                if (row.some(cell => cell.length > 0)) rows.push(row);
                                row = [];
                                if (c === '\r' && next === '\n') i++;
                            }
                        } else { field += c; }
                    }
                    if (field.trim() || row.length > 0) { row.push(field.trim()); if (row.some(cell => cell.length > 0)) rows.push(row); }
                    return rows;
                }
                function rowsToObjects(rows) {
                    if (rows.length < 2) return [];
                    const headers = rows[0].map(h => (h || '').trim());
                    const result = [];
                    for (let i = 1; i < rows.length; i++) {
                        const values = rows[i];
                        const obj = {};
                        headers.forEach((h, j) => {
                            let v = values[j];
                            if (v !== undefined && typeof v === 'string') v = v.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
                            obj[h] = v ?? '';
                        });
                        result.push(obj);
                    }
                    return result;
                }
                function normalizeItem(item) {
                    const itemId = item.identifier || item.item_id || item.id || item.ID || item.Item_ID || null;
                    const task = item.task || item.labels || item.category || item.type || 'general';
                    const en = (item.en || item.source || item.source_phrase || item.english || item['en-US'] || item['en_US'] || item.text || '').trim();
                    return { ...item, item_id: itemId, labels: task, en: en || item.en || '' };
                }
                function deriveTaskAndTypeFromPath(path) {
                    const normalized = String(path || '').replace(/\\/g, '/');
                    const compact = normalized.replace(/^[a-z]{2}(?:-[A-Za-z]{2,4})?\//i, '');
                    const out = { task: 'general', contentType: 'general' };
                    function prettifyLabel(label) {
                        const raw = String(label || '').trim();
                        if (!raw) return 'general';
                        return raw
                            .replace(/\.[a-z0-9]+$/i, '')
                            .replace(/[_-]+/g, ' ')
                            .replace(/\b(short|newkeys?)\b/ig, '')
                            .replace(/\s+/g, ' ')
                            .trim()
                            .replace(/\b\w/g, (c) => c.toUpperCase());
                    }
                    const itembankMatch = compact.match(/(?:^|\/)itembank_by_task\/([^/]+)\.xli?ff$/i);
                    if (itembankMatch) {
                        out.task = prettifyLabel(itembankMatch[1] || 'general');
                        out.contentType = 'itembank';
                        return out;
                    }
                    if (compact.startsWith('main/dashboard/')) {
                        out.task = 'Dashboard';
                        out.contentType = 'dashboard';
                        return out;
                    }
                    const surveyMatch = compact.match(/(?:^|\/)surveys\/([^/]+)\.xli?ff$/i);
                    if (surveyMatch) {
                        out.task = `Survey: ${prettifyLabel(surveyMatch[1])}`;
                        out.contentType = 'survey';
                        return out;
                    }
                    const xliffOutMatch = compact.match(/(?:^|\/)xliff-out\/([^/]+)/i);
                    if (xliffOutMatch) {
                        out.task = `Survey: ${prettifyLabel(xliffOutMatch[1])}`;
                        out.contentType = 'survey';
                        return out;
                    }
                    if (compact.includes('/LEGACY_DO_NOT_TRANSLATE/')) {
                        out.task = 'legacy';
                        out.contentType = 'legacy';
                        return out;
                    }
                    return out;
                }
                function getIdFromRow(row, headers) {
                    const keys = headers && headers.length ? headers : Object.keys(row);
                    const idKey = keys.find(h => {
                        const s = String(h).trim();
                        return /identifier|item_id|item\s*id|^id$|^ID$/i.test(s);
                    });
                    const key = idKey || keys[0];
                    let v = row[key] ?? row.item_id ?? row.identifier ?? row.id ?? row.ID ?? (key ? row[key] : '');
                    if (v === '' || v == null) {
                        const altKey = keys.find(h => /item.?id|identifier/i.test(String(h)));
                        if (altKey) v = row[altKey] ?? '';
                    }
                    return String(v).trim();
                }
                function getTextFromNode(el) {
                    if (!el) return '';
                    const t = el.textContent || '';
                    return t.replace(/\s+/g, ' ').trim();
                }
                function normalizeLangCodeFromHeader(header, fallback = '') {
                    const token = String(header || fallback || '').trim();
                    if (!token) return '';
                    const mapped = LANG_ID_TO_CODE[token] || LANG_ID_TO_CODE[token.toLowerCase()] || token;
                    return String(mapped).replace(/_/g, '-');
                }
                function isLikelyLanguageHeader(header) {
                    const token = normalizeLangCodeFromHeader(header);
                    if (!token) return false;
                    if (token === 'en') return true;
                    return /^[a-z]{2}(?:-[A-Za-z0-9]{2,4})?$/.test(token);
                }
                function parseXliffToUnits(text) {
                    const units = [];
                    const XLIFF_1_2_NS = 'urn:oasis:names:tc:xliff:document:1.2';
                    const XLIFF_2_0_NS = 'urn:oasis:names:tc:xliff:document:2.0';
                    try {
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(text, 'text/xml');
                        if (doc.querySelector('parsererror')) return units;
                        function getLocalName(node) {
                            if (!node) return '';
                            return (node.localName || (node.baseName) || (node.tagName && String(node.tagName).split(':').pop()) || '').toLowerCase();
                        }
                        function byLocalName(name) {
                            const n = name.toLowerCase();
                            const namespaces = [XLIFF_1_2_NS, XLIFF_2_0_NS];
                            for (let i = 0; i < namespaces.length; i++) {
                                try {
                                    const list = doc.getElementsByTagNameNS(namespaces[i], name);
                                    if (list && list.length) return Array.from(list);
                                } catch (_) {}
                            }
                            try {
                                const list = doc.getElementsByTagNameNS('*', name);
                                if (list && list.length) return Array.from(list);
                            } catch (_) {}
                            const out = [];
                            const walk = (node) => {
                                if (node.nodeType === 1 && getLocalName(node) === n) out.push(node);
                                for (let i = 0; i < (node.childNodes?.length || 0); i++) walk(node.childNodes[i]);
                            };
                            walk(doc);
                            return out;
                        }
                        function childByLocalName(el, name) {
                            if (!el) return null;
                            const n = name.toLowerCase();
                            try {
                                const list = el.getElementsByTagNameNS('*', name);
                                if (list && list.length) return list[0];
                            } catch (_) {}
                            for (let i = 0; i < (el.childNodes?.length || 0); i++) {
                                const c = el.childNodes[i];
                                if (c.nodeType === 1 && getLocalName(c) === n) return c;
                            }
                            return null;
                        }
                        function allDescendantsByLocalName(el, name) {
                            const n = name.toLowerCase();
                            const out = [];
                            const walk = (node) => {
                                if (node.nodeType === 1 && getLocalName(node) === n) out.push(node);
                                for (let i = 0; i < (node.childNodes?.length || 0); i++) walk(node.childNodes[i]);
                            };
                            walk(el || doc);
                            return out;
                        }
                        let transUnits = doc.querySelectorAll('trans-unit');
                        if (transUnits.length === 0) transUnits = byLocalName('trans-unit');
                        if (transUnits.length) {
                            transUnits.forEach(tu => {
                                const id = tu.getAttribute('id') || '';
                                const resname = tu.getAttribute('resname') || tu.getAttribute('name') || '';
                                const src = tu.querySelector('source') || childByLocalName(tu, 'source') || allDescendantsByLocalName(tu, 'source')[0];
                                const tgt = tu.querySelector('target') || childByLocalName(tu, 'target') || allDescendantsByLocalName(tu, 'target')[0];
                                units.push({ id, resname, source: getTextFromNode(src), target: getTextFromNode(tgt) });
                            });
                            return units;
                        }
                        let unitEls = doc.querySelectorAll('unit');
                        if (unitEls.length === 0) unitEls = byLocalName('unit');
                        unitEls.forEach(unit => {
                            const id = unit.getAttribute('id') || '';
                            const resname = unit.getAttribute('name') || unit.getAttribute('resname') || '';
                            const seg = unit.querySelector('segment') || childByLocalName(unit, 'segment') || allDescendantsByLocalName(unit, 'segment')[0];
                            const src = seg ? (seg.querySelector('source') || childByLocalName(seg, 'source') || allDescendantsByLocalName(seg, 'source')[0]) : (unit.querySelector('source') || childByLocalName(unit, 'source') || allDescendantsByLocalName(unit, 'source')[0]);
                            const tgt = seg ? (seg.querySelector('target') || childByLocalName(seg, 'target') || allDescendantsByLocalName(seg, 'target')[0]) : (unit.querySelector('target') || childByLocalName(unit, 'target') || allDescendantsByLocalName(unit, 'target')[0]);
                            units.push({ id, resname, source: getTextFromNode(src), target: getTextFromNode(tgt) });
                        });
                    } catch (e) { console.warn('XLIFF parse error:', e); }
                    return units;
                }
                function getLangFromXliffPath(path) {
                    return langFromFirstSegment(path);
                }
                const byLang = {};
                for (const [path, data] of Object.entries(unzipped)) {
                    if (this.isExcludedCrowdinPath(path)) continue;
                    if (!path.toLowerCase().endsWith('.csv')) continue;
                    const text = new TextDecoder('utf-8').decode(data);
                    const rows = parseCSVSimple(text);
                    if (rows.length < 2) continue;
                    const objects = rowsToObjects(rows);
                    objects.forEach(o => { o._path = path; });
                    const normalizedPath = String(path || '').replace(/\\/g, '/');
                    const lowerPath = normalizedPath.toLowerCase();
                    const lang = langFromFirstSegment(path);
                    const headers = rows[0];
                    if (lowerPath.startsWith('main/dashboard/')) {
                        const langHeaders = headers.filter((h) => {
                            const key = String(h || '').trim();
                            if (!key) return false;
                            if (/identifier|item_id|item\s*id|^id$|^ID$/i.test(key)) return false;
                            return isLikelyLanguageHeader(key);
                        });
                        const derivedMeta = deriveTaskAndTypeFromPath(normalizedPath);
                        objects.forEach((row, index) => {
                            const rowId = getIdFromRow(row, headers) || `_dashboard_${index}`;
                            const stableId = `${normalizedPath}::${rowId}`;
                            langHeaders.forEach((headerName) => {
                                const langCode = normalizeLangCodeFromHeader(headerName, 'en');
                                const textValue = row[headerName];
                                if (textValue == null || String(textValue).trim() === '') return;
                                if (!byLang[langCode]) byLang[langCode] = { headers: ['identifier', langCode], objects: [] };
                                const existingIdx = byLang[langCode].objects.findIndex((r) => getIdFromRow(r, byLang[langCode].headers) === stableId);
                                const obj = {
                                    identifier: stableId,
                                    [langCode]: textValue,
                                    _path: path,
                                    labels: derivedMeta.task,
                                    contentType: derivedMeta.contentType
                                };
                                if (existingIdx === -1) byLang[langCode].objects.push(obj);
                                else byLang[langCode].objects[existingIdx] = obj;
                            });
                        });
                        continue;
                    }
                    if (!byLang[lang]) {
                        byLang[lang] = { headers, objects };
                    } else {
                        const cur = byLang[lang];
                        const merged = new Map();
                        cur.objects.forEach(r => { const id = getIdFromRow(r, cur.headers); merged.set(id, r); });
                        objects.forEach(r => {
                            const id = getIdFromRow(r, headers);
                            if (id && !merged.has(id)) merged.set(id, r);
                        });
                        byLang[lang] = { headers: cur.headers, objects: Array.from(merged.values()) };
                    }
                }
                let zeroUnitXliffFiles = 0;
                for (const [path, data] of Object.entries(unzipped)) {
                    if (this.isExcludedCrowdinPath(path)) continue;
                    const pl = path.toLowerCase();
                    if (!pl.endsWith('.xlf') && !pl.endsWith('.xliff')) continue;
                    const text = new TextDecoder('utf-8').decode(data);
                    const units = parseXliffToUnits(text);
                    if (!units.length) {
                        zeroUnitXliffFiles += 1;
                        continue;
                    }
                    const targetLang = getLangFromXliffPath(path);
                    const normalizedPath = String(path).replace(/\\/g, '/');
                    const pathParts = normalizedPath.split('/');
                    const canonicalPath = pathParts.length > 1 ? pathParts.slice(1).join('/') : normalizedPath;
                    const sourceLangFromPath = langFromFirstSegment(path);
                    const derivedMeta = deriveTaskAndTypeFromPath(canonicalPath);
                    const enHeaders = ['identifier', 'en'];
                    const tgtHeaders = ['identifier', targetLang];
                    units.forEach(u => {
                        const unitLocalKey = (u.resname || u.id || '').trim();
                        if (!unitLocalKey) return;
                        // Prevent collisions across files (many XLIFFs reuse small numeric ids per file).
                        // Use path without language prefix + local unit key so the same entry matches across languages.
                        const stableId = `${canonicalPath}::${unitLocalKey}`;
                        const enObj = { identifier: stableId, en: u.source, _path: path, labels: derivedMeta.task, contentType: derivedMeta.contentType };
                        const tgtObj = { identifier: stableId, [targetLang]: u.target, _path: path, labels: derivedMeta.task, contentType: derivedMeta.contentType };
                        if (!byLang.en) byLang.en = { headers: enHeaders, objects: [] };
                        const existingEnIdx = byLang.en.objects.findIndex(r => getIdFromRow(r, byLang.en.headers) === stableId);
                        if (existingEnIdx === -1) {
                            byLang.en.objects.push(enObj);
                        } else {
                            // Prefer true English source files for byLang.en when they exist.
                            const existingPath = String(byLang.en.objects[existingEnIdx]._path || '');
                            const existingLang = langFromFirstSegment(existingPath);
                            if (sourceLangFromPath === 'en' && existingLang !== 'en') {
                                byLang.en.objects[existingEnIdx] = enObj;
                            }
                        }
                        if (!byLang[targetLang]) byLang[targetLang] = { headers: tgtHeaders, objects: [] };
                        const hasTgt = byLang[targetLang].objects.some(r => getIdFromRow(r, byLang[targetLang].headers) === stableId);
                        if (!hasTgt) byLang[targetLang].objects.push(tgtObj);
                    });
                    console.log('Crowdin XLIFF:', path, '→', targetLang, units.length, 'units');
                }
                if (zeroUnitXliffFiles > 0) {
                    console.info('Crowdin XLIFF files with 0 units:', zeroUnitXliffFiles);
                }
                const baseLang = byLang.en ? 'en' : Object.keys(byLang)[0];
                if (!baseLang || !byLang[baseLang]) return [];
                // Union of all item ids across ALL language files (so we get 830 if any language has 830, not just base)
                const allIds = new Set();
                const langCounts = {};
                Object.keys(byLang).forEach(lang => {
                    const cur = byLang[lang];
                    langCounts[lang] = cur.objects.length;
                    cur.objects.forEach((r, i) => {
                        const id = getIdFromRow(r, cur.headers) || `_row_${lang}_${i}`;
                        allIds.add(id);
                    });
                });
                console.log('Crowdin merge: byLang counts', langCounts, 'union size', allIds.size);
                const idList = Array.from(allIds);
                const baseHeaders = byLang[baseLang].headers || [];
                function getRowByLang(lang, id) {
                    if (String(id).startsWith('_row_')) {
                        const parts = String(id).split('_');
                        const langPart = parts[2];
                        if (langPart !== lang) return null;
                        const i = parseInt(parts[3], 10);
                        if (byLang[langPart] && byLang[langPart].objects[i] !== undefined) return byLang[langPart].objects[i];
                        return null;
                    }
                    return (byLang[lang] && byLang[lang].objects.find(r => getIdFromRow(r, byLang[lang].headers) === id)) || null;
                }
                return idList.map((id, idx) => {
                    const baseRow = getRowByLang(baseLang, id) || Object.keys(byLang).map(lang => getRowByLang(lang, id)).find(Boolean);
                    const row = baseRow || {};
                    const enRow = byLang.en ? getRowByLang('en', id) : null;
                    const enText = enRow ? (enRow.en || enRow.source || enRow.english || enRow.text || '') : (row.en || row.source || row.english || row.text || '');
                    const out = { ...row, item_id: id, labels: row.task || row.labels || 'general', contentType: row.contentType || 'general', en: enText };
                    const sourcePaths = [];
                    if (baseRow && baseRow._path) sourcePaths.push(baseRow._path);
                    Object.keys(byLang).forEach(lang => {
                        const other = getRowByLang(lang, id);
                        if (other) {
                            if (other._path) sourcePaths.push(other._path);
                            const otherHeaders = byLang[lang].headers || Object.keys(other);
                            const textKey = otherHeaders.find(h => h && !/identifier|item_id|^id$/i.test(String(h)) && (h === lang || h.replace(/_/g, '-') === lang || h.toLowerCase() === lang.toLowerCase()));
                            if (textKey) out[lang] = other[textKey] ?? '';
                            else out[lang] = other.en || other.source || other.english || other.text || '';
                        }
                    });
                    out._sourcePaths = [...new Set(sourcePaths)];
                    if (out.labels === 'general') {
                        const derived = deriveTaskAndTypeFromPath(out._sourcePaths[0] || out._path || '');
                        out.labels = derived.task;
                        if (!out.contentType || out.contentType === 'general') out.contentType = derived.contentType;
                    }
                    return normalizeItem(out);
                });
            }

            async loadDataFromCSV() {
                try {
                    // Prefer full cached Crowdin bundle (CSV + XLIFF merged) before remote CSV fallbacks.
                    // This keeps source/label messaging consistent and avoids partial CSV-only states.
                    if (await this.loadCrowdinDataFromCache()) return;

                    const cfg = (window.CONFIG && window.CONFIG.dataSources) || {};
                    const configuredItemBank = cfg.remoteCSV || null;
                    const configuredSurveys = cfg.remoteSurveysCSV || (
                        configuredItemBank && configuredItemBank.endsWith('/item-bank-translations.csv')
                            ? configuredItemBank.replace('/item-bank-translations.csv', '/surveys.csv')
                            : null
                    );
                    const remoteUrls = Array.from(new Set([
                        configuredItemBank,
                        configuredSurveys,
                        'https://raw.githubusercontent.com/levante-framework/levante_translations/l10n_pending/translations/item-bank-translations.csv',
                        'https://raw.githubusercontent.com/levante-framework/levante_translations/l10n_pending/translations/surveys.csv',
                        'https://raw.githubusercontent.com/levante-framework/levante_translations/l10n_pending/text/translated_prompts.csv'
                    ].filter(Boolean)));

                    const loadedBatches = [];
                    for (const url of remoteUrls) {
                        try {
                            this.setStatus('Loading translation data...', 'loading');
                            const response = await fetch(url);
                            if (!response.ok) continue;
                            const csvText = await response.text();
                            if (!csvText || !csvText.trim()) continue;
                            const parsed = this.parseCSV(csvText);
                            if (!Array.isArray(parsed) || parsed.length === 0) continue;
                            loadedBatches.push({ url, rows: parsed });
                        } catch (e) {
                            console.warn('Fetch failed for', url, e);
                            continue;
                        }
                    }

                    if (loadedBatches.length > 0) {
                        const mergedById = new Map();
                        const inferSourcePathFromBatch = (batchUrl, row) => {
                            const explicitPath = String(row?._path || '').trim();
                            if (explicitPath) return explicitPath;
                            const lower = String(batchUrl || '').toLowerCase();
                            if (lower.includes('/translations/item-bank-translations.csv')) {
                                return 'main/itembank_by_task/item-bank-translations.csv';
                            }
                            if (lower.includes('/translations/surveys.csv')) {
                                return 'main/surveys/surveys.csv';
                            }
                            if (lower.includes('/text/translated_prompts.csv')) {
                                return 'main/dashboard/text/translated_prompts.csv';
                            }
                            return String(batchUrl || '').trim();
                        };
                        loadedBatches.forEach((batch) => {
                            batch.rows.forEach((row, index) => {
                                const inferredSourcePath = inferSourcePathFromBatch(batch.url, row);
                                const rowSourcePaths = Array.isArray(row?._sourcePaths)
                                    ? row._sourcePaths.map((p) => String(p || '').trim()).filter(Boolean)
                                    : [];
                                const normalizedRow = {
                                    ...row,
                                    ...(inferredSourcePath ? { _path: String(row?._path || '').trim() || inferredSourcePath } : {}),
                                    ...(inferredSourcePath || rowSourcePaths.length
                                        ? { _sourcePaths: [...new Set([...(rowSourcePaths || []), ...(inferredSourcePath ? [inferredSourcePath] : [])])] }
                                        : {})
                                };
                                const rawId = String(
                                    normalizedRow.item_id || normalizedRow.identifier || normalizedRow.id || normalizedRow.ID || normalizedRow.Item_ID || ''
                                ).trim();
                                const key = rawId ? rawId.toLowerCase() : `${batch.url}::${index}`;
                                const existing = mergedById.get(key);
                                if (!existing) {
                                    mergedById.set(key, normalizedRow);
                                    return;
                                }
                                const mergedSourcePaths = [...new Set([
                                    ...(Array.isArray(existing._sourcePaths) ? existing._sourcePaths : []),
                                    ...(Array.isArray(normalizedRow._sourcePaths) ? normalizedRow._sourcePaths : [])
                                ])];
                                mergedById.set(key, {
                                    ...existing,
                                    ...normalizedRow,
                                    item_id: existing.item_id || normalizedRow.item_id,
                                    _path: existing._path || normalizedRow._path || '',
                                    _sourcePaths: mergedSourcePaths
                                });
                            });
                        });

                        this.crowdinFilesUsed = null;
                        this.setLoadedData(Array.from(mergedById.values()));
                        const source = `CSV bundle (${loadedBatches.length} files)`;
                        console.log(`Loaded ${this.data.length} items from ${source}`);
                        console.log('CSV files used:', loadedBatches.map((b) => b.url));
                        this.setStatus(`Loaded ${this.data.length} items from ${source}`, 'success');
                        this.updateDataSourceLabel(source);
                        this.cacheDataLocally(null);
                        return;
                    }

                    let csvText = null;
                    let source = '';
                    if (!csvText) {
                        try {
                            this.setStatus('Checking for local complete CSV...', 'loading');
                            const localResponse = await fetch('./translation_text/complete_translations.csv');
                            if (localResponse.ok) {
                                csvText = await localResponse.text();
                                source = 'local complete CSV';
                            }
                        } catch (localError) {
                            console.log('Local complete CSV not found.');
                        }
                    }

                    if (csvText) {
                        this.crowdinFilesUsed = null;
                        this.setLoadedData(this.parseCSV(csvText));
                        console.log(`Loaded ${this.data.length} items from ${source}`);
                        this.setStatus(`Loaded ${this.data.length} items from ${source}`, 'success');
                        this.updateDataSourceLabel(source);
                        this.cacheDataLocally(csvText);
                        return;
                    }
                    throw new Error('No CSV data source available');
                } catch (error) {
                    console.warn('Could not load CSV data, trying cache...', error);
                    try {
                        const cachedData = localStorage.getItem('levante_translations_cache');
                        if (cachedData) {
                            this.crowdinFilesUsed = null;
                            this.setLoadedData(JSON.parse(cachedData));
                            this.setStatus(`Loaded ${this.data.length} items from cache (offline)`, 'success');
                            this.updateDataSourceLabel('cache');
                        } else {
                            throw new Error('No cached data available');
                        }
                    } catch (cacheError) {
                        console.warn('Cache also failed, using sample data:', cacheError);
                        this.crowdinFilesUsed = null;
                        this.setLoadedData(this.loadSampleData());
                        this.setStatus('Using sample data - all sources failed', 'error');
                        this.updateDataSourceLabel('sample data');
                    }
                }
            }
            
            cacheDataLocally(csvText) {
                try {
                    // Cache the parsed data in localStorage for offline use
                    localStorage.setItem('levante_translations_cache', JSON.stringify(this.data));
                    console.log('Translation data cached locally for offline use');
                } catch (error) {
                    console.warn('Could not cache data locally:', error);
                }
            }

            parseCSV(csvText) {
                if (!csvText || !csvText.trim()) return [];
                
                console.log('🔧 Robust CSV Parser: Starting parse...');
                
                // First, try to parse with proper CSV logic that handles embedded newlines
                const rows = this.parseCSVWithEmbeddedNewlines(csvText);
                
                if (rows.length === 0) return [];
                
                const headers = rows[0];
                console.log('CSV Headers:', headers);
                
                const data = [];
                
                // Parse data rows (skip header)
                for (let i = 1; i < rows.length; i++) {
                    const values = rows[i];
                    
                    if (values.length >= headers.length) {
                        const row = {};
                        headers.forEach((header, index) => {
                            let value = values[index] || '';
                            
                            // Clean up embedded newlines in the value
                            if (typeof value === 'string') {
                                // Replace literal \n characters with <br> for display
                                value = value.replace(/\n/g, '<br>');
                                // Clean up extra whitespace
                                value = value.replace(/\s+/g, ' ').trim();
                            }
                            
                            row[header] = value;
                        });
                        data.push(row);
                    } else {
                        console.warn(`Row ${i} has ${values.length} columns, expected ${headers.length}:`, values);
                    }
                }
                
                console.log(`🔧 Robust CSV Parser: Parsed ${data.length} rows successfully`);
                console.log('Sample parsed data:', data.slice(0, 3));
                
                // Normalize data to ensure consistent field names
                const normalizedData = data.map(item => {
                    // Handle different possible column names for ID
                    const itemId = item.identifier || item.item_id || item.id || item.ID || item.Item_ID || null;
                    
                    // Handle different possible column names for task/labels
                    const task = item.task || item.labels || item.category || item.type || 'general';
                    
                    // Normalize English/source string so dashboard always has item.en
                    const en = (item.en || item.source || item.source_phrase || item.english || item['en-US'] || item['en_US'] || item.text || '').trim();
                    
                    return {
                        ...item,
                        item_id: itemId,
                        labels: task,
                        en: en || item.en || ''
                    };
                });
                
                console.log('Normalized data sample:', normalizedData.slice(0, 3));
                return normalizedData;
            }

            parseCSVWithEmbeddedNewlines(csvText) {
                // Robust CSV parser that properly handles quoted fields with embedded newlines
                const rows = [];
                let currentRow = [];
                let currentField = '';
                let inQuotes = false;
                let i = 0;
                
                while (i < csvText.length) {
                    const char = csvText[i];
                    const nextChar = i + 1 < csvText.length ? csvText[i + 1] : null;
                    
                    if (char === '"') {
                        if (inQuotes && nextChar === '"') {
                            // Escaped quote - add literal quote to field
                            currentField += '"';
                            i += 2; // Skip both quotes
                        } else {
                            // Toggle quote state
                            inQuotes = !inQuotes;
                            i++;
                        }
                    } else if (char === ',' && !inQuotes) {
                        // Field separator outside quotes
                        currentRow.push(currentField.trim());
                        currentField = '';
                        i++;
                    } else if ((char === '\n' || char === '\r') && !inQuotes) {
                        // Row separator outside quotes
                        if (currentField.trim() || currentRow.length > 0) {
                            currentRow.push(currentField.trim());
                            if (currentRow.some(field => field.length > 0)) {
                                rows.push(currentRow);
                            }
                            currentRow = [];
                            currentField = '';
                        }
                        // Skip \r\n combinations
                        if (char === '\r' && nextChar === '\n') {
                            i += 2;
                        } else {
                            i++;
                        }
                    } else {
                        // Regular character or newline inside quotes
                        currentField += char;
                        i++;
                    }
                }
                
                // Handle final field/row
                if (currentField.trim() || currentRow.length > 0) {
                    currentRow.push(currentField.trim());
                    if (currentRow.some(field => field.length > 0)) {
                        rows.push(currentRow);
                    }
                }
                
                console.log(`🔧 Robust CSV Parser: Found ${rows.length} rows`);
                
                // Filter out empty rows
                const validRows = rows.filter(row => 
                    row.length > 0 && row.some(field => field && field.trim().length > 0)
                );
                
                console.log(`🔧 Robust CSV Parser: ${validRows.length} valid rows after filtering`);
                return validRows;
            }

            parseCSVLine(line) {
                const result = [];
                let current = '';
                let inQuotes = false;
                let i = 0;
                
                while (i < line.length) {
                    const char = line[i];
                    
                    if (char === '"') {
                        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
                            // Handle escaped quotes
                            current += '"';
                            i += 2;
                        } else {
                            // Toggle quote state
                            inQuotes = !inQuotes;
                            i++;
                        }
                    } else if (char === ',' && !inQuotes) {
                        result.push(current.trim());
                        current = '';
                        i++;
                    } else {
                        current += char;
                        i++;
                    }
                }
                
                result.push(current.trim());
                return result;
            }

            loadSampleData() {
                return [
                    { item_id: 'sample_1', labels: 'general', en: 'Hello, welcome to the test.', 'es-CO': 'Hola, bienvenido a la prueba.', de: 'Hallo, willkommen zum Test.', 'fr-CA': 'Bonjour, bienvenue au test.', nl: 'Hallo, welkom bij de test.' },
                    { item_id: 'sample_2', labels: 'math', en: 'Count the numbers.', 'es-CO': 'Cuenta los números.', de: 'Zähle die Zahlen.', 'fr-CA': 'Comptez les nombres.', nl: 'Tel de nummers.' },
                    { item_id: 'sample_3', labels: 'vocab', en: 'What is this word?', 'es-CO': '¿Qué es esta palabra?', de: 'Was ist dieses Wort?', 'fr-CA': 'Quel est ce mot?', nl: 'Wat is dit woord?' }
                ];
            }

            async loadRealElevenLabsVoices() {
                const credentials = getCredentials();
                const elevenKey = credentials.elevenlabs_api_key || credentials.elevenlabsApiKey;
                if (!elevenKey) {
                    console.warn('No ElevenLabs API key - skipping real voice loading');
                    return {}; // Return empty object if no API key
                }

                try {
                    // Create a proxy endpoint to get ElevenLabs voices
                        const response = await fetch('/api/elevenlabs-proxy', {
                        method: 'GET',
                        headers: {
                            'X-API-KEY': elevenKey
                        }
                    });

                    if (!response.ok) {
                        throw new Error(`Failed to load ElevenLabs voices: ${response.status}`);
                    }

                    const voicesData = await response.json();
                    
                    // Process voices and organize by languages present in dashboard (and their base codes)
                    const organizedVoices = {};
                    const configuredCodes = Object.values(this.languages).map(cfg => cfg.lang_code);
                    const uniqueCodes = Array.from(new Set(configuredCodes.concat(configuredCodes.map(c => c.split('-')[0]))));

                    for (const langCode of uniqueCodes) {
                        const apiLangCode = langCode.split('-')[0];
                        const languageVoices = voicesData.voices.filter(voice => {
                            const voiceLanguage = voice.labels?.language;
                            return voiceLanguage === apiLangCode && (
                                voice.category === "professional" ||
                                voice.category === "shared" ||
                                voice.category === "premade" ||
                                voice.category === "generated" ||
                                voice.category === "personal"
                            );
                        });

                        organizedVoices[langCode] = languageVoices.map(voice => ({
                            voice_id: voice.voice_id,
                            name: voice.name,
                            language: langCode,
                            gender: voice.labels?.gender || 'unknown'
                        }));
                    }

                    console.log('Loaded real ElevenLabs voices:', organizedVoices);
                    return organizedVoices;
                    
                } catch (error) {
                    console.error('Failed to load real ElevenLabs voices:', error);
                    return {}; // Return empty object on error
                }
            }

            async loadComprehensiveVoices() {
                this.setStatus('Loading comprehensive voices...', 'loading');
                
                // Load real ElevenLabs voices from your actual voice library
                const realElevenLabsVoices = await this.loadRealElevenLabsVoices();
                
                // Comprehensive voice data with hundreds of voices (restored from working version)
                const comprehensiveVoices = {
                    playht: {
                        "en": [
                            {"voice_id": "s3://voice-cloning-zero-shot/adb83b67-8d75-48ff-ad4d-a0840d231ef1/original/manifest.json", "name": "Inara", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/820da3d2-3a3b-42e7-844d-e68db835a206/sarah/manifest.json", "name": "Sarah", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/97580643-b568-4198-aaa4-3e07e4a06c47/original/manifest.json", "name": "Indigo", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/a0fa25cc-5f42-4dd0-8a78-a950dd5297cd/original/manifest.json", "name": "Isabella", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/32b943f6-87cf-4e15-8e7a-d4cb848e3689/original/manifest.json", "name": "Scarlett", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/f6c4ed76-1b55-4cd9-8896-31f7535f6cdb/original/manifest.json", "name": "Aaliyah", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/80ba8839-a6e6-470c-8f68-7c1e5d3ee2ff/abigailsaad/manifest.json", "name": "Abigail", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/d9ff78ba-d016-47f6-b0ef-dd630f59414e/female-cs/manifest.json", "name": "Ruby", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/fdb74aec-ede9-45f8-ad87-71cb45f01816/original/manifest.json", "name": "Carmen", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/e5df2eb3-5153-40fa-9f6e-6e27bbb7a38e/original/manifest.json", "name": "Navya", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/f3c22a65-87e8-441f-aea5-10a1c201e522/original/manifest.json", "name": "Sumita", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/928ed0a0-2271-4710-a7c9-1711d36b9897/original/manifest.json", "name": "Niamh", "language": "en", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/30884451-1eff-4fd8-9a24-d1ee3353b215/original/manifest.json", "name": "Siobhán", "language": "en", "gender": "female"}
                        ],
                        "de": [
                            {"voice_id": "s3://voice-cloning-zero-shot/3d1a2ebc-6fe3-4b9b-b8f3-d23a3e5b6c7d/original/manifest.json", "name": "German_Anke Narrative", "language": "de", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/820da3d2-3a3b-42e7-844d-e68db835a206/german_female/manifest.json", "name": "German Female", "language": "de", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/d4f2c5a1-8b3e-4f2d-9c7a-1e5b8d3f6a9c/original/manifest.json", "name": "Greta", "language": "de", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/b8e3f2d1-5c4a-6f8b-2d9e-7a1c3f5e8b2d/original/manifest.json", "name": "Ingrid", "language": "de", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/f7a2d8e3-9b1c-4e5f-8d2a-6c9e3f1b5a7d/original/manifest.json", "name": "Petra", "language": "de", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/c5f8a1d2-7e3b-6c9f-1a4d-8b2e5f9c3a6d/original/manifest.json", "name": "Ursula", "language": "de", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/a9c2f5e8-3d1b-7f4a-5e8c-2a6f9d3b1e7c/original/manifest.json", "name": "Brigitte", "language": "de", "gender": "female"}
                        ],
                        "es": [
                            {"voice_id": "s3://voice-cloning-zero-shot/e8f3a2d1-5c7b-9e4f-2a6d-8c1f5b3e9a7d/original/manifest.json", "name": "María", "language": "es", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/f2a8d5c1-9e3b-7f4a-6d2e-1c5f8b9a3d7e/original/manifest.json", "name": "Carmen", "language": "es", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/d7c1f5a8-2e9b-4f3d-8a1c-6e5f2b9d3a7c/original/manifest.json", "name": "Isabella", "language": "es", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/b5e8f2a1-7c3d-9f6a-3e1b-8d5f2c7a9e4f/original/manifest.json", "name": "Sofia", "language": "es", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/c9a3f7e2-1d5b-8f4c-6a2e-9f3d1b7c5a8e/original/manifest.json", "name": "Valentina", "language": "es", "gender": "female"}
                        ],
                        "fr": [
                            {"voice_id": "s3://voice-cloning-zero-shot/a1f5c8e3-9d2b-7f4a-5c8e-3a1f6d9b2e7c/original/manifest.json", "name": "Amélie", "language": "fr", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/e7c2f9a5-3d1b-8f6c-2a5e-9c3f1d7b5a8e/original/manifest.json", "name": "Camille", "language": "fr", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/f3a7e1c5-8d2b-9f4a-6c1e-5a8f3d2b7c9e/original/manifest.json", "name": "Élise", "language": "fr", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/d8f1c5a2-7e3b-6f9c-1a4d-8c2f5e9a3d7f/original/manifest.json", "name": "Juliette", "language": "fr", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/c2a9f5e1-3d7b-8f4c-5a2e-9f1d3c7a5e8f/original/manifest.json", "name": "Margot", "language": "fr", "gender": "female"}
                        ],
                        "nl": [
                            {"voice_id": "s3://voice-cloning-zero-shot/f5a2d8c1-9e3b-7f4a-6d1c-8e5f2a9d3c7e/original/manifest.json", "name": "Emma", "language": "nl", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/e1c7f9a3-5d2b-8f6c-3a1e-9c5f7d2a8e4f/original/manifest.json", "name": "Sophie", "language": "nl", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/a8f3c2d5-1e7b-9f4a-5c2e-8a3f1d7c9e5f/original/manifest.json", "name": "Lotte", "language": "nl", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/d2c8f1a5-7e3b-6f9c-2a5d-8c1f3e9a7d5c/original/manifest.json", "name": "Iris", "language": "nl", "gender": "female"},
                            {"voice_id": "s3://voice-cloning-zero-shot/c7a1f5e8-3d9b-8f2c-6a1e-9f5d3c8a2e7f/original/manifest.json", "name": "Fleur", "language": "nl", "gender": "female"}
                        ]
                    },
                    elevenlabs: realElevenLabsVoices || {
                        "en": [
                            {"voice_id": "kdmDKE6EkgrWrrykO9Qt", "name": "Alexandra - Conversational and Real", "language": "en", "gender": "female"},
                            {"voice_id": "yu4eXTP5aod8KAQzTI3T", "name": "Claudia - Credible, Competent & Authentic", "language": "en", "gender": "female"},
                            {"voice_id": "aMSt68OGf4xUZAnLpTU8", "name": "Juniper", "language": "en", "gender": "female"},
                            {"voice_id": "bIHbv24MWmeRgasZH58o", "name": "Will", "language": "en", "gender": "male"},
                            {"voice_id": "EXAVITQu4vr4xnSDxMaL", "name": "Bella", "language": "en", "gender": "female"},
                            {"voice_id": "ErXwobaYiN019PkySvjV", "name": "Antoni", "language": "en", "gender": "male"},
                            {"voice_id": "MF3mGyEYCl7XYWbV9V6O", "name": "Elli", "language": "en", "gender": "female"},
                            {"voice_id": "TxGEqnHWrfWFTfGW9XjX", "name": "Josh", "language": "en", "gender": "male"},
                            {"voice_id": "VR6AewLTigWG4xSOukaG", "name": "Arnold", "language": "en", "gender": "male"},
                            {"voice_id": "pNInz6obpgDQGcFmaJgB", "name": "Adam", "language": "en", "gender": "male"},
                            {"voice_id": "yoZ06aMxZJJ28mfd3POQ", "name": "Sam", "language": "en", "gender": "male"},
                            {"voice_id": "AZnzlk1XvdvUeBnXmlld", "name": "Domi", "language": "en", "gender": "female"},
                            {"voice_id": "CYw3kZ02Hs0563khs1Fj", "name": "Dave", "language": "en", "gender": "male"},
                            {"voice_id": "D38z5RcWu1voky8WS1ja", "name": "Fin", "language": "en", "gender": "male"},
                            {"voice_id": "IKne3meq5aSn9XLyUdCD", "name": "Charlie", "language": "en", "gender": "male"},
                            {"voice_id": "JBFqnCBsd6RMkjVDRZzb", "name": "George", "language": "en", "gender": "male"},
                            {"voice_id": "N2lVS1w4EtoT3dr4eOWO", "name": "Callum", "language": "en", "gender": "male"},
                            {"voice_id": "SOYHLrjzK2X1ezoPC6cr", "name": "Harry", "language": "en", "gender": "male"},
                            {"voice_id": "ThT5KcBeYPX3keUQqHPh", "name": "Dorothy", "language": "en", "gender": "female"},
                            {"voice_id": "XB0fDUnXU5powFXDhCwa", "name": "Charlotte", "language": "en", "gender": "female"},
                            {"voice_id": "Xb7hH8MSUJpSbSDYk0k2", "name": "Alice", "language": "en", "gender": "female"},
                            {"voice_id": "XrExE9yKIg1WjnnlVkGX", "name": "Matilda", "language": "en", "gender": "female"},
                            {"voice_id": "Zlb1dXrM653N07WRdFW3", "name": "Lily", "language": "en", "gender": "female"},
                            {"voice_id": "g5CIjZEefAph4nQFvHAz", "name": "River", "language": "en", "gender": "male"},
                            {"voice_id": "jBpfuIE2acCO8z3wKNLl", "name": "Gigi", "language": "en", "gender": "female"},
                            {"voice_id": "jsCqWAovK2LkecY7zXl4", "name": "Freya", "language": "en", "gender": "female"},
                            {"voice_id": "nPczCjzI2devNBz1zQrb", "name": "Brian", "language": "en", "gender": "male"},
                            {"voice_id": "onwK4e9ZLuTAKqWW03F9", "name": "Daniel", "language": "en", "gender": "male"},
                            {"voice_id": "piTKgcLEGmPE4e6mEKli", "name": "Nicole", "language": "en", "gender": "female"},
                            {"voice_id": "t0jbNlBVZ17f02VDIeMI", "name": "Sarah", "language": "en", "gender": "female"},
                            {"voice_id": "z9fAnlkpzviPz146aGWa", "name": "Bill", "language": "en", "gender": "male"}
                        ],
                        "es-CO": [
                            {"voice_id": "VBmCZpOLbAT9F8rUdK7k", "name": "Ana María - Calm & natural neutral Spanish", "language": "es-CO", "gender": "female"},
                            {"voice_id": "D4BIjjCRFRZhH8fGOzGP", "name": "Spanish Female Voice", "language": "es-CO", "gender": "female"},
                            {"voice_id": "E3A1KVHlyvOAmKwVNVIv", "name": "Esperanza - Warm & expressive Mexican Spanish", "language": "es", "gender": "female"},
                            {"voice_id": "L0YZdOCrJp8dJQtLF8pF", "name": "Diego - Deep & warm Mexican Spanish", "language": "es", "gender": "male"},
                            {"voice_id": "M8TxODKrfOLbHv3FQ2pL", "name": "Valentina - Soft & melodic Spanish", "language": "es", "gender": "female"}
                        ],
                        "de": [
                            {"voice_id": "D4BIjjCRFRZhH8fGOzGP", "name": "German Voice", "language": "de", "gender": "female"},
                            {"voice_id": "BmGJM2HQCL8H5KfGOzGP", "name": "German Female Voice 2", "language": "de", "gender": "female"},
                            {"voice_id": "F2YzKvMjPqRtN8bHc4dF", "name": "Greta - Clear & professional German", "language": "de", "gender": "female"},
                            {"voice_id": "H8kLmQrTvXzB3fYpN9wJ", "name": "Klaus - Authoritative German", "language": "de", "gender": "male"},
                            {"voice_id": "P5wRyBmKqLzF8cHtN2vX", "name": "Ingrid - Warm German narrator", "language": "de", "gender": "female"}
                        ],
                        "fr-CA": [
                            {"voice_id": "D4BIjjCRFRZhH8fGOzGP", "name": "Caroline - Top France - Narrative, warm, sweet", "language": "fr-CA", "gender": "female"},
                            {"voice_id": "BmGJM2HQCL8H5KfGOzGP", "name": "French Canadian Voice", "language": "fr-CA", "gender": "female"},
                            {"voice_id": "L9TxPqKvRzN8bHc4dFmY", "name": "Amélie - Elegant French", "language": "fr", "gender": "female"},
                            {"voice_id": "M3kRyBqLzF8cHtN2vXpW", "name": "Pierre - Distinguished French", "language": "fr", "gender": "male"},
                            {"voice_id": "N7wLmQvTzB3fYpN9wJkR", "name": "Camille - Soft French narrator", "language": "fr", "gender": "female"}
                        ],
                        "nl": [
                            {"voice_id": "OlBRrVAItyi00MuGMbna", "name": "Emma - Natural conversations in Dutch", "language": "nl", "gender": "female"},
                            {"voice_id": "BmGJM2HQCL8H5KfGOzGP", "name": "Dutch Female Voice", "language": "nl", "gender": "female"},
                            {"voice_id": "Q4rTyBmLzF8cHtN2vXpW", "name": "Sophie - Clear Dutch", "language": "nl", "gender": "female"},
                            {"voice_id": "R8kLmQvTzB3fYpN9wJkR", "name": "Pieter - Professional Dutch", "language": "nl", "gender": "male"},
                            {"voice_id": "S2wRyBqLzF8cHtN2vXpW", "name": "Lotte - Friendly Dutch narrator", "language": "nl", "gender": "female"}
                        ]
                    }
                };

                // Load voices from comprehensive data
                this.voices.playht = [];
                this.voices.elevenlabs = [];

                // Flatten PlayHT voices from all languages
                for (const [langCode, voices] of Object.entries(comprehensiveVoices.playht)) {
                    this.voices.playht.push(...voices.map(voice => ({
                        ...voice,
                        lang_code: langCode
                    })));
                }

                // Flatten ElevenLabs voices from all languages
                for (const [langCode, voices] of Object.entries(comprehensiveVoices.elevenlabs)) {
                    this.voices.elevenlabs.push(...voices.map(voice => ({
                        ...voice,
                        lang_code: langCode
                    })));
                }

                // Global deduplication of ElevenLabs voices by voice_id (fallback to name)
                const seenGlobal = new Set();
                this.voices.elevenlabs = this.voices.elevenlabs.filter(v => {
                    const key = v.voice_id || v.name;
                    if (!key) return false;
                    if (seenGlobal.has(key)) return false;
                    seenGlobal.add(key);
                    return true;
                });

                console.log(`Loaded ${this.voices.playht.length} PlayHT voices and ${this.voices.elevenlabs.length} ElevenLabs voices`);
                this.populateVoices();
                this.setStatus(`Loaded ${this.voices.playht.length + this.voices.elevenlabs.length} comprehensive voices`, 'success');
            }

            // ===== VALIDATION PERSISTENCE METHODS =====
            
            async loadValidationResults() {
                try {
                    console.log('🔄 Loading validation results...');
                    this.validation_results = {};

                    // Load localStorage first so shared merge can compare timestamps.
                    const storedResults = localStorage.getItem('validation_results');
                    if (storedResults) {
                        this.validation_results = JSON.parse(storedResults);
                        this.sanitizeValidationResultsStore();
                        this.normalizeValidationResultsLanguageKeys();
                        console.log(`✅ Loaded ${Object.keys(this.validation_results).length} validation results from localStorage`);
                    }

                    // Then merge shared storage (newer entry wins per item+language).
                    const sharedLoaded = await this.loadFromSharedStorage();
                    if (!sharedLoaded && !storedResults) {
                        console.log('📝 No shared/local validation data found, checking static JSON file...');
                        try {
                            const jsonResponse = await fetch('./validation_results.json');
                            if (jsonResponse.ok) {
                                const jsonData = await jsonResponse.json();
                                if (jsonData.validation_results) {
                                    this.validation_results = jsonData.validation_results;
                                    this.sanitizeValidationResultsStore();
                                    this.normalizeValidationResultsLanguageKeys();
                                    console.log(`✅ Loaded ${Object.keys(this.validation_results).length} validation results from JSON file`);
                                    console.log(`📅 File exported: ${jsonData.metadata?.exported_at || 'Unknown date'}`);
                                }
                            }
                        } catch (jsonError) {
                            console.log('📝 No validation_results.json file found, starting fresh');
                        }
                    }
                } catch (error) {
                    console.error('❌ Error loading validation results:', error);
                    this.validation_results = {};
                }
                this.updateValidationSaveBaseline();
                // First render runs in createTabs() before validation finishes loading; refresh so rows/summary match storage.
                this.noteValidationResultsChanged();
                this.populateDataTable();
            }

            /** Deterministic JSON for dirty-checking validation_results (sorted keys at every object level). */
            stableStringifyValidationResults(data) {
                const walk = (v) => {
                    if (v === null || v === undefined) return JSON.stringify(v);
                    const t = typeof v;
                    if (t !== 'object') return JSON.stringify(v);
                    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`;
                    const keys = Object.keys(v).sort();
                    return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(v[k])}`).join(',')}}`;
                };
                return walk(data && typeof data === 'object' ? data : {});
            }

            updateValidationSaveBaseline() {
                this.validationSaveBaseline = this.stableStringifyValidationResults(this.validation_results);
                try {
                    this.validationSnapshotAtBaseline = typeof structuredClone === 'function'
                        ? structuredClone(this.validation_results)
                        : JSON.parse(JSON.stringify(this.validation_results));
                } catch (_) {
                    this.validationSnapshotAtBaseline = {};
                }
            }

            restoreValidationResultsFromBaselineSnapshot() {
                if (!this.validationSnapshotAtBaseline) return;
                try {
                    this.validation_results = typeof structuredClone === 'function'
                        ? structuredClone(this.validationSnapshotAtBaseline)
                        : JSON.parse(JSON.stringify(this.validationSnapshotAtBaseline));
                } catch (_) {
                    return;
                }
                this.sanitizeValidationResultsStore();
                this.normalizeValidationResultsLanguageKeys();
            }

            ensureUnsavedValidationModalMounted() {
                let modal = document.getElementById('unsavedValidationModal');
                if (modal) return modal;
                const wrap = document.createElement('div');
                wrap.innerHTML = `
<div id="unsavedValidationModal" class="modal" style="display: none;">
    <div class="modal-content" style="max-width: 480px;">
        <div class="modal-header">
            <h2><i class="fas fa-exclamation-triangle" style="color:#f57c00;"></i> Unsaved validation changes</h2>
            <span class="close" id="unsavedValidationModalClose" title="Stay on this tab">&times;</span>
        </div>
        <div class="modal-body">
            <p style="margin: 0 0 12px 0; color: #37474f; line-height: 1.45;">
                You have unsaved validation changes (scores, approvals, needs review, notes, etc.).
                Save them to shared storage, discard them and revert to your last saved state, or stay on this tab.
            </p>
        </div>
        <div class="modal-body" style="padding-top: 0; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end;">
            <button type="button" class="btn btn-secondary" id="unsavedValidationStayBtn">Stay on this tab</button>
            <button type="button" class="btn btn-warning" id="unsavedValidationDiscardBtn" title="Revert to last saved validation state">Discard changes</button>
            <button type="button" class="btn btn-primary" id="unsavedValidationSaveBtn"><i class="fas fa-save"></i> Save</button>
        </div>
    </div>
</div>`;
                document.body.appendChild(wrap.firstElementChild);
                return document.getElementById('unsavedValidationModal');
            }

            ensureUnsavedValidationModalListeners() {
                const modal = this.ensureUnsavedValidationModalMounted();
                if (!modal || modal.dataset.unsavedListenersBound === '1') return;
                modal.dataset.unsavedListenersBound = '1';

                const getButtons = () => ({
                    save: document.getElementById('unsavedValidationSaveBtn'),
                    discard: document.getElementById('unsavedValidationDiscardBtn'),
                    stay: document.getElementById('unsavedValidationStayBtn'),
                    close: document.getElementById('unsavedValidationModalClose')
                });

                const finish = (result) => {
                    if (!this._unsavedValidationResolve) return;
                    modal.style.display = 'none';
                    const r = this._unsavedValidationResolve;
                    this._unsavedValidationResolve = null;
                    r(result);
                };

                const { save, discard, stay, close } = getButtons();
                if (stay) stay.addEventListener('click', () => finish('stay'));
                if (discard) discard.addEventListener('click', () => finish('discard'));
                if (close) close.addEventListener('click', () => finish('stay'));
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) finish('stay');
                });

                if (save) {
                    save.addEventListener('click', async () => {
                        const btns = getButtons();
                        const all = [btns.save, btns.discard, btns.stay].filter(Boolean);
                        all.forEach((b) => { b.disabled = true; });
                        const prev = btns.save.innerHTML;
                        btns.save.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
                        try {
                            const res = await this.saveValidationResults();
                            if (res && res.success) {
                                finish('save');
                                return;
                            }
                            this.setStatus('Could not save validation results. Fix any issues and try again, or choose Stay or Discard.', 'error');
                        } catch (err) {
                            this.setStatus(`Save failed: ${err?.message || err}`, 'error');
                        } finally {
                            if (btns.save && modal.style.display !== 'none') {
                                btns.save.innerHTML = prev;
                                all.forEach((b) => { b.disabled = false; });
                            }
                        }
                    });
                }

                document.addEventListener('keydown', (e) => {
                    if (e.key !== 'Escape') return;
                    const m = document.getElementById('unsavedValidationModal');
                    if (m && m.style.display !== 'none') finish('stay');
                });
            }

            promptUnsavedValidationAction() {
                this.ensureUnsavedValidationModalMounted();
                this.ensureUnsavedValidationModalListeners();
                const modal = document.getElementById('unsavedValidationModal');
                return new Promise((resolve) => {
                    this._unsavedValidationResolve = resolve;
                    if (modal) modal.style.display = 'block';
                    else resolve('stay');
                });
            }

            hasUnsavedValidationChanges() {
                if (this.validationSaveBaseline == null) return false;
                return this.stableStringifyValidationResults(this.validation_results) !== this.validationSaveBaseline;
            }

            setupUnsavedValidationWarning() {
                if (typeof window === 'undefined' || this._unsavedValidationBeforeUnloadBound) return;
                this._unsavedValidationBeforeUnloadBound = true;
                window.addEventListener('beforeunload', (e) => {
                    try {
                        if (this.hasUnsavedValidationChanges()) {
                            e.preventDefault();
                            e.returnValue = '';
                        }
                    } catch (_) { /* ignore */ }
                });
            }
            
            async saveValidationResults(options = {}) {
                const updateBaseline = options && options.updateBaseline !== false;
                const silent = options && options.silent === true;
                try {
                    console.log('💾 Saving validation results to localStorage and shared storage...');
                    this.sanitizeValidationResultsStore();
                    this.normalizeValidationResultsLanguageKeys();
                    
                    // Count total validation entries
                    let totalValidations = 0;
                    Object.keys(this.validation_results).forEach(itemId => {
                        if (this.isExcludedValidationItemId(itemId)) return;
                        totalValidations += Object.keys(this.validation_results[itemId]).length;
                    });
                    
                    // Save to localStorage first. If full, fallback to a compact snapshot.
                    let localStorageMode = 'full';
                    try {
                        localStorage.setItem('validation_results', JSON.stringify(this.validation_results));
                    } catch (localError) {
                        if (localError && (localError.name === 'QuotaExceededError' || String(localError.message || '').includes('quota'))) {
                            console.warn('⚠️ localStorage quota exceeded, trying compact validation snapshot');
                            const compact = this.buildCompactValidationResultsSnapshot();
                            try { localStorage.removeItem('validation_results'); } catch (_) {}
                            try {
                                localStorage.setItem('validation_results', JSON.stringify(compact));
                                localStorageMode = 'compact';
                            } catch (compactError) {
                                console.warn('⚠️ Compact local snapshot also failed:', compactError.message);
                                localStorageMode = 'none';
                            }
                        } else {
                            throw localError;
                        }
                    }
                    
                    // Save to shared storage (bucket) regardless of local storage mode.
                    const sharedSaved = await this.saveToSharedStorage({ silent });
                    
                    console.log(`✅ Saved ${Object.keys(this.validation_results).length} items with ${totalValidations} total validations`);
                    
                    const success = sharedSaved || localStorageMode !== 'none';
                    if (success && updateBaseline) this.updateValidationSaveBaseline();
                    return {
                        success,
                        itemCount: Object.keys(this.validation_results).length,
                        validationCount: totalValidations,
                        localStorageMode,
                        sharedSaved
                    };
                } catch (error) {
                    console.error('❌ Error saving validation results:', error);
                    return {
                        success: false,
                        error: error.message
                    };
                }
            }

            async saveToSharedStorage(options = {}) {
                const silent = options && options.silent === true;
                try {
                    console.log('🌐 Saving validation results to shared storage...');
                    
                    const exportData = {
                        validation_results: this.validation_results,
                        metadata: {
                            saved_by: 'Levante Pitwall Dashboard',
                            version: '1.0',
                            total_items: Object.keys(this.validation_results).length,
                            languages: Object.keys(this.languages),
                            saved_at: new Date().toISOString()
                        }
                    };

                    const response = await fetch('/api/validation-storage', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(exportData)
                    });

                    if (response.ok) {
                        const result = await response.json();
                        console.log('✅ Successfully saved to shared storage:', result.metadata);
                        if (!silent) this.setStatus('💾 Validation results saved to shared session storage for team access', 'success');
                        return true;
                    } else {
                        console.warn('⚠️ Failed to save to shared storage, but localStorage backup is available');
                        return false;
                    }
                } catch (error) {
                    console.warn('⚠️ Could not save to shared storage:', error.message);
                    // Don't throw error - localStorage save is the primary backup
                    return false;
                }
            }

            buildCompactValidationResultsSnapshot() {
                const source = this.validation_results || {};
                const compact = {};
                Object.keys(source).forEach(itemId => {
                    if (this.isExcludedValidationItemId(itemId)) return;
                    const byLang = source[itemId] || {};
                    const compactByLang = {};
                    Object.keys(byLang).forEach(langCode => {
                        const r = byLang[langCode] || {};
                        const entry = {};
                        if (typeof r.score === 'number') entry.score = r.score;
                        if (r.timestamp) entry.timestamp = r.timestamp;
                        if (r.updated) entry.updated = r.updated;
                        if (r.scoreSource) entry.scoreSource = r.scoreSource;
                        if (r.manualApproved === true) entry.manualApproved = true;
                        if (typeof r.manualApprovalUpdatedAt === 'string' && r.manualApprovalUpdatedAt) entry.manualApprovalUpdatedAt = r.manualApprovalUpdatedAt;
                        if (r.needsReview === true) entry.needsReview = true;
                        if (typeof r.reason === 'string' && r.reason) entry.reason = r.reason.slice(0, 400);
                        if (typeof r.reviewUpdatedAt === 'string' && r.reviewUpdatedAt) entry.reviewUpdatedAt = r.reviewUpdatedAt;
                        if (r.requiresRevalidation === true) entry.requiresRevalidation = true;
                        if (typeof r.changeKind === 'string' && r.changeKind) entry.changeKind = r.changeKind;
                        if (typeof r.changeDetectedAt === 'string' && r.changeDetectedAt) entry.changeDetectedAt = r.changeDetectedAt;
                        if (typeof r.lastSeenSourceHash === 'string' && r.lastSeenSourceHash) entry.lastSeenSourceHash = r.lastSeenSourceHash;
                        if (typeof r.lastSeenTranslationHash === 'string' && r.lastSeenTranslationHash) entry.lastSeenTranslationHash = r.lastSeenTranslationHash;
                        if (typeof r.notes === 'string' && r.notes) entry.notes = r.notes.slice(0, 160);
                        if (typeof r.backTranslation === 'string' && r.backTranslation) entry.backTranslation = r.backTranslation.slice(0, 1000);
                        if (typeof r.aiUsed === 'boolean') entry.aiUsed = r.aiUsed;
                        if (Number.isFinite(Number(r.aiScore))) entry.aiScore = Number(r.aiScore);
                        if (Number.isFinite(Number(r.baselineScore))) entry.baselineScore = Number(r.baselineScore);
                        if (typeof r.manualOverridePreviousScore === 'number') entry.manualOverridePreviousScore = r.manualOverridePreviousScore;
                        if (r.manualOverridePreviousSource) entry.manualOverridePreviousSource = r.manualOverridePreviousSource;
                        compactByLang[langCode] = entry;
                    });
                    if (Object.keys(compactByLang).length > 0) compact[itemId] = compactByLang;
                });
                return compact;
            }

            getValidationLanguageLoadKey(langCode) {
                return String(langCode || '')
                    .trim()
                    .toLowerCase()
                    .replace(/_/g, '-');
            }

            async loadFromSharedStorage(languageOverride = '', options = {}) {
                try {
                    console.log('🌐 Loading validation results from shared storage...');

                    const configuredRemoteSharedEndpoint = String(window.CONFIG?.sharedValidationEndpoint || '').trim();
                    const currentLangCode = String(
                        languageOverride
                        || this.languages?.[this.currentLanguage]?.lang_code
                        || ''
                    ).trim();
                    const forceReload = options && options.force === true;
                    const requestedLangKey = this.getValidationLanguageLoadKey(currentLangCode);
                    if (!forceReload && requestedLangKey && this.loadedValidationLanguageCodes.has(requestedLangKey)) {
                        return false;
                    }
                    const appendLanguageParam = (endpoint, langCode) => {
                        const lang = String(langCode || '').trim();
                        if (!lang) return endpoint;
                        try {
                            const url = new URL(endpoint, window.location.origin);
                            url.searchParams.set('language', lang);
                            if (endpoint.startsWith('/')) {
                                return `${url.pathname}${url.search}`;
                            }
                            return url.toString();
                        } catch (_) {
                            const joiner = endpoint.includes('?') ? '&' : '?';
                            return `${endpoint}${joiner}language=${encodeURIComponent(lang)}`;
                        }
                    };
                    const endpointCandidates = ['/api/validation-storage'];
                    // Cross-origin fallback is opt-in only.
                    if (configuredRemoteSharedEndpoint && !endpointCandidates.includes(configuredRemoteSharedEndpoint)) {
                        endpointCandidates.push(configuredRemoteSharedEndpoint);
                    }

                    const payloadCandidates = [];
                    for (const endpoint of endpointCandidates) {
                        const attempts = [];
                        const scopedEndpoint = appendLanguageParam(endpoint, currentLangCode);
                        if (scopedEndpoint) attempts.push({ url: scopedEndpoint, scoped: true });
                        attempts.push({ url: endpoint, scoped: false });
                        const seenAttemptUrls = new Set();
                        for (const attempt of attempts) {
                            if (!attempt?.url || seenAttemptUrls.has(attempt.url)) continue;
                            seenAttemptUrls.add(attempt.url);
                        try {
                            const response = await fetch(attempt.url, { cache: 'no-store' });
                            if (!response.ok) continue;
                            const result = await response.json();
                            if (!result?.success) continue;
                            const data = result?.data || {};
                            const sharedResultsRaw =
                                data?.validation_results
                                || result?.validation_results
                                || {};
                            if (!sharedResultsRaw || typeof sharedResultsRaw !== 'object') continue;
                            payloadCandidates.push({
                                endpoint: attempt.url,
                                sameOrigin: attempt.url.startsWith('/'),
                                scoped: !!attempt.scoped,
                                source: String(result?.source || 'unknown'),
                                sharedResults: sharedResultsRaw,
                                itemCount: Object.keys(sharedResultsRaw).length
                            });
                            // Prefer successful scoped response for this endpoint, skip full fetch.
                            if (attempt.scoped) break;
                        } catch (endpointError) {
                            console.log(`Shared validation load skipped for ${attempt.url}:`, endpointError?.message || endpointError);
                        }
                        }
                    }

                    if (payloadCandidates.length > 0) {
                        payloadCandidates.sort((a, b) => {
                            const sameOriginDelta = Number(!!b.sameOrigin) - Number(!!a.sameOrigin);
                            if (sameOriginDelta !== 0) return sameOriginDelta;
                            const scopeDelta = Number(!!b.scoped) - Number(!!a.scoped);
                            if (scopeDelta !== 0) return scopeDelta;
                            const aIsMemory = a.source === 'memory' ? 1 : 0;
                            const bIsMemory = b.source === 'memory' ? 1 : 0;
                            if (aIsMemory !== bIsMemory) return aIsMemory - bIsMemory;
                            if (b.itemCount !== a.itemCount) return b.itemCount - a.itemCount;
                            return 0;
                        });
                        const bestPayload = payloadCandidates[0];
                        this.sharedValidationSource = String(bestPayload.source || 'unknown');
                        const sharedResults = bestPayload.sharedResults;
                        const localResults = this.validation_results;

                        // Shared storage is authoritative for any returned item+language.
                        // Keep local-only entries as fallback, but do not let stale local cache
                        // override shared review/approval flags.
                        Object.keys(sharedResults).forEach(itemId => {
                            if (this.isExcludedValidationItemId(itemId)) return;
                            if (!localResults[itemId]) {
                                localResults[itemId] = sharedResults[itemId];
                            } else {
                                // Merge language validations with shared precedence.
                                Object.keys(sharedResults[itemId]).forEach(lang => {
                                    const sharedValidation = sharedResults[itemId][lang];
                                    const localValidation = localResults[itemId][lang];
                                    localResults[itemId][lang] = {
                                        ...(localValidation && typeof localValidation === 'object' ? localValidation : {}),
                                        ...(sharedValidation && typeof sharedValidation === 'object' ? sharedValidation : {})
                                    };
                                });
                            }
                        });

                        this.validation_results = localResults;
                        this.sanitizeValidationResultsStore();
                        this.normalizeValidationResultsLanguageKeys();
                        try {
                            localStorage.setItem('validation_results', JSON.stringify(this.validation_results));
                        } catch (_) {
                            // Best effort only; shared state remains source of truth.
                        }
                        if (requestedLangKey) this.loadedValidationLanguageCodes.add(requestedLangKey);
                        console.log(`✅ Loaded shared validation results: ${Object.keys(sharedResults).length} items from ${bestPayload.endpoint} (${bestPayload.source})`);
                        const sourceLabel = this.sharedValidationSource === 'gcs'
                            ? 'shared bucket (GCS)'
                            : this.sharedValidationSource === 'memory'
                                ? 'session memory fallback'
                                : this.sharedValidationSource;
                        this.setStatus(`🌐 Loaded validation results from ${sourceLabel}`, this.sharedValidationSource === 'memory' ? 'warning' : 'success');
                        this.updateValidationSaveBaseline();
                        return true;
                    }
                } catch (error) {
                    this.sharedValidationSource = 'unknown';
                    console.log('⚠️ Could not load from shared storage:', error.message);
                }
                return false;
            }
            
            setupAutoSave() {
                // Auto-save disabled per user request
                // Users can manually save using the "Save Validations" button
                
                console.log('🔧 Auto-save disabled - use manual save button');
            }
            
            applyStoredValidationResults() {
                // Deprecated: Use applyStoredValidationResultsForCurrentLanguage() instead
                console.log('⚠️ applyStoredValidationResults is deprecated, use applyStoredValidationResultsForCurrentLanguage');
                this.applyStoredValidationResultsForCurrentLanguage();
            }
            
            applyStoredValidationResultsForCurrentLanguage() {
                // Validation results are now pre-computed in populateDataTable() HTML
                // This function is kept for backward compatibility but does nothing
                // to avoid duplicate DOM modifications that cause layout issues
                const currentLangCode = this.languages[this.currentLanguage]?.lang_code || 'unknown';
                console.log(`🎯 Applying stored validation results for ${this.currentLanguage} (${currentLangCode})... [SKIPPED - pre-computed in HTML]`);
                if (typeof updateValidationSummary === 'function') {
                    updateValidationSummary();
                }
            }
            
            storeValidationResult(itemId, langCode, score, notes = '') {
                // Initialize item if it doesn't exist
                if (!this.validation_results[itemId]) {
                    this.validation_results[itemId] = {};
                }
                const preferredLangCode = this.resolvePreferredLangCode(langCode);
                const existing = this.getValidationEntry(itemId, preferredLangCode);
                // Store the result; preserve reviewer metadata from existing entry.
                this.validation_results[itemId][preferredLangCode] = {
                    score: score,
                    notes: notes,
                    timestamp: new Date().toISOString(),
                    manualApproved: existing && existing.manualApproved === true ? true : false,
                    manualApprovalUpdatedAt: existing && existing.manualApprovalUpdatedAt ? existing.manualApprovalUpdatedAt : '',
                    needsReview: existing && existing.needsReview !== undefined ? existing.needsReview : false,
                    reason: existing && existing.reason !== undefined ? existing.reason : '',
                    backTranslation: existing && existing.backTranslation !== undefined ? existing.backTranslation : '',
                    reviewUpdatedAt: existing && existing.reviewUpdatedAt !== undefined ? existing.reviewUpdatedAt : ''
                };
                console.log(`📝 Stored validation result: ${itemId}[${preferredLangCode}] = ${score}%`);
            }
            
            updateValidationUI(itemId, langCode, score, notes) {
                // Map langCode to language name to target the correct tab
                const langCodeToLanguage = {
                    'en': 'English',
                    'en-US': 'English',
                    'es-CO': 'Spanish', 
                    'de': 'German',
                    'de-DE': 'German',
                    'de-CH': 'German (Switzerland)',
                    'fr-CA': 'French (Canada)',
                    'nl': 'Dutch'
                };
                
                const languageName = langCodeToLanguage[langCode];
                if (!languageName) {
                    console.warn(`Unknown langCode: ${langCode}`);
                    return;
                }
                
                // Look for indicator within the specific language tab
                const languageTab = document.getElementById(`table-${languageName}`);
                if (!languageTab) {
                    console.warn(`Language tab not found: table-${languageName}`);
                    return;
                }
                
                const indicator = languageTab.querySelector(`[data-item-id="${itemId}"]`);
                if (!indicator) {
                    console.warn(`Indicator not found for ${itemId} in ${languageName} tab`);
                    return;
                }
                
                // Convert stored decimal score to percentage for display
                const scorePercent = Math.round((score * 100) * 100) / 100; // 2 decimal places
                
                // Determine status based on score percentage
                let statusClass, statusTitle, buttonText, scoreEmoji;
                if (scorePercent >= 85) {
                    statusClass = 'status-good';
                    statusTitle = `✅ Excellent: ${scorePercent.toFixed(2)}% similarity`;
                    buttonText = 'View Results';
                    scoreEmoji = '✅';
                } else if (scorePercent >= 70) {
                    statusClass = 'status-warning';
                    statusTitle = `⚠️ Warning: ${scorePercent.toFixed(2)}% similarity`;
                    buttonText = 'View Warning';
                    scoreEmoji = '⚠️';
                } else {
                    statusClass = 'status-error';
                    statusTitle = `❌ Poor: ${scorePercent.toFixed(2)}% similarity`;
                    buttonText = 'View Issues';
                    scoreEmoji = '❌';
                }
                
                // Update indicator
                indicator.className = `status-indicator ${statusClass}`;
                indicator.title = statusTitle;
                
                // Update or create score badge (reuse existing to avoid layout thrash)
                let scoreBadge = indicator.parentElement.querySelector('.score-badge');
                if (!scoreBadge) {
                    scoreBadge = document.createElement('span');
                    scoreBadge.className = 'score-badge';
                    scoreBadge.style.cssText = 'font-size: 10px; font-weight: bold; margin-left: 4px; opacity: 0.9;';
                    indicator.parentElement.appendChild(scoreBadge);
                }
                scoreBadge.textContent = `${scorePercent.toFixed(2)}%`;
                scoreBadge.style.color = scorePercent >= 85 ? '#155724' : scorePercent >= 70 ? '#856404' : '#721c24';
                
                // Update button if it exists
                const button = indicator.parentElement.querySelector('.validate-btn');
                if (button) {
                    button.textContent = `${scoreEmoji} ${buttonText}`;
                    button.disabled = false;
                }
            }

            createTabs() {
                // Ensure latest language map
                this.refreshLanguagesFromConfig();
                const tabButtons = document.getElementById('tabButtons');
                const tabContent = document.getElementById('tabContent');
                
                // Clear existing tabs to prevent duplicates
                tabButtons.innerHTML = '';
                tabContent.innerHTML = '';
                
                const languageNames = Object.keys(this.languages || {})
                    .sort((a, b) => String(this.getDisplayName(a) || a).localeCompare(String(this.getDisplayName(b) || b)));
                if (languageNames.length === 0) {
                    this.setStatus('No valid languages configured. Please check language settings.', 'error');
                    return;
                }

                if (!this.languages[this.currentLanguage]) {
                    this.currentLanguage = languageNames[0];
                }

                languageNames.forEach((language, index) => {
                    const displayLanguage = this.getDisplayName(language);
                    // Create tab button
                    const button = document.createElement('button');
                    const isActive = language === this.currentLanguage || (index === 0 && !this.languages[this.currentLanguage]);
                    button.className = `tab-button ${isActive ? 'active' : ''}`;
                    button.textContent = displayLanguage;
                    button.addEventListener('click', () => { void this.switchTab(language, button); });
                    tabButtons.appendChild(button);

                    // Create tab content
                    const content = document.createElement('div');
                    content.className = `tab-content ${isActive ? 'active' : ''}`;
                    content.id = `tab-${language}`;
                    
                    const langConfig = this.languages[language] || {};
                    content.innerHTML = `
                        <h3>${this.getFlagForLanguage(displayLanguage)}${displayLanguage} Configuration</h3>
                        <div class="language-info">
                            <div class="info-card">
                                <strong>Language Code</strong>
                                <span>${langConfig.lang_code || '—'}</span>
                            </div>
                            <div class="info-card">
                                <strong>Default Service</strong>
                                <span>${langConfig.service || '—'}</span>
                            </div>
                            <div class="info-card">
                                <strong>Default Voice</strong>
                                <span>${langConfig.voice || '—'}</span>
                            </div>
                        </div>
                        <div class="data-table">
                            <div class="table-header">
                                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                                    <h4 style="margin: 0;"><i class="fas fa-table"></i> Translation Items <span id="item-count-${language}" class="item-count">(Loading...)</span> <span id="table-loading-${language}" style="display:none; margin-left: 10px; font-size: 0.85em; color: #6c757d;"></span></h4>
                                    <div class="sort-controls" style="display: flex; gap: 6px; align-items: center;">
                                        <span style="font-size: 0.85em; color: #6c757d;">Sort:</span>
                                        <button class="btn btn-compact sort-btn" data-lang="${language}" data-sort="score-desc" title="Sort by score (highest first)" style="padding: 4px 8px; font-size: 0.8em;">
                                            <i class="fas fa-sort-amount-down"></i> Score ↓
                                        </button>
                                        <button class="btn btn-compact sort-btn" data-lang="${language}" data-sort="score-asc" title="Sort by score (lowest first)" style="padding: 4px 8px; font-size: 0.8em;">
                                            <i class="fas fa-sort-amount-up"></i> Score ↑
                                        </button>
                                        <button class="btn btn-compact sort-btn" data-lang="${language}" data-sort="id" title="Sort by Item ID" style="padding: 4px 8px; font-size: 0.8em;">
                                            <i class="fas fa-sort-alpha-down"></i> ID
                                        </button>
                                        <button class="btn btn-compact sort-btn" data-lang="${language}" data-sort="review" title="Show items needing review first" style="padding: 4px 8px; font-size: 0.8em;">
                                            <i class="fas fa-flag"></i> Review
                                        </button>
                                        <button class="btn btn-compact approval-filter-btn" data-lang="${language}" data-filter="approved" onclick="window.dashboard && window.dashboard.applyApprovalFilterForLanguage('${language.replace(/'/g, "\\'")}', 'approved')" title="Show only approved rows in this table" style="padding: 4px 8px; font-size: 0.8em; border: 1px solid #b0bec5; background: #f8f9fa; color: #546e7a;">
                                            Approved
                                        </button>
                                        <button class="btn btn-compact approval-filter-btn" data-lang="${language}" data-filter="not-approved" onclick="window.dashboard && window.dashboard.applyApprovalFilterForLanguage('${language.replace(/'/g, "\\'")}', 'not-approved')" title="Show only not-approved rows in this table" style="padding: 4px 8px; font-size: 0.8em; border: 1px solid #b0bec5; background: #f8f9fa; color: #546e7a;">
                                            Not Approved
                                        </button>
                                        <select id="file-filter-${language}" class="voice-select btn-compact file-filter-select" data-language="${language}" style="height: 30px; padding: 0 8px; min-width: 150px; max-width: 220px;" title="Filter grid to one source file">
                                            <option value="all">All Files</option>
                                        </select>
                                    </div>
                                </div>
                                <input type="text" class="search-box" placeholder="Search items..." id="search-${language}">
                            </div>
                            <div class="table-content" id="table-${language}">
                                <!-- Data will be populated here -->
                            </div>
                        </div>
                    `;
                    tabContent.appendChild(content);
                });
                
                // Setup search listeners for the newly created search boxes
                setTimeout(() => this.setupSearchListeners(), 100);
                setTimeout(() => this.setupFileFilterListeners(), 110);
                
                // Populate initial data
                this.populateDataTable();
            }

            populateDataTable() {
                const renderStart = this.perfNow();
                this.refreshLanguagesFromConfig();
                let renderLanguage = this.currentLanguage;
                let langConfig = this.languages?.[renderLanguage];
                if (!langConfig) {
                    const fallbackLanguage = Object.keys(this.languages || {})[0];
                    if (!fallbackLanguage) {
                        this.setStatus('No valid languages configured. Please check language settings.', 'error');
                        return;
                    }
                    this.currentLanguage = fallbackLanguage;
                    renderLanguage = fallbackLanguage;
                    langConfig = this.languages?.[renderLanguage];
                }

                const langCode = String(langConfig?.lang_code || '').trim();
                if (!langCode) {
                    this.setStatus(`Language "${renderLanguage}" is missing a language code.`, 'warning');
                    return;
                }

                const tableContent = document.getElementById(`table-${renderLanguage}`);
                if (!tableContent) return;
                const currentSignature = this.getCurrentRenderSignature(renderLanguage);
                const previousSignature = this.renderSignatureByLanguage.get(renderLanguage);
                if (previousSignature === currentSignature && tableContent.children.length > 0) {
                    if (typeof setValidationSummaryLoading === 'function') setValidationSummaryLoading(false);
                    if (typeof updateValidationSummary === 'function') updateValidationSummary();
                    this.setTableLoadingState(renderLanguage, false);
                    this.setApprovalFilterBusy(renderLanguage, false);
                    this.updateApprovalFilterButtonsForLanguage(renderLanguage);
                    this.logPerf(`Render table skipped (${renderLanguage})`, renderStart, `rows=${tableContent.children.length}`);
                    return;
                }
                const inFlightSignature = this.inFlightRenderSignatureByLanguage.get(renderLanguage);
                if (inFlightSignature === currentSignature) {
                    this.setTableLoadingState(renderLanguage, false);
                    this.setApprovalFilterBusy(renderLanguage, false);
                    this.updateApprovalFilterButtonsForLanguage(renderLanguage);
                    this.logPerf(`Render table skipped (${renderLanguage})`, renderStart, 'already in-flight');
                    return;
                }
                if (typeof setValidationSummaryLoading === 'function') setValidationSummaryLoading(true);
                const renderJobId = ++this.activeRenderJobId;
                this.inFlightRenderSignatureByLanguage.set(renderLanguage, currentSignature);

                tableContent.innerHTML = '';
                const baseRows = this.getFilteredItemsForLanguage(renderLanguage);
                this.refreshFileFilterOptions(renderLanguage, baseRows);
                const selectedFile = this.fileFilterByLanguage.get(renderLanguage) || 'all';
                const baseRowsForFile = selectedFile === 'all'
                    ? baseRows
                    : baseRows.filter((item) => this.getItemSourcePaths(item).includes(selectedFile));
                const entryCache = this.buildValidationEntryCacheForRows(baseRowsForFile, langCode);
                const dataToShow = this.applyApprovalFilterToRowsWithCache(baseRowsForFile, langCode, renderLanguage, entryCache);
                this.updateApprovalFilterButtonsForLanguage(renderLanguage);
                this.setTableLoadingState(renderLanguage, true, 0, dataToShow.length);

                if (renderLanguage === this.currentLanguage) {
                    const quickCounts = this.computeValidationSummaryCountsForRows(dataToShow, langCode, entryCache);
                    if (typeof window.setValidationSummaryCounts === 'function') {
                        window.setValidationSummaryCounts(quickCounts);
                    }
                }
                
                const itemCountSpan = document.getElementById(`item-count-${renderLanguage}`);
                if (itemCountSpan) {
                    itemCountSpan.textContent = `(${dataToShow.length} items)`;
                    itemCountSpan.style.color = '#6c757d';
                    itemCountSpan.style.fontSize = '0.9em';
                }
                
                // Progressive rendering: fast initial paint, append more as needed.
                const BATCH_SIZE = 60;
                const self = this;
                const state = {
                    renderLanguage,
                    langCode,
                    tableContent,
                    rows: dataToShow,
                    entryCache,
                    offset: 0,
                    signature: currentSignature,
                    renderStart,
                    completed: false
                };
                this.lazyRenderStateByLanguage.set(renderLanguage, state);

                function processBatch() {
                    if (renderJobId !== self.activeRenderJobId) {
                        if (self.inFlightRenderSignatureByLanguage.get(renderLanguage) === currentSignature) {
                            self.inFlightRenderSignatureByLanguage.delete(renderLanguage);
                        }
                        self.setTableLoadingState(renderLanguage, false);
                        self.logPerf(`Render table cancelled (${renderLanguage})`, renderStart);
                        return;
                    }
                    const hasMore = self.appendRenderBatch(state, BATCH_SIZE);
                    if (hasMore) {
                        requestAnimationFrame(processBatch);
                    } else {
                        self.finalizeRenderState(state);
                    }
                }
                processBatch();
            }
            
            buildDataRow(item, index, langCode, entryCache = null) {
                    let text = this.getTranslationTextForLanguage(item, langCode);
                    const hasTranslatedText = !!String(text || '').trim();
                    if (!text) text = 'Missing translation';
                    const isSourceEnglishTab = String(langCode).split('-')[0].toLowerCase() === 'en';
                    const canValidateTranslation = isSourceEnglishTab || hasTranslatedText;
                
                    const row = document.createElement('div');
                    row.className = 'data-row';
                    const itemId = item.item_id || `fallback_${index}`;
                    const displayMeta = item.__displayMeta || {};
                    const displayItemId = displayMeta.displayItemId || (String(itemId).includes('::') ? String(itemId).split('::').pop() : String(itemId));
                    const taskName = displayMeta.taskName || item.labels || item.task || 'general';
                    const contentType = displayMeta.contentType || item.contentType || 'general';
                    const originalEnglish = item.en || 'No English source';
                    row.dataset.itemId = itemId;
                    row.dataset.langCode = langCode;
                    const escapedItemId = itemId.replace(/'/g, "\\'");
                    const escapedOriginal = originalEnglish.replace(/'/g, "\\'").replace(/"/g, '\\"');
                    const escapedTranslation = text.replace(/'/g, "\\'").replace(/"/g, '\\"');
                    
                    let statusClass = 'status-pending';
                    let statusTitle = 'Not validated yet';
                    let buttonText = 'Validate';
                    let scoreBadgeHtml = '';
                    let sourceBadgeHtml = '';
                    let embeddingRowHtml = '';
                    let approvedHtml = '';
                    let scoreValue = -1;
                    const storedResult = this.getCachedValidationEntry(entryCache, item, langCode);
                    const requiresRevalidation = storedResult?.requiresRevalidation === true;
                    const changeKind = String(storedResult?.changeKind || '').trim().toLowerCase();
                    const needsReview = storedResult?.needsReview === true;
                    const translationUpdated = requiresRevalidation
                        && (changeKind === 'translation' || changeKind === 'source+translation');
                    const reviewReason = storedResult?.reason || '';
                    const backTranslation = storedResult?.backTranslation || '';
                    const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                    const hasBackTranslation = !!String(backTranslation).trim();
                    const backTranslationDisplayText = hasBackTranslation
                        ? String(backTranslation).trim()
                        : 'Back-translation unavailable (click View Results to generate)';
                    const hasAnyStoredScore = !!(storedResult && storedResult.score !== undefined) && !requiresRevalidation;
                    let backTranslationHtml = '';
                    if (hasAnyStoredScore) {
                        backTranslationHtml = `<div class="item-backtranslation ${hasBackTranslation ? '' : 'item-backtranslation-missing'}" title="Back-translation">${escapeHtml(backTranslationDisplayText)}</div>`;
                    } else if (requiresRevalidation && canValidateTranslation) {
                        backTranslationHtml = `<div class="item-backtranslation item-backtranslation-missing" title="Back-translation">Validation is stale after translation update — click Revalidate to regenerate back-translation.</div>`;
                    } else if (canValidateTranslation) {
                        backTranslationHtml = `<div class="item-backtranslation item-backtranslation-missing" title="Back-translation">Not generated yet — click Validate to run scoring and back-translation.</div>`;
                    }
                    const displayItemIdText = String(displayItemId || '');
                    const compactItemId = displayMeta.compactItemId || (displayItemIdText.length > 36 ? `${displayItemIdText.slice(0, 33)}...` : displayItemIdText);
                    const escapedTaskName = escapeHtml(String(taskName));
                    const escapedTypeName = escapeHtml(String(contentType));
                    const escapedOriginalText = escapeHtml(String(originalEnglish || ''));
                    const escapedDisplayText = escapeHtml(String(text || ''));
                    const hasAudioFile = String(contentType || '').trim().toLowerCase() === 'itembank';
                    const infoButtonHtml = hasAudioFile
                        ? `<button class="info-btn" onclick="showAudioInfo('${escapedItemId}', '${langCode}')" title="Show audio metadata">Info</button>`
                        : '<button class="info-btn" title="No audio file is expected for this row" disabled style="opacity:0.55; cursor:not-allowed;">No Audio</button>';
                    const hasStoredScore = !!(storedResult && storedResult.score !== undefined) && canValidateTranslation && !requiresRevalidation;
                    const validateOnClick = hasStoredScore
                        ? `(window.showStoredValidationResult && window.showStoredValidationResult('${escapedItemId}', '${langCode}'))`
                        : (canValidateTranslation
                            ? `if (window.validateByItemId) { window.validateByItemId('${escapedItemId}', '${langCode}'); } else { validateSingle('${escapedItemId}', '${escapedOriginal}', '${escapedTranslation}', '${langCode}'); }`
                            : `return false;`);
                    const indicatorOnClick = hasStoredScore
                        ? `onclick="window.showStoredValidationResult && window.showStoredValidationResult('${escapedItemId}', '${langCode}')" style="cursor: pointer;"`
                        : '';
                    if (storedResult && storedResult.score !== undefined && canValidateTranslation && !requiresRevalidation) {
                        const scorePercent = Math.round((storedResult.score * 100) * 100) / 100;
                        const scorePercentRounded = Math.round(scorePercent);
                        scoreValue = scorePercent;
                        if (scorePercent >= 85) {
                            statusClass = 'status-good';
                            statusTitle = `✅ Excellent: ${scorePercent.toFixed(2)}% similarity`;
                            buttonText = '✅ View Results';
                        } else if (scorePercent >= 70) {
                            statusClass = 'status-warning';
                            statusTitle = `⚠️ Warning: ${scorePercent.toFixed(2)}% similarity`;
                            buttonText = '⚠️ View Warning';
                        } else {
                            statusClass = 'status-error';
                            statusTitle = `❌ Poor: ${scorePercent.toFixed(2)}% similarity`;
                            buttonText = '❌ View Issues';
                        }
                        const badgeColor = scorePercent >= 85 ? '#155724' : scorePercent >= 70 ? '#856404' : '#721c24';
                        const compositeScore = Number.isFinite(Number(storedResult.compositeScore))
                            ? Number(storedResult.compositeScore)
                            : (Number.isFinite(Number(storedResult.baselineScore)) ? Number(storedResult.baselineScore) : null);
                        const semanticScore = Number.isFinite(Number(storedResult.semanticScore)) ? Number(storedResult.semanticScore) : null;
                        const lexicalScore = Number.isFinite(Number(storedResult.lexicalScore)) ? Number(storedResult.lexicalScore) : null;
                        const scoreSource = String(
                            storedResult.scoreSource ||
                            (storedResult.manualApproved ? 'manual' : ((storedResult.aiUsed || Number.isFinite(Number(storedResult.aiScore))) ? 'ai' : 'calculated'))
                        ).toLowerCase();
                        const tooltipParts = [
                            `Final score: ${scorePercent.toFixed(2)}%`,
                            `Status: ${statusClass === 'status-good' ? 'PASS' : statusClass === 'status-warning' ? 'REVIEW' : 'FAIL'}`,
                            `Source: ${scoreSource || 'unknown'}`
                        ];
                        if (compositeScore != null) tooltipParts.push(`Composite: ${compositeScore.toFixed(2)}%`);
                        if (semanticScore != null) tooltipParts.push(`Semantic: ${semanticScore.toFixed(2)}%`);
                        if (lexicalScore != null) tooltipParts.push(`Lexical: ${lexicalScore.toFixed(2)}%`);
                        if (storedResult.aiUsed && Number.isFinite(Number(storedResult.aiScore))) {
                            const aiScoreNum = Number(storedResult.aiScore);
                            const rawAiModel = String(storedResult.aiModel || '').trim();
                            const aiModel = rawAiModel.toLowerCase() === 'gpt-4.1' ? '' : rawAiModel;
                            tooltipParts.push(`AI score: ${aiScoreNum.toFixed(2)}%${aiModel ? ` via ${aiModel}` : ''}`);
                        }
                        if (storedResult.scoringVersion) tooltipParts.push(`Scoring version: ${storedResult.scoringVersion}`);
                        scoreBadgeHtml = `<span class="score-badge" title="${escapeHtml(tooltipParts.join(' | '))}" style="color: ${badgeColor}">${scorePercentRounded}%</span>`;
                        if (scoreSource === 'manual') {
                            sourceBadgeHtml = `<span class="score-source-badge" title="Manually approved" style="font-size: 10px; font-weight: 700; margin-left: 4px; opacity: 0.95; color: #4a148c; background: #f3e5f5; border: 1px solid #ce93d8; border-radius: 3px; padding: 1px 4px;">Manual</span>`;
                        } else if (scoreSource === 'ai') {
                            const rawAiModelName = String(storedResult.aiModel || '').trim();
                            const aiModelName = rawAiModelName.toLowerCase() === 'gpt-4.1' ? '' : rawAiModelName;
                            const aiBadgeText = aiModelName ? `AI ${escapeHtml(aiModelName)}` : 'AI';
                            const aiTitle = aiModelName ? `AI-refined score via ${escapeHtml(aiModelName)}` : 'AI-refined score';
                            sourceBadgeHtml = `<span class="score-source-badge" title="${aiTitle}" style="font-size: 10px; font-weight: 700; margin-left: 4px; opacity: 0.95; color: #0d47a1; background: #e3f2fd; border: 1px solid #90caf9; border-radius: 3px; padding: 1px 4px;">${aiBadgeText}</span>`;
                        } else {
                            sourceBadgeHtml = `<span class="score-source-badge" title="Calculated from back-translation overlap" style="font-size: 10px; font-weight: 700; margin-left: 4px; opacity: 0.95; color: #1b5e20; background: #e8f5e9; border: 1px solid #a5d6a7; border-radius: 3px; padding: 1px 4px;">Calc</span>`;
                        }
                    }
                    if (!canValidateTranslation) {
                        statusClass = 'status-pending';
                        statusTitle = `Missing ${langCode} translation`;
                        buttonText = 'Missing';
                    }
                    if (requiresRevalidation && canValidateTranslation) {
                        const changeLabel = changeKind === 'source+translation'
                            ? 'source + translation changed'
                            : (changeKind === 'source' ? 'source changed' : 'translation changed');
                        statusClass = 'status-pending';
                        statusTitle = `⚠️ Revalidation required (${changeLabel || 'content changed'})`;
                        buttonText = 'Revalidate';
                    }
                    const advisory = this.getEmbeddingAdvisoryEntry(itemId, langCode);
                    if (advisory && Number.isFinite(Number(advisory.score))) {
                        const advisoryScorePercent = Number(advisory.score) * 100;
                        const advisoryScoreRounded = Math.round(advisoryScorePercent);
                        const advisoryStatus = String(advisory.status || '').toLowerCase();
                        const advisoryColor =
                            advisoryStatus === 'pass' ? '#0d47a1' :
                            advisoryStatus === 'review' ? '#8a6d1a' :
                            '#721c24';
                        const advisoryBg =
                            advisoryStatus === 'pass' ? '#e3f2fd' :
                            advisoryStatus === 'review' ? '#fff8e1' :
                            '#fdecea';
                        const advisoryLabel = advisoryStatus ? advisoryStatus.toUpperCase() : 'N/A';
                        const advisoryDataset = advisory.dataset ? String(advisory.dataset).toUpperCase() : '';
                        const advisoryModel = advisory.model ? String(advisory.model) : 'unknown model';
                        const advisoryTitle = [
                            'Embedding advisory (info only)',
                            `Score: ${advisoryScorePercent.toFixed(2)}%`,
                            `Status: ${advisoryLabel}`,
                            `Model: ${advisoryModel}`,
                            advisoryDataset ? `Dataset: ${advisoryDataset}` : ''
                        ].filter(Boolean).join(' | ');
                        const rowStatusClass =
                            advisoryStatus === 'pass' ? 'embedding-row-pass' :
                            advisoryStatus === 'review' ? 'embedding-row-review' :
                            'embedding-row-fail';
                        const advisoryDatasetLabel = advisoryDataset ? ` ${escapeHtml(advisoryDataset)}` : '';
                        embeddingRowHtml = `<div class="item-embedding-score ${rowStatusClass}" title="${escapeHtml(advisoryTitle)}"><span class="item-embedding-label">Embedding${advisoryDatasetLabel}:</span> <span class="item-embedding-value">${advisoryScoreRounded}%</span> <span class="item-embedding-status">(${advisoryLabel})</span></div>`;
                    }
                    const manualApproved = this.isManualApprovedEntry(storedResult);
                    approvedHtml = `<label class="approved-toggle-label" title="Manual approval sets score to 100% and marks source as Manual" style="display: inline-flex; align-items: center; gap: 4px; margin-left: 6px; font-size: 11px; color: ${manualApproved ? '#2e7d32' : '#6c757d'}; cursor: pointer;"><input type="checkbox" class="approved-checkbox" data-item-id="${escapedItemId}" data-lang-code="${langCode}" ${manualApproved ? 'checked' : ''} onchange="window.setManualApprovalForValidation && window.setManualApprovalForValidation('${escapedItemId}', '${langCode}', this.checked, this.closest('.data-row'))" style="cursor: pointer;">Approved</label>`;
                    
                    row.dataset.score = scoreValue;
                    row.dataset.needsReview = needsReview ? '1' : '0';
                    row.dataset.approved = (!requiresRevalidation && manualApproved) ? '1' : '0';
                    if (!requiresRevalidation && manualApproved) {
                        row.style.outline = '2px solid rgba(76,175,80,0.45)';
                        row.style.outlineOffset = '-2px';
                        row.style.background = 'rgba(46,125,50,0.08)';
                    } else {
                        row.style.outline = '';
                        row.style.outlineOffset = '';
                        row.style.background = '';
                    }
                    row.innerHTML = `
                        <div class="item-id-cell">
                            <div class="item-id-top">
                                <div class="item_id" title="${escapeHtml(displayItemIdText)}">${escapeHtml(compactItemId)}</div>
                                <button class="item-id-copy-btn" type="button" title="Copy full key" onclick="copyItemIdToClipboard('${escapedItemId}', this, event)">
                                    <i class="fas fa-copy"></i>
                                </button>
                            </div>
                            <div class="item-meta-badges">
                                <span class="item-task" title="${escapedTaskName}">${escapedTaskName}</span>
                                <span class="item-type" title="${escapedTypeName}">${escapedTypeName}</span>
                            </div>
                            ${embeddingRowHtml}
                        </div>
                        <div class="item-english">
                            <div class="item-english-source">${escapedOriginalText}</div>
                            ${backTranslationHtml}
                        </div>
                        <div class="item-text">
                            ${escapedDisplayText}
                            <div class="validation-status">
                                <div class="status-indicator ${statusClass}" title="${statusTitle}" data-item-id="${itemId}" ${indicatorOnClick}></div>
                                <div class="validation-action-buttons">
                                    <button class="validate-btn" onclick="${validateOnClick}" ${canValidateTranslation ? '' : 'disabled'}>${buttonText}</button>
                                    ${infoButtonHtml}
                                </div>
                                ${scoreBadgeHtml}
                                ${sourceBadgeHtml}
                                ${requiresRevalidation
                                    ? (
                                        translationUpdated
                                            ? '<span class="translation-updated-indicator" title="Translation changed since the previous reviewed/validated version." style="display:inline-flex; align-items:center; gap:4px; margin-left:6px; font-size:11px; font-weight:700; color:#0d47a1; background:#e3f2fd; border:1px solid #90caf9; border-radius:4px; padding:1px 6px;">🆕 Updated</span>'
                                            : '<span class="stale-validation-indicator" title="Source changed; revalidate to refresh review status." style="display:inline-flex; align-items:center; gap:4px; margin-left:6px; font-size:11px; font-weight:700; color:#b26a00; background:#fff3e0; border:1px solid #ffcc80; border-radius:4px; padding:1px 6px;">⚠ Revalidate</span>'
                                    )
                                    : ''}
                                <span class="approved-indicator" style="display: ${(!requiresRevalidation && manualApproved) ? 'inline-flex' : 'none'}; align-items: center; gap: 4px; margin-left: 6px; font-size: 11px; font-weight: 700; color: #1b5e20; background: #e8f5e9; border: 1px solid #a5d6a7; border-radius: 4px; padding: 1px 6px;">✅ Approved</span>
                            </div>
                            <div class="needs-review-container" style="margin-top: 6px; display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap;">
                                ${approvedHtml}
                                <label class="needs-review-toggle-label" style="display: ${manualApproved ? 'none' : 'flex'}; align-items: center; gap: 4px; cursor: pointer; font-size: 0.8em; color: ${needsReview ? '#dc3545' : '#6c757d'};">
                                    <input type="checkbox" class="needs-review-checkbox" data-item-id="${escapedItemId}" data-lang-code="${langCode}" ${needsReview ? 'checked' : ''} style="cursor: pointer;">
                                    <i class="fas fa-flag" style="color: ${needsReview ? '#dc3545' : '#adb5bd'};"></i> Needs Review
                                </label>
                                <div class="reason-container" style="display: ${(!manualApproved && needsReview) ? 'flex' : 'none'}; align-items: center; gap: 4px; flex: 1; min-width: 150px;">
                                    <input type="text" class="reason-input" data-item-id="${escapedItemId}" data-lang-code="${langCode}" value="${reviewReason.replace(/"/g, '&quot;')}" placeholder="Reason..." style="flex: 1; padding: 3px 6px; font-size: 0.8em; border: 1px solid #ced4da; border-radius: 4px; min-width: 100px;">
                                </div>
                            </div>
                        </div>
                        <div class="audio-controls">
                            <span class="edited-text-indicator" data-item-id="${escapedItemId}" title="Regen will use edited text from the text box">Edited text</span>
                            <button class="play-btn" onclick="playAudio('${escapedItemId}', '${langCode}')" title="Play existing audio">
                                <i class="fas fa-play"></i>
                            </button>
                            <button class="regen-btn" onclick="regenerateItemAudio('${escapedItemId}', '${langCode}')" title="Re-generate audio with selected voice">
                                <i class="fas fa-arrows-rotate"></i>
                            </button>
                            <button class="save-btn" data-item-id="${escapedItemId}" data-lang-code="${langCode}" onclick="saveItemAudio('${escapedItemId}', '${langCode}')" title="Generate audio before saving" disabled>
                                 <i class="fas fa-floppy-disk"></i>
                             </button>
                        </div>
                    `;
                    
                    const saveButton = row.querySelector('.save-btn');
                    if (saveButton) {
                        saveButton.dataset.itemId = itemId;
                        saveButton.dataset.langCode = langCode;
                        const pendingKey = this.pendingSaveKey;
                        const canonicalLangCode = this.getCanonicalAudioLangCode(langCode);
                        const key = `${canonicalLangCode}::${itemId}`;
                        const isPending = Boolean(
                            pendingKey &&
                            pendingKey === key &&
                            this.latestGeneratedAudio &&
                            this.latestGeneratedAudio.itemId === itemId &&
                            this.getCanonicalAudioLangCode(this.latestGeneratedAudio.langCode) === canonicalLangCode
                        );
                        saveButton.disabled = !isPending;
                        saveButton.title = isPending ? 'Save latest generated audio to draft bucket' : 'Generate audio before saving';
                    }
                    const editedTextIndicator = row.querySelector('.edited-text-indicator');
                    if (editedTextIndicator) {
                        editedTextIndicator.style.display = this.shouldUseEditedTextForItem(itemId) ? 'inline-flex' : 'none';
                    }
                    row.addEventListener('click', () => this.selectRow(row, item));
                    return row;
            }
            
            setupSortAndReviewHandlers() {
                const self = this;
                const tableContent = document.getElementById(`table-${this.currentLanguage}`);
                if (!tableContent) return;
                
                // Sort button handlers
                document.querySelectorAll(`.sort-btn[data-lang="${this.currentLanguage}"]`).forEach(btn => {
                    btn.onclick = (e) => {
                        e.stopPropagation();
                        const sortType = btn.dataset.sort;
                        self.sortTable(sortType);
                    };
                });
                
                // Needs Review checkbox handlers
                tableContent.querySelectorAll('.needs-review-checkbox').forEach(checkbox => {
                    checkbox.onclick = (e) => e.stopPropagation(); // Prevent row selection
                    checkbox.onchange = (e) => {
                        const itemId = checkbox.dataset.itemId;
                        const langCode = checkbox.dataset.langCode;
                        const isChecked = checkbox.checked;
                        const row = checkbox.closest('.data-row');
                        const reasonContainer = row.querySelector('.reason-container');
                        const reasonInput = row.querySelector('.reason-input');
                        const label = checkbox.closest('label');
                        const flagIcon = label.querySelector('.fa-flag');
                        
                        // Show/hide reason field
                        reasonContainer.style.display = isChecked ? 'flex' : 'none';
                        label.style.color = isChecked ? '#dc3545' : '#6c757d';
                        flagIcon.style.color = isChecked ? '#dc3545' : '#adb5bd';
                        row.dataset.needsReview = isChecked ? '1' : '0';
                        
                        // Update validation_results
                        if (!self.validation_results[itemId]) {
                            self.validation_results[itemId] = {};
                        }
                        const preferredLangCode = self.resolvePreferredLangCode(langCode);
                        if (!self.validation_results[itemId][preferredLangCode]) {
                            self.validation_results[itemId][preferredLangCode] = {};
                        }
                        self.validation_results[itemId][preferredLangCode].needsReview = isChecked;
                        self.validation_results[itemId][preferredLangCode].reviewUpdatedAt = new Date().toISOString();
                        
                        // Clear reason if unchecked
                        if (!isChecked) {
                            reasonInput.value = '';
                            self.validation_results[itemId][preferredLangCode].reason = '';
                            if (typeof queueValidationAutoSave === 'function') queueValidationAutoSave();
                        }
                        if (typeof updateValidationSummary === 'function') updateValidationSummary();
                        console.log(`📝 Needs Review ${isChecked ? 'set' : 'cleared'} for ${itemId}[${langCode}]`);
                    };
                });

                // Manual Approved checkbox click should not select row
                tableContent.querySelectorAll('.approved-checkbox').forEach(checkbox => {
                    checkbox.onclick = (e) => e.stopPropagation();
                });
                
                // Reason input handlers
                tableContent.querySelectorAll('.reason-input').forEach(input => {
                    input.onclick = (e) => e.stopPropagation(); // Prevent row selection
                    const saveReasonToStore = () => {
                        const itemId = input.dataset.itemId;
                        const langCode = input.dataset.langCode;
                        const reason = String(input.value || '').trim();
                        if (!self.validation_results[itemId]) {
                            self.validation_results[itemId] = {};
                        }
                        const preferredLangCode = self.resolvePreferredLangCode(langCode);
                        if (!self.validation_results[itemId][preferredLangCode]) {
                            self.validation_results[itemId][preferredLangCode] = {};
                        }
                        if (self.validation_results[itemId][preferredLangCode].reason === reason) return;
                        self.validation_results[itemId][preferredLangCode].reason = reason;
                        self.validation_results[itemId][preferredLangCode].reviewUpdatedAt = new Date().toISOString();
                        if (typeof requestValidationSummaryUpdate === 'function') requestValidationSummaryUpdate(180);
                        else if (typeof updateValidationSummary === 'function') updateValidationSummary();
                    };
                    const scheduleSharedSave = () => {
                        const itemId = String(input.dataset.itemId || '').trim();
                        const langCode = String(input.dataset.langCode || '').trim();
                        const timerKey = `${itemId}::${langCode}`;
                        if (self.reasonAutoSaveTimers.has(timerKey)) {
                            clearTimeout(self.reasonAutoSaveTimers.get(timerKey));
                        }
                        const timerId = setTimeout(() => {
                            self.reasonAutoSaveTimers.delete(timerKey);
                            if (typeof queueValidationAutoSave === 'function') queueValidationAutoSave();
                        }, 2200);
                        self.reasonAutoSaveTimers.set(timerKey, timerId);
                    };
                    input.oninput = () => {
                        saveReasonToStore();
                        scheduleSharedSave();
                    };
                    input.onchange = () => {
                        saveReasonToStore();
                        if (typeof queueValidationAutoSave === 'function') queueValidationAutoSave();
                    };
                    input.onblur = () => {
                        saveReasonToStore();
                        if (typeof queueValidationAutoSave === 'function') queueValidationAutoSave();
                    };
                });
            }
            
            sortTable(sortType) {
                this.ensureLanguageFullyRendered(this.currentLanguage);
                const tableContent = document.getElementById(`table-${this.currentLanguage}`);
                if (!tableContent) return;
                
                const rows = Array.from(tableContent.querySelectorAll('.data-row'));
                
                rows.sort((a, b) => {
                    if (sortType === 'score-desc') {
                        const scoreA = parseFloat(a.dataset.score) || -1;
                        const scoreB = parseFloat(b.dataset.score) || -1;
                        return scoreB - scoreA; // Highest first
                    } else if (sortType === 'score-asc') {
                        const scoreA = parseFloat(a.dataset.score) || -1;
                        const scoreB = parseFloat(b.dataset.score) || -1;
                        // Put -1 (not validated) at the end
                        if (scoreA === -1 && scoreB !== -1) return 1;
                        if (scoreB === -1 && scoreA !== -1) return -1;
                        return scoreA - scoreB; // Lowest first
                    } else if (sortType === 'id') {
                        const idA = a.dataset.itemId || '';
                        const idB = b.dataset.itemId || '';
                        return idA.localeCompare(idB);
                    } else if (sortType === 'review') {
                        const reviewA = a.dataset.needsReview === '1' ? 1 : 0;
                        const reviewB = b.dataset.needsReview === '1' ? 1 : 0;
                        return reviewB - reviewA; // Needs review first
                    }
                    return 0;
                });
                
                // Re-append rows in sorted order
                rows.forEach(row => tableContent.appendChild(row));
                
                this.setStatus(`Sorted by ${sortType.replace('-', ' ')}`, 'success');
            }

            selectRow(rowElement, item) {
                // Remove previous selection
                document.querySelectorAll('.data-row').forEach(row => row.classList.remove('selected'));
                
                // Add selection to clicked row
                rowElement.classList.add('selected');
                this.selectedRow = item;
                
                                    const langCode = this.getCurrentLanguageCode();
                    // Try exact lang code, then base language (e.g., de-CH -> de), then any case variations
                    let text = item[langCode];
                    if (!text && langCode.includes('-')) {
                        const base = langCode.split('-')[0];
                        text = item[base];
                    }
                    if (!text) {
                        // Attempt case-insensitive lookup of headers
                        const keys = Object.keys(item);
                        const match = keys.find(k => k.toLowerCase() === langCode.toLowerCase());
                        text = match ? item[match] : null;
                    }
                    if (!text) text = item.en || 'No translation available';
                const itemId = item.item_id || 'unknown_id';
                
                console.log('Selected item:', { item, itemId, langCode, text: text.substring(0, 50) });
                this.setStatus(`Selected: ${itemId} - "${text.substring(0, 50)}..."`, 'success');
                this.updateEditedTextIndicators();
            }

            async switchTab(language, button) {
                if (language === this.currentLanguage) return;
                if (this.hasUnsavedValidationChanges()) {
                    const choice = await this.promptUnsavedValidationAction();
                    if (choice === 'stay') return;
                    if (choice === 'discard') {
                        this.restoreValidationResultsFromBaselineSnapshot();
                        this.noteValidationResultsChanged();
                    }
                }
                // Update active states immediately so INP stays low (tab switch is visible right away)
                document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
                button.classList.add('active');
                const tabEl = document.getElementById(`tab-${language}`);
                if (tabEl) tabEl.classList.add('active');
                
                this.currentLanguage = language;
                
                // Defer heavy work so the click handler returns quickly (fixes 5s+ INP)
                if (typeof setValidationSummaryLoading === 'function') setValidationSummaryLoading(true);
                requestAnimationFrame(() => {
                    void (async () => {
                        this.refreshLanguagesFromConfig();
                        this.populateVoices();
                        const langConfig = this.languages[language];
                        const label = langConfig ? `${this.getDisplayName(language)} - ${langConfig.service} (${langConfig.lang_code})` : language;
                        this.setStatus(`Switched to ${label}`, 'success');
                        const scopedLangCode = String(langConfig?.lang_code || '').trim();
                        if (scopedLangCode) {
                            try {
                                const sharedMerged = await this.loadFromSharedStorage(scopedLangCode);
                                if (sharedMerged) this.noteValidationResultsChanged();
                            } catch (e) {
                                console.log(`Language-scoped shared load skipped for ${scopedLangCode}:`, e?.message || e);
                            }
                        }
                        if (this.currentLanguage !== language) return;
                        this.populateDataTable();
                    })();
                });
            }

            populateVoices() {
                // Ensure latest language map
                this.refreshLanguagesFromConfig();
                const playhtSelect = document.getElementById('playhtVoice');
                const elevenlabsSelect = document.getElementById('elevenlabsVoice');
                
                // Clear existing options
                playhtSelect.innerHTML = '<option value="">Select PlayHT Voice...</option>';
                elevenlabsSelect.innerHTML = '<option value="">Select ElevenLabs Voice...</option>';
                
                const langCode = this.getCurrentLanguageCode();
                if (!langCode) {
                    this.setStatus('Current language is missing a language code. Please check language settings.', 'warning');
                    return;
                }
                
                // Filter and populate PlayHT voices for current language (accept base language of BCP-47)
                const baseLang = langCode.includes('-') ? langCode.split('-')[0] : langCode;
                const playhtVoices = this.voices.playht.filter(voice => 
                    voice.lang_code === langCode || voice.language === langCode || voice.lang_code === baseLang || voice.language === baseLang
                );
                
                playhtVoices.forEach(voice => {
                    const option = document.createElement('option');
                    option.value = voice.voice_id;
                    option.textContent = voice.name;
                    playhtSelect.appendChild(option);
                });
                
                // Filter and populate ElevenLabs voices for current language (accept base language of BCP-47)
                const elevenlabsVoices = this.voices.elevenlabs.filter(voice => {
                    const vLang = voice.lang_code || voice.language || '';
                    const vBase = vLang.includes('-') ? vLang.split('-')[0] : vLang;
                    return vLang === langCode || vLang === baseLang || vBase === baseLang;
                });
                
                // Deduplicate by voice_id (or name fallback) to avoid duplicates from base/regional overlaps
                const seenVoiceIds = new Set();
                const uniqueElevenLabs = [];
                elevenlabsVoices.forEach(v => {
                    const key = v.voice_id || v.name;
                    if (key && !seenVoiceIds.has(key)) {
                        seenVoiceIds.add(key);
                        uniqueElevenLabs.push(v);
                    }
                });
                
                uniqueElevenLabs.forEach(voice => {
                    const option = document.createElement('option');
                    option.value = voice.voice_id;
                    option.textContent = voice.name;
                    elevenlabsSelect.appendChild(option);
                });
            }

            setupEventListeners() {
                // Refresh voices button
                document.getElementById('refreshVoices').addEventListener('click', async () => {
                    // Re-load real ElevenLabs voices (uses any newly saved credentials)
                    await this.loadComprehensiveVoices();
                    this.populateVoices();
                    this.setStatus('Voices reloaded from services', 'success');
                });

                // Voice selection handlers
                document.getElementById('playhtVoice').addEventListener('change', (e) => {
                    if (e.target.value) {
                        this.setStatus(`PlayHT voice selected: ${e.target.options[e.target.selectedIndex].text}`, 'success');
                    }
                });

                document.getElementById('elevenlabsVoice').addEventListener('change', (e) => {
                    if (e.target.value) {
                        this.setStatus(`ElevenLabs voice selected: ${e.target.options[e.target.selectedIndex].text}`, 'success');
                    }
                });

                // Copy buttons for voice names
                document.getElementById('copyPlayhtVoice').addEventListener('click', () => {
                    const select = document.getElementById('playhtVoice');
                    if (select.selectedIndex > 0) {
                        const voiceName = select.options[select.selectedIndex].text;
                        navigator.clipboard.writeText(voiceName).then(() => {
                            this.setStatus(`Copied PlayHT voice: ${voiceName}`, 'success');
                        });
                    } else {
                        this.setStatus('No PlayHT voice selected', 'error');
                    }
                });

                document.getElementById('copyElevenlabsVoice').addEventListener('click', () => {
                    const select = document.getElementById('elevenlabsVoice');
                    if (select.selectedIndex > 0) {
                        const voiceName = select.options[select.selectedIndex].text;
                        navigator.clipboard.writeText(voiceName).then(() => {
                            this.setStatus(`Copied ElevenLabs voice: ${voiceName}`, 'success');
                        });
                    } else {
                        this.setStatus('No ElevenLabs voice selected', 'error');
                    }
                });

                // Text generation controls
                document.getElementById('generateAudio').addEventListener('click', () => {
                    this.generateAudioFromText();
                });

                document.getElementById('populateSelected').addEventListener('click', () => {
                    this.populateSelectedText();
                });

                const textInput = document.getElementById('textInput');
                if (textInput && !textInput.dataset.boundEditedIndicator) {
                    textInput.addEventListener('input', () => this.updateEditedTextIndicators());
                    textInput.dataset.boundEditedIndicator = 'true';
                }

                const viewDraftAudioBtn = document.getElementById('viewDraftAudio');
                if (viewDraftAudioBtn) {
                    viewDraftAudioBtn.addEventListener('click', () => {
                        window.open('./draft-share.html?bucket=levante-assets-draft&folder=audio', '_blank', 'noopener');
                    });
                }

                const viewApprovedAudioBtn = document.getElementById('viewApprovedAudio');
                if (viewApprovedAudioBtn) {
                    viewApprovedAudioBtn.addEventListener('click', () => {
                        window.open('./draft-share.html?bucket=levante-assets-dev&folder=audio', '_blank', 'noopener');
                    });
                }

                this.setupLocationPanel();

                 // Setup search functionality for all language tabs
                 this.setupSearchListeners();
             }

            setupLocationPanel() {
                const button = document.getElementById('locateMeButton');
                const outputEl = document.getElementById('locationResultText');
                if (!button || !outputEl) return;

                const setMessage = (message) => {
                    outputEl.textContent = message;
                };

                if (!('geolocation' in navigator)) {
                    button.disabled = true;
                    button.textContent = 'Location unavailable';
                    setMessage('Geolocation is not supported in this browser.');
                    return;
                }

                button.addEventListener('click', () => {
                    const original = button.innerHTML;
                    button.disabled = true;
                    button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Locating...';
                    setMessage('Requesting device location...');

                    navigator.geolocation.getCurrentPosition(async (position) => {
                        const { latitude, longitude } = position.coords;
                        setMessage(`Coordinates acquired: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}. Resolving nearest city...`);
                        try {
                            const query = new URLSearchParams({
                                lat: latitude.toString(),
                                lon: longitude.toString(),
                                limit: '3',
                                maxDistanceKm: '150'
                            });
                            const response = await fetch(`/api/reverse-geocode?${query.toString()}`);
                            if (!response.ok) {
                                const text = await response.text();
                                throw new Error(text || `HTTP ${response.status}`);
                            }
                            const payload = await response.json();
                            if (payload.results && payload.results.length) {
                                const best = payload.results[0];
                                const parts = [
                                    best.name,
                                    best.admin1,
                                    best.country
                                ].filter(Boolean);
                                const locationLine = parts.join(', ');
                                setMessage(`${locationLine || 'Unknown area'} · approx ${best.distanceKm} km away`);
                                this.setStatus(`Detected nearest city: ${locationLine || 'Unknown area'}`, 'success');
                            } else {
                                setMessage('No nearby populated place found within 150 km.');
                                this.setStatus('No nearby city found for your location.', 'warning');
                            }
                        } catch (error) {
                            console.error('Locate me error', error);
                            setMessage('Unable to resolve location.');
                            this.setStatus(`Failed to resolve location: ${error.message}`, 'error');
                        } finally {
                            button.disabled = false;
                            button.innerHTML = original;
                        }
                    }, (error) => {
                        let message = 'Location request failed.';
                        if (error.code === error.PERMISSION_DENIED) {
                            message = 'Location permission denied.';
                        } else if (error.code === error.POSITION_UNAVAILABLE) {
                            message = 'Location unavailable.';
                        } else if (error.code === error.TIMEOUT) {
                            message = 'Location request timed out.';
                        }
                        setMessage(message);
                        this.setStatus(message, 'error');
                        button.disabled = false;
                        button.innerHTML = original;
                    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
                });
            }

            setupSearchListeners() {
                 // Add search event listeners for each language
                 Object.keys(this.languages).forEach(language => {
                     const searchBox = document.getElementById(`search-${language}`);
                     if (searchBox) {
                         searchBox.addEventListener('input', (e) => {
                             this.filterTable(language, e.target.value);
                         });
                     }
                 });
             }

             filterTable(language, searchTerm) {
                 this.ensureLanguageFullyRendered(language);
                 const tableContent = document.getElementById(`table-${language}`);
                 if (!tableContent) return;

                 const rows = tableContent.querySelectorAll('.data-row');
                 const searchLower = searchTerm.toLowerCase();
                 let visibleCount = 0;

                 rows.forEach(row => {
                     const itemId = row.querySelector('.item_id')?.textContent || '';
                     const itemText = row.querySelector('.item-text')?.textContent || '';
                     const itemEnglish = row.querySelector('.item-english')?.textContent || '';
                     const itemTask = row.querySelector('.item-task')?.textContent || '';

                     const matches = 
                         itemId.toLowerCase().includes(searchLower) ||
                         itemText.toLowerCase().includes(searchLower) ||
                         itemEnglish.toLowerCase().includes(searchLower) ||
                         itemTask.toLowerCase().includes(searchLower);

                     if (matches) {
                         row.style.display = '';
                         visibleCount++;
                     } else {
                         row.style.display = 'none';
                     }
                 });

                 // Update item count to show filtered results
                 const itemCountSpan = document.getElementById(`item-count-${language}`);
                 if (itemCountSpan) {
                     if (searchTerm) {
                         itemCountSpan.textContent = `(${visibleCount} of ${rows.length} items)`;
                         itemCountSpan.style.color = '#007bff';
                     } else {
                         itemCountSpan.textContent = `(${rows.length} items)`;
                         itemCountSpan.style.color = '#6c757d';
                     }
                 }

                 if (searchTerm) {
                    this.setStatus(`Showing ${visibleCount} items matching "${searchTerm}" in ${this.getDisplayName(language)}`, 'success');
                }
            }

            setupFileFilterListeners() {
                Object.keys(this.languages).forEach((language) => {
                    const selectEl = document.getElementById(`file-filter-${language}`);
                    if (!selectEl || selectEl.dataset.bound === 'true') return;
                    selectEl.addEventListener('change', () => {
                        this.fileFilterByLanguage.set(language, selectEl.value || 'all');
                        if (this.currentLanguage === language) {
                            if (typeof setValidationSummaryLoading === 'function') setValidationSummaryLoading(true);
                            this.populateDataTable();
                        }
                    });
                    selectEl.dataset.bound = 'true';
                });
            }

            getLanguageConfigByCode(langCode) {
                const exactMatch = Object.values(this.languages).find(cfg => cfg.lang_code === langCode);
                if (exactMatch) return exactMatch;
                const base = langCode.includes('-') ? langCode.split('-')[0] : langCode;
                return Object.values(this.languages).find(cfg => {
                    const cfgLang = cfg.lang_code || '';
                    const cfgBase = cfgLang.includes('-') ? cfgLang.split('-')[0] : cfgLang;
                    return cfgBase === base;
                }) || this.languages[this.currentLanguage];
            }

            async fetchExistingAudioMetadata(itemId, langCode) {
                if (!itemId || !langCode) return null;
                try {
                    const candidates = [...new Set([this.getCanonicalAudioLangCode(langCode), String(langCode || '').trim()].filter(Boolean))];
                    const cacheKey = `${candidates[0] || langCode}::${itemId}`;
                    if (!this.audioMetadataCache) {
                        this.audioMetadataCache = new Map();
                    }
                    if (this.audioMetadataCache.has(cacheKey)) {
                        return this.audioMetadataCache.get(cacheKey);
                    }
                    for (let i = 0; i < candidates.length; i++) {
                        const candidate = candidates[i];
                        const response = await fetch(`/api/read-tags?itemId=${encodeURIComponent(itemId)}&langCode=${encodeURIComponent(candidate)}`);
                        if (!response.ok) continue;
                        const data = await response.json();
                        if (data && !data.error) {
                            this.audioMetadataCache.set(cacheKey, data);
                            return data;
                        }
                    }
                    return null;
                } catch (error) {
                    console.warn('⚠️ Failed to fetch existing audio metadata:', error);
                    return null;
                }
            }

            findVoiceCandidate(service, voiceDescriptor, langCode) {
                if (!voiceDescriptor) return null;
                const descriptor = String(voiceDescriptor).trim();
                if (!descriptor) return null;
                const baseLang = langCode && langCode.includes('-') ? langCode.split('-')[0] : langCode;
                const serviceKey = (service || '').toString().toLowerCase();
                let candidates = [];
                if (serviceKey === 'playht') {
                    candidates = this.voices.playht || [];
                } else if (serviceKey === 'elevenlabs') {
                    candidates = this.voices.elevenlabs || [];
                } else {
                    candidates = (this.voices.playht || []).concat(this.voices.elevenlabs || []);
                }

                const normalize = (value) => (value || '').toString().trim();

                const byExactId = candidates.find(v => normalize(v.voice_id) === descriptor);
                if (byExactId) return byExactId;

                const byExactName = candidates.find(v => normalize(v.name) === descriptor);
                if (byExactName) return byExactName;

                if (langCode) {
                    const byLang = candidates.find(v => normalize(v.lang_code) === langCode && normalize(v.name) === descriptor);
                    if (byLang) return byLang;
                    const byBaseLang = candidates.find(v => normalize(v.lang_code) === baseLang && normalize(v.name) === descriptor);
                    if (byBaseLang) return byBaseLang;
                }

                return null;
            }

            async resolveVoiceSelection(langCode, itemId = null, { allowMetadataFallback = false } = {}) {
                const playhtSelect = document.getElementById('playhtVoice');
                const elevenlabsSelect = document.getElementById('elevenlabsVoice');
                const playhtVoiceId = (playhtSelect && playhtSelect.selectedIndex > 0) ? playhtSelect.value : '';
                const playhtVoiceName = (playhtSelect && playhtSelect.selectedIndex > 0) ? playhtSelect.options[playhtSelect.selectedIndex].text : '';
                const elevenlabsVoiceId = (elevenlabsSelect && elevenlabsSelect.selectedIndex > 0) ? elevenlabsSelect.value : '';
                const elevenlabsVoiceName = (elevenlabsSelect && elevenlabsSelect.selectedIndex > 0) ? elevenlabsSelect.options[elevenlabsSelect.selectedIndex].text : '';
                const config = this.getLanguageConfigByCode(langCode);
                let service = null;
                let voiceId = null;
                let voiceName = null;
                let source = 'selection';

                if (playhtVoiceId && elevenlabsVoiceId) {
                    if (config && config.service === 'PlayHT') {
                        service = 'PlayHT';
                        voiceId = playhtVoiceId;
                        voiceName = playhtVoiceName;
                    } else {
                        service = 'ElevenLabs';
                        voiceId = elevenlabsVoiceId;
                        voiceName = elevenlabsVoiceName;
                    }
                } else if (playhtVoiceId) {
                    service = 'PlayHT';
                    voiceId = playhtVoiceId;
                    voiceName = playhtVoiceName;
                } else if (elevenlabsVoiceId) {
                    service = 'ElevenLabs';
                    voiceId = elevenlabsVoiceId;
                    voiceName = elevenlabsVoiceName;
                }

                if (!service && allowMetadataFallback && itemId) {
                    const metadata = await this.fetchExistingAudioMetadata(itemId, langCode);
                    const tags = metadata?.id3Tags || {};
                    const tagService = (tags.service || metadata?.service || '').toString();
                    const tagVoice = tags.voice || metadata?.voice || '';

                    if (tagService || tagVoice) {
                        const normalizedService = tagService.trim() || (config?.service || '');
                        const voiceCandidate = this.findVoiceCandidate(normalizedService, tagVoice, langCode);

                        if (voiceCandidate) {
                            service = normalizedService || (this.voices.playht.includes(voiceCandidate) ? 'PlayHT' : 'ElevenLabs');
                            voiceId = voiceCandidate.voice_id;
                            voiceName = voiceCandidate.name;
                            source = 'metadata';
                        } else if (normalizedService && tagVoice) {
                            service = normalizedService;
                            voiceId = tagVoice;
                            voiceName = tagVoice;
                            source = 'metadata';
                        }

                        if (service && voiceId) {
                            this.setStatus(`Using existing audio voice ${voiceName || voiceId} (${service})`, 'info');
                        }
                    }
                }

                return { service, voiceId, voiceName, source };
            }

            async openDraftAudioModal() {
                const modal = document.getElementById('draftAudioModal');
                if (!modal) {
                    window.open('./bucket-info.html', '_blank');
                    return;
                }
                this.bindCopyDraftLinkButton(modal);
                modal.style.display = 'block';
                await this.loadDraftAudioData();
            }

            async loadDraftAudioData() {
                const loadingEl = document.getElementById('draftAudioLoading');
                const bodyEl = document.getElementById('draftAudioBody');
                if (loadingEl) loadingEl.style.display = 'block';
                if (bodyEl) bodyEl.innerHTML = '';
                try {
                    this.setStatus('Loading draft audio files...', 'loading');
                    const response = await fetch('/api/list-draft-audio');
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(errorText || `Request failed (${response.status})`);
                    }
                    const data = await response.json();
                    const items = Array.isArray(data.items) ? data.items : [];
                    const bucketName = data.bucket || 'levante-assets-draft';
                    const prefix = data.prefix || 'audio/';
                    this.currentDraftBucketName = bucketName;
                    this.selectedDraftAudio = null;
                    const availablePaths = new Set(items.map(item => item.path || item.name).filter(Boolean));
                    if (!this.approvedDrafts) {
                        this.approvedDrafts = new Set();
                    } else if (availablePaths.size) {
                        this.approvedDrafts = new Set([...this.approvedDrafts].filter(path => availablePaths.has(path)));
                    }
                    items.forEach((item) => {
                        const path = item.path || item.name;
                        if (item.approvedBySite && path) {
                            this.approvedDrafts.add(path);
                        }
                    });

                    if (bodyEl) {
                        bodyEl.innerHTML = this.buildDraftAudioTable(items, { bucket: bucketName, prefix });
                        const modalEl = document.getElementById('draftAudioModal');
                        this.attachDraftRowHandlers(modalEl, bucketName);
                        this.bindDraftApprovalHandlers(modalEl);
                        const refreshBtn = document.getElementById('refreshDraftAudio');
                        if (refreshBtn) {
                            refreshBtn.addEventListener('click', () => this.loadDraftAudioData());
                        }
                        this.bindCopyDraftLinkButton(modalEl);
                    }
                    this.setStatus(`Loaded ${items.length} draft audio files`, 'success');
                } catch (error) {
                    console.error('Error loading draft audio files', error);
                    if (bodyEl) {
                        bodyEl.innerHTML = `<div class="draft-audio-empty">Failed to load draft audio files: ${error.message}</div>`;
                    }
                    this.setStatus(`❌ Error loading draft audio: ${error.message}`, 'error');
                } finally {
                    if (loadingEl) loadingEl.style.display = 'none';
                }
            }

            buildDraftAudioTable(items = [], meta = {}) {
                if (!items.length) {
                    const bucketName = meta.bucket || 'levante-assets-draft';
                    return `<div class="draft-audio-empty">No audio files found in <code>${bucketName}/audio</code>.</div>`;
                }

                this.selectedDraftAudio = null;
                const bucketName = meta.bucket || 'levante-assets-draft';
                const prefix = meta.prefix || 'audio/';
                const sorted = [...items].sort((a, b) => {
                    const dateA = new Date(a.updated || a.timeCreated || 0).getTime();
                    const dateB = new Date(b.updated || b.timeCreated || 0).getTime();
                    return dateB - dateA;
                });

                const summary = `
                    <div class="draft-audio-summary">
                        <div>
                            <strong>${sorted.length}</strong> files in <code>${bucketName}/${prefix}</code>
                        </div>
                        <div class="draft-actions">
                            <button id="refreshDraftAudio" class="btn btn-secondary btn-compact">
                                <i class="fas fa-sync-alt"></i> Refresh
                            </button>
                        </div>
                    </div>
                `;

                const rows = sorted.map(item => {
                    const language = item.language || (item.name && item.name.split('/')[1]) || '—';
                    const itemId = item.itemId || (item.name ? item.name.replace(/^audio\//, '').replace(/\.mp3$/i, '').split('/').pop() : '—');
                    const versionLabel = item.version ? `v${String(item.version).padStart(3, '0')}` : '—';
                    const rawPath = item.path || item.name;
                    const encodedPath = rawPath ? encodeURIComponent(rawPath) : '';
                    const sizeValue = Number(item.size || item.bytes || 0);
                    const formatSize = (typeof formatFileSize === 'function') ? formatFileSize(sizeValue) : `${sizeValue} bytes`;
                    const updatedRaw = item.updated || item.timeCreated || item.generation;
                    let updatedText = updatedRaw ? updatedRaw : '';
                    if (updatedRaw && typeof formatDate === 'function') {
                        updatedText = formatDate(updatedRaw);
                    } else if (updatedRaw) {
                        updatedText = new Date(updatedRaw).toLocaleString();
                    }
                    const siteApproved = Boolean(item.approvedBySite);
                    const isApproved = rawPath ? this.approvedDrafts?.has(rawPath) : false;
                    const checkedAttr = isApproved ? 'checked' : '';
                    const statusLabel = isApproved ? (siteApproved ? 'Approved' : 'Selected') : 'Pending';
                    const approvalCellClasses = ['draft-approve-cell'];
                    if (isApproved) approvalCellClasses.push('is-active');
                    if (siteApproved) approvalCellClasses.push('is-site-approved');
                    const approvalCellClass = approvalCellClasses.join(' ');
                    return `
                        <tr data-path="${encodedPath}" data-item-id="${itemId}" data-version="${item.version || ''}" data-language="${language}" data-site-approved="${siteApproved ? 'true' : 'false'}">
                            <td>${language}</td>
                            <td><code>${itemId}</code></td>
                            <td>${versionLabel}</td>
                            <td>${formatSize}</td>
                            <td>${updatedText || '—'}</td>
                            <td class="${approvalCellClass}" data-original-site-approved="${siteApproved ? 'true' : 'false'}">
                                <label class="draft-approve-toggle">
                                    <input type="checkbox" class="draft-approve" data-path="${encodedPath}" ${checkedAttr}>
                                    <span class="draft-approve-status${isApproved ? ' is-checked' : ''}">${statusLabel}</span>
                                </label>
                            </td>
                            <td>
                                <button class="btn btn-secondary btn-compact draft-play" data-path="${encodedPath}">
                                    <i class="fas fa-play"></i> Play
                                </button>
                            </td>
                        </tr>
                    `;
                }).join('');

                return `
                    ${summary}
                    <div class="draft-audio-table-wrapper">
                        <table class="draft-audio-table">
                            <thead>
                                <tr>
                                    <th>Language</th>
                                    <th>Item ID</th>
                                    <th>Version</th>
                                    <th>Size</th>
                                    <th>Updated</th>
                                    <th>Approved by Site</th>
                                    <th>Preview</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rows}
                            </tbody>
                        </table>
                    </div>
                `;
            }

            attachDraftRowHandlers(modal, bucketName = 'levante-assets-draft') {
                if (!modal) return;
                const rows = modal.querySelectorAll('.draft-audio-table tbody tr');
                rows.forEach(row => {
                    row.addEventListener('click', (event) => {
                        // Avoid row selection when clicking the play button or checkbox
                        if (event.target.closest('.draft-play') || event.target.closest('.draft-approve')) return;
                        rows.forEach(r => r.classList.remove('selected'));
                        row.classList.add('selected');
                        const decodedPath = row.dataset.path ? decodeURIComponent(row.dataset.path) : '';
                        const folderPath = decodedPath ? (decodedPath.includes('/') ? decodedPath.substring(0, decodedPath.lastIndexOf('/')) : decodedPath) : '';
                        this.selectedDraftAudio = {
                            path: decodedPath,
                            folder: folderPath ? folderPath + '/' : '',
                            itemId: row.dataset.itemId,
                            version: row.dataset.version,
                            language: row.dataset.language,
                            bucketName
                        };
                        const versionLabel = row.dataset.version ? ` (v${String(row.dataset.version).padStart(3, '0')})` : '';
                        this.setStatus(`Selected draft ${row.dataset.itemId}${versionLabel} [${row.dataset.language}]`, 'info');
                    });
                });

                const playButtons = modal.querySelectorAll('.draft-play');
                playButtons.forEach(btn => {
                    btn.addEventListener('click', (event) => {
                        event.stopPropagation();
                        const encoded = btn.dataset.path;
                        const path = encoded ? decodeURIComponent(encoded) : '';
                        if (path) {
                            this.playDraftAudioSample(path, bucketName);
                        } else {
                            this.setStatus('Unable to determine draft audio path for preview', 'warning');
                        }
                    });
                });
            }

            bindDraftApprovalHandlers(modal) {
                if (!modal) return;
                const checkboxes = modal.querySelectorAll('input.draft-approve');
                checkboxes.forEach(checkbox => {
                    checkbox.addEventListener('click', (event) => {
                        event.stopPropagation();
                    });
                    checkbox.addEventListener('change', () => {
                        const encodedPath = checkbox.dataset.path || '';
                        const decodedPath = encodedPath ? decodeURIComponent(encodedPath) : '';
                        if (!decodedPath) return;
                        if (!this.approvedDrafts) {
                            this.approvedDrafts = new Set();
                        }

                        const row = checkbox.closest('tr');
                        const dataset = row && row.dataset ? row.dataset : {};
                        const cell = checkbox.closest('.draft-approve-cell');
                        const statusEl = cell ? cell.querySelector('.draft-approve-status') : null;
                        const originallyApproved = cell?.dataset.originalSiteApproved === 'true';
                        const itemId = dataset.itemId || decodedPath;
                        const language = dataset.language || '';
                        const versionRaw = dataset.version || '';

                        if (checkbox.checked) {
                            this.approvedDrafts.add(decodedPath);
                        } else {
                            this.approvedDrafts.delete(decodedPath);
                        }

                        const versionLabel = versionRaw ? ` (v${String(versionRaw).padStart(3, '0')})` : '';
                        const langLabel = language ? ` [${language}]` : '';
                        const state = checkbox.checked
                            ? (originallyApproved ? 'Confirmed site approval for' : 'Marked site approval for')
                            : 'Cleared site approval for';

                        if (cell) {
                            cell.classList.toggle('is-active', checkbox.checked);
                        }
                        if (statusEl) {
                            statusEl.textContent = checkbox.checked ? (originallyApproved ? 'Approved' : 'Selected') : 'Pending';
                            statusEl.classList.toggle('is-checked', checkbox.checked);
                        }

                        this.setStatus(`${state} ${itemId}${versionLabel}${langLabel}`, checkbox.checked ? 'success' : 'info');
                    });
                });
            }

            async playDraftAudioSample(path, bucketName = 'levante-assets-draft') {
                if (!path) {
                    this.setStatus('No audio path provided for preview', 'warning');
                    return;
                }
                try {
                    const params = new URLSearchParams({
                        bucket: bucketName,
                        path
                    });
                    this.setStatus(`Loading draft audio preview...`, 'loading');
                    const response = await fetch(`/api/get-draft-audio?${params.toString()}`);
                    if (!response.ok) {
                        const text = await response.text();
                        throw new Error(text || `HTTP ${response.status}`);
                    }
                    const blob = await response.blob();
                    const url = URL.createObjectURL(blob);
                    const audio = new Audio(url);
                    audio.addEventListener('ended', () => URL.revokeObjectURL(url));
                    audio.addEventListener('error', () => URL.revokeObjectURL(url));
                    await audio.play();
                    this.setStatus(`Playing draft audio preview (${path})`, 'success');
                } catch (error) {
                    console.error('Error playing draft audio preview', error);
                    this.setStatus(`❌ Could not preview draft audio: ${error.message}`, 'error');
                }
            }

            extractTextForItem(item, langCode) {
                if (!item) return '';
                const t = this.getTranslationTextForLanguage(item, langCode);
                return t || String(item.en || '').trim();
            }

            getRegenerationTextForItem(item, itemId, langCode) {
                const defaultText = this.extractTextForItem(item, langCode);
                const selectedItemId = String(this.selectedRow?.item_id || '').trim();
                const requestedItemId = String(itemId || '').trim();
                const textInput = document.getElementById('textInput');

                // If the currently selected row matches this item, allow the edited text box
                // to override the translation text for regeneration.
                if (textInput && selectedItemId && requestedItemId && selectedItemId === requestedItemId) {
                    const editedText = String(textInput.value || '').trim();
                    if (editedText) {
                        return { text: editedText, source: 'editor' };
                    }
                }

                return { text: defaultText, source: 'translation' };
            }

            shouldUseEditedTextForItem(itemId) {
                const selectedItemId = String(this.selectedRow?.item_id || '').trim();
                const requestedItemId = String(itemId || '').trim();
                if (!selectedItemId || !requestedItemId || selectedItemId !== requestedItemId) return false;
                const textInput = document.getElementById('textInput');
                return Boolean(textInput && String(textInput.value || '').trim());
            }

            updateEditedTextIndicators() {
                const indicators = document.querySelectorAll('.edited-text-indicator[data-item-id]');
                indicators.forEach((indicator) => {
                    const itemId = String(indicator.getAttribute('data-item-id') || '').trim();
                    if (!itemId) return;
                    const active = this.shouldUseEditedTextForItem(itemId);
                    indicator.style.display = active ? 'inline-flex' : 'none';
                });
            }

            async regenerateAudioForItem(itemId, langCode) {
                const item = this.data.find(entry => entry.item_id === itemId);
                if (!item) {
                    const message = `Item ${itemId} not found in current dataset`;
                    this.setStatus(`❌ ${message}`, 'error');
                    alert(message);
                    return;
                }

                const { text, source: textSource } = this.getRegenerationTextForItem(item, itemId, langCode);
                if (!text) {
                    const message = `No translation text available for ${itemId} (${langCode})`;
                    this.setStatus(`❌ ${message}`, 'error');
                    alert(message);
                    return;
                }

                const { service, voiceId, voiceName, source } = await this.resolveVoiceSelection(langCode, itemId, { allowMetadataFallback: true });
                if (!service || !voiceId) {
                    const message = 'Please select a voice before regenerating audio.';
                    this.setStatus(`⚠️ ${message}`, 'warning');
                    alert(message);
                    return;
                }

                try {
                    const originLabel = source === 'metadata' ? 'existing audio' : 'selection';
                    const textLabel = textSource === 'editor' ? 'edited text' : 'translation text';
                    this.setStatus(`Generating ${itemId} with ${service} (${originLabel}, ${textLabel})...`, 'loading');
                    const options = {
                        itemId,
                        langCode,
                        voiceName,
                        text,
                        itemLabel: item.labels || item.task || '',
                        source: 'regenerate'
                    };
                    if (service === 'PlayHT') {
                        await this.generatePlayHTAudio(text, voiceId, options);
                    } else {
                        await this.generateElevenLabsAudio(text, voiceId, options);
                    }
                } catch (error) {
                    console.error('Error regenerating audio', error);
                    this.setStatus(`❌ Error regenerating ${itemId}: ${error.message}`, 'error');
                    alert(`Failed to regenerate audio for ${itemId}: ${error.message}`);
                }
            }

            async saveGeneratedAudioDraft(itemId, langCode) {
                if (!this.latestGeneratedAudio) {
                    const message = 'No generated audio found. Please re-generate audio before saving.';
                    this.setStatus(`⚠️ ${message}`, 'warning');
                    alert(message);
                    return;
                }

                const canonicalLangCode = this.getCanonicalAudioLangCode(langCode);
                const latestCanonicalLangCode = this.getCanonicalAudioLangCode(this.latestGeneratedAudio.langCode);
                if (this.latestGeneratedAudio.itemId !== itemId || latestCanonicalLangCode !== canonicalLangCode) {
                    const message = 'The most recent generated audio does not match this item/language. Please re-generate before saving.';
                    this.setStatus(`⚠️ ${message}`, 'warning');
                    alert(message);
                    return;
                }

                const payload = {
                    audioBase64: this.latestGeneratedAudio.audioBase64,
                    langCode: canonicalLangCode,
                    itemId,
                    bucket: 'levante-assets-draft',
                    versioning: true,
                    tags: {
                        title: itemId,
                        artist: `Levante Framework - ${this.latestGeneratedAudio.service}`,
                        album: this.latestGeneratedAudio.itemLabel || canonicalLangCode,
                        genre: 'Speech Synthesis',
                        comment: `Levante Project - ${this.latestGeneratedAudio.service} - ${this.latestGeneratedAudio.voiceName || this.latestGeneratedAudio.voiceId} - ${canonicalLangCode}`,
                        service: this.latestGeneratedAudio.service,
                        voice: this.latestGeneratedAudio.voiceName || this.latestGeneratedAudio.voiceId,
                        lang_code: canonicalLangCode,
                        text: this.latestGeneratedAudio.text || '',
                        original_translation_text: this.latestGeneratedAudio.originalTranslationText || '',
                        audio_enhanced_text: this.latestGeneratedAudio.audioEnhancedText || '',
                        used_audio_enhanced_text: this.latestGeneratedAudio.usedAudioEnhancedText ? 'true' : 'false',
                        created: this.latestGeneratedAudio.generatedAt,
                        copyright: this.audioCopyright,
                        source: 'patch'
                    }
                };

                try {
                    this.setStatus(`Uploading ${itemId} to draft bucket...`, 'loading');
                    const response = await fetch('/api/save-audio', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    const result = await response.json();
                    if (!response.ok || !result.success) {
                        const message = result?.message || 'Unknown upload error';
                        throw new Error(message);
                    }
                    const versionSuffix = result.version ? ` (v${String(result.version).padStart(3, '0')})` : '';
                    this.setStatus(`Saved ${itemId}${versionSuffix} to ${result.bucket}/${result.path}`, 'success');
                    alert(`Audio saved to ${result.bucket}/${result.path}`);
                    this.pendingSaveKey = null;
                    this.latestGeneratedAudio = null;
                    this.updateSaveButtonState(itemId, canonicalLangCode);
                } catch (error) {
                    console.error('Error saving generated audio', error);
                    this.setStatus(`❌ Error saving audio: ${error.message}`, 'error');
                    alert(`Failed to save audio: ${error.message}`);
                }
            }

            async recordGeneratedAudio(audioBlob, metadata) {
                if (!audioBlob) return;
                try {
                    const audioBase64 = await this.convertBlobToBase64(audioBlob);
                    this.latestGeneratedAudio = {
                        audioBlob,
                        audioBase64,
                        service: metadata.service,
                        voiceId: metadata.voiceId,
                        voiceName: metadata.voiceName || metadata.voiceId,
                        langCode: metadata.langCode || (this.languages[this.currentLanguage]?.lang_code || ''),
                        itemId: metadata.itemId || null,
                        itemLabel: metadata.itemLabel || '',
                        text: metadata.text || '',
                        source: metadata.source || 'unknown',
                        generatedAt: new Date().toISOString()
                    };

                    if (this.latestGeneratedAudio.itemId && this.latestGeneratedAudio.langCode) {
                        const canonicalLangCode = this.getCanonicalAudioLangCode(this.latestGeneratedAudio.langCode);
                        const cacheKey = `${canonicalLangCode}::${this.latestGeneratedAudio.itemId}`;
                        if (!this.audioMetadataCache) {
                            this.audioMetadataCache = new Map();
                        }
                        this.audioMetadataCache.set(cacheKey, {
                            id3Tags: {
                                service: this.latestGeneratedAudio.service,
                                voice: this.latestGeneratedAudio.voiceName,
                                text: this.latestGeneratedAudio.text,
                                created: this.latestGeneratedAudio.generatedAt
                            }
                        });
                        this.pendingSaveKey = cacheKey;
                        this.updateSaveButtonState(this.latestGeneratedAudio.itemId, canonicalLangCode);
                    }
                } catch (error) {
                    console.error('Failed to cache generated audio', error);
                    this.latestGeneratedAudio = null;
                    this.pendingSaveKey = null;
                }
            }

            convertBlobToBase64(blob) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = () => reject(new Error('Failed to convert audio to base64'));
                    reader.readAsDataURL(blob);
                });
            }

            getElevenLabsSettingValue(selectId, fallback) {
                const el = document.getElementById(selectId);
                const value = el ? Number.parseFloat(String(el.value || '')) : NaN;
                return Number.isFinite(value) ? value : fallback;
            }

            syncElevenLabsSettingsFromUi() {
                this.elevenLabsStability = this.getElevenLabsSettingValue('elevenlabsStabilitySelect', 0.65);
                this.elevenLabsStyle = this.getElevenLabsSettingValue('elevenlabsStyleSelect', 0.0);

                const stabilityEl = document.getElementById('elevenlabsStabilitySelect');
                if (stabilityEl && !stabilityEl.dataset.bound) {
                    stabilityEl.addEventListener('change', () => this.syncElevenLabsSettingsFromUi());
                    stabilityEl.dataset.bound = 'true';
                }

                const styleEl = document.getElementById('elevenlabsStyleSelect');
                if (styleEl && !styleEl.dataset.bound) {
                    styleEl.addEventListener('change', () => this.syncElevenLabsSettingsFromUi());
                    styleEl.dataset.bound = 'true';
                }
            }

            async generateAudioFromText() {
                const textInput = document.getElementById('textInput');
                const text = textInput.value.trim();
                
                if (!text) {
                    alert('Please enter some text to generate audio.');
                    return;
                }
                
                const langCode = this.getCurrentLanguageCode();
                if (!langCode) {
                    this.setStatus('Current language is missing a language code. Please check language settings.', 'warning');
                    return;
                }
                const { service: selectedService, voiceId: selectedVoice, voiceName } = await this.resolveVoiceSelection(langCode, null, { allowMetadataFallback: false });
                
                if (!selectedService || !selectedVoice) {
                    alert('Please select a voice from either PlayHT or ElevenLabs to generate audio.');
                    this.setStatus('⚠️ Select a voice before generating audio', 'warning');
                    return;
                }
                
                this.setStatus(`Generating audio with ${selectedService}...`, 'loading');
                
                try {
                    const options = {
                        langCode,
                        voiceName,
                        text,
                        source: 'text-input'
                    };
                    if (selectedService === 'PlayHT') {
                        await this.generatePlayHTAudio(text, selectedVoice, options);
                    } else if (selectedService === 'ElevenLabs') {
                        await this.generateElevenLabsAudio(text, selectedVoice, options);
                    }
                } catch (error) {
                    console.error('Audio generation error:', error);
                    this.setStatus(`Error generating audio: ${error.message}`, 'error');
                    alert(`Failed to generate audio: ${error.message}`);
                }
            }
            
            async generatePlayHTAudio(text, voiceId, options = {}) {
                const credentials = getCredentials();
                const playhtKey = credentials.playht_api_key || credentials.playhtApiKey;
                const playhtUser = credentials.playht_user_id || credentials.playhtUserId;
                if (!playhtKey || !playhtUser) {
                    throw new Error('PlayHT credentials not found. Please add them in the credentials manager.');
                }
                
                const requestData = {
                    text: text,
                    voice: voiceId,
                    quality: 'medium',
                    output_format: 'mp3',
                    speed: 1,
                    sample_rate: 24000
                };
                
                console.log('Calling PlayHT API with:', requestData);
                
                const response = await fetch('/api/playht-proxy', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'AUTHORIZATION': playhtKey,
                        'X-USER-ID': playhtUser
                    },
                    body: JSON.stringify(requestData)
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`PlayHT API error: ${response.status} - ${errorText}`);
                }
                
                // Get the audio blob
                const audioBlob = await response.blob();
                await this.recordGeneratedAudio(audioBlob, {
                    service: 'PlayHT',
                    voiceId,
                    voiceName: options.voiceName,
                    langCode: options.langCode,
                    itemId: options.itemId,
                    itemLabel: options.itemLabel,
                    text,
                    source: options.source
                });
                const audioUrl = URL.createObjectURL(audioBlob);
                
                this.setStatus('Audio generated successfully! Playing now...', 'success');
                
                // Play the generated audio
                const audio = new Audio(audioUrl);
                audio.addEventListener('canplaythrough', () => {
                    audio.play();
                    this.setStatus('Playing generated audio...', 'success');
                });
                audio.addEventListener('ended', () => {
                    this.setStatus('Audio playback completed.', 'success');
                    // Clean up the blob URL
                    URL.revokeObjectURL(audioUrl);
                });
                audio.addEventListener('error', (e) => {
                    console.error('Audio playback error:', e);
                    this.setStatus('Error playing generated audio.', 'error');
                    URL.revokeObjectURL(audioUrl);
                });
            }
            
            async generateElevenLabsAudio(text, voiceId, options = {}) {
                const credentials = getCredentials();
                const elevenKey = credentials.elevenlabs_api_key || credentials.elevenlabsApiKey;
                if (!elevenKey) {
                    throw new Error('ElevenLabs API key not found. Please add it in the credentials manager.');
                }
                
                const requestData = {
                    text: text,
                    model_id: "eleven_multilingual_v3",
                    output_format: "mp3_22050_32",
                    voice_settings: {
                        stability: this.elevenLabsStability,
                        style: this.elevenLabsStyle
                    }
                };
                
                console.log('Calling ElevenLabs API with:', requestData);
                
                const response = await fetch(`/api/elevenlabs-proxy?voice_id=${voiceId}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-KEY': elevenKey
                    },
                    body: JSON.stringify(requestData)
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
                }
                
                // Get the audio blob
                const audioBlob = await response.blob();
                await this.recordGeneratedAudio(audioBlob, {
                    service: 'ElevenLabs',
                    voiceId,
                    voiceName: options.voiceName,
                    langCode: options.langCode,
                    itemId: options.itemId,
                    itemLabel: options.itemLabel,
                    text,
                    source: options.source
                });
                const audioUrl = URL.createObjectURL(audioBlob);
                
                this.setStatus('Audio generated successfully! Playing now...', 'success');
                
                // Play the generated audio
                const audio = new Audio(audioUrl);
                audio.addEventListener('canplaythrough', () => {
                    audio.play();
                    this.setStatus('Playing generated audio...', 'success');
                });
                audio.addEventListener('ended', () => {
                    this.setStatus('Audio playback completed.', 'success');
                    // Clean up the blob URL
                    URL.revokeObjectURL(audioUrl);
                });
                audio.addEventListener('error', (e) => {
                    console.error('Audio playback error:', e);
                    this.setStatus('Error playing generated audio.', 'error');
                    URL.revokeObjectURL(audioUrl);
                });
            }
            
            populateSelectedText() {
                if (!this.selectedRow) {
                    alert('Please select an item from the table first.');
                    return;
                }
                
                const langCode = this.getCurrentLanguageCode();
                if (!langCode) {
                    this.setStatus('Current language is missing a language code. Please check language settings.', 'warning');
                    return;
                }
                const text = this.selectedRow[langCode] || this.selectedRow.en || 'No translation available';
                
                document.getElementById('textInput').value = text;
                this.setStatus(`Text populated from selected item: ${this.selectedRow.item_id}`, 'success');
                this.updateEditedTextIndicators();
            }

            setStatus(message, type = 'success') {
                const statusBar = document.getElementById('statusBar');
                const statusIcon = statusBar.querySelector('.status-icon');
                const statusContent = statusBar.querySelector('span');
                
                // Update icon based on type
                statusIcon.className = `fas fa-circle status-icon ${type}`;
                
                if (statusContent) {
                    statusContent.textContent = message;
                }
            }

            showButtonFeedback(button, text, variant = 'success', iconClass = 'fa-check', duration = 2000) {
                if (!button) return;
                const originalHtml = button.dataset.originalHtml || button.innerHTML;
                if (!button.dataset.originalHtml) {
                    button.dataset.originalHtml = originalHtml;
                }

                const timeoutIdRaw = (button.dataset.feedbackTimeout && button.dataset.feedbackTimeout !== '')
                    ? Number(button.dataset.feedbackTimeout)
                    : null;
                if (timeoutIdRaw !== null && !Number.isNaN(timeoutIdRaw)) {
                    clearTimeout(timeoutIdRaw);
                }

                button.classList.remove('btn-feedback-success', 'btn-feedback-error', 'btn-feedback-warning');
                if (variant) {
                    button.classList.add(`btn-feedback-${variant}`);
                }

                const iconHtml = iconClass ? `<i class="fas ${iconClass}"></i> ` : '';
                button.innerHTML = `${iconHtml}${text}`;

                const timeoutId = window.setTimeout(() => {
                    button.innerHTML = button.dataset.originalHtml || originalHtml;
                    button.classList.remove('btn-feedback-success', 'btn-feedback-error', 'btn-feedback-warning');
                    delete button.dataset.feedbackTimeout;
                }, duration);

                button.dataset.feedbackTimeout = String(timeoutId);
            }

            updateSaveButtonState(itemId, langCode) {
                if (!itemId || !langCode) return;
                const pendingKey = this.pendingSaveKey;
                const canonicalLangCode = this.getCanonicalAudioLangCode(langCode);
                const targetKey = `${canonicalLangCode}::${itemId}`;
                const shouldEnable = Boolean(
                    pendingKey &&
                    pendingKey === targetKey &&
                    this.latestGeneratedAudio &&
                    this.latestGeneratedAudio.itemId === itemId &&
                    this.getCanonicalAudioLangCode(this.latestGeneratedAudio.langCode) === canonicalLangCode
                );

                const buttons = Array.from(document.querySelectorAll('.save-btn[data-item-id][data-lang-code]'));
                buttons.forEach((btn) => {
                    if (btn.dataset.itemId === itemId && btn.dataset.langCode === langCode) {
                        btn.disabled = !shouldEnable;
                        btn.title = shouldEnable
                            ? 'Save latest generated audio to draft bucket'
                            : 'Generate audio before saving';
                    }
                });
            }
        }

        // All other functions moved to modular JS files:
        // - js/utils.js (getCredentials, formatFileSize, etc.)
        // - js/credentials.js (modal functions)
        // - js/validation.js (validateSingle, validateAll, etc.)
        // - js/audio.js (playAudio, showAudioInfo, etc.)
        // - js/language-config.js (Vue config modal)
        // - js/bootstrap.js (initialization)

        async function copyItemIdToClipboard(itemId, buttonEl, event) {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
            try {
                if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard API unavailable');
                await navigator.clipboard.writeText(String(itemId || ''));
                if (window.dashboard && typeof window.dashboard.showButtonFeedback === 'function') {
                    window.dashboard.showButtonFeedback(buttonEl, 'Copied', 'success', 'fa-check', 1000);
                }
            } catch (error) {
                console.warn('Copy item id failed:', error);
                if (window.dashboard && typeof window.dashboard.showButtonFeedback === 'function') {
                    window.dashboard.showButtonFeedback(buttonEl, 'Failed', 'warning', 'fa-triangle-exclamation', 1200);
                }
            }
        }
        window.copyItemIdToClipboard = copyItemIdToClipboard;

        // Make Dashboard class available globally for bootstrap
        window.Dashboard = Dashboard;
