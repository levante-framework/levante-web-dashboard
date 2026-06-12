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

function getBackTranslationProvider() {
    const configured = String(window.CONFIG?.validationBacktranslationProvider || '').trim().toLowerCase();
    let override = '';
    try {
        override = String(window.localStorage?.getItem('validationBacktranslationProvider') || '').trim().toLowerCase();
    } catch (_) {
        override = '';
    }
    const chosen = override || configured || 'google';
    return chosen === 'hf' ? 'hf' : 'google';
}

async function runBackTranslationProvider({ text, fromLang, toLang, userKey }) {
    const provider = getBackTranslationProvider();
    if (provider === 'google') {
        const headers = {};
        if (userKey) headers['Authorization'] = `Bearer ${userKey}`;
        const response = await fetch(`/api/google-translate?text=${encodeURIComponent(text)}&from=${encodeURIComponent(fromLang)}&to=${encodeURIComponent(toLang)}`, {
            method: 'GET',
            headers
        });
        if (!response.ok) {
            let errorDetails = `Translation API error: ${response.status}`;
            try {
                const errorData = await response.json();
                errorDetails += ` - ${errorData.details || errorData.error || 'Unknown error'}`;
            } catch (_) {}
            throw new Error(errorDetails);
        }
        const data = await response.json();
        return { translatedText: String(data?.translatedText || ''), provider: 'google' };
    }

    const headers = { 'Content-Type': 'application/json' };
    if (userKey) headers['Authorization'] = `Bearer ${userKey}`;
    const response = await fetch('/api/back-translate', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            provider,
            text,
            fromLang,
            toLang
        })
    });
    if (!response.ok) {
        let errorDetails = `Back-translation API error: ${response.status}`;
        try {
            const errorData = await response.json();
            errorDetails += ` - ${errorData.details || errorData.error || 'Unknown error'}`;
        } catch (_) {}
        throw new Error(errorDetails);
    }
    const data = await response.json();
    return { translatedText: String(data?.translatedText || ''), provider: provider };
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
    // Product decision: always run AI adjudication for all rows.
    return 'all';
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

const VALIDATION_SCORING_VERSION = 'composite-v3-name-token-aware';
const VALIDATION_PASS_THRESHOLD = 90;
const VALIDATION_REVIEW_THRESHOLD = 80;

function tokenizeValidationWords(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s'-]/gi, ' ')
        .split(/\s+/)
        .map(w => w.trim())
        .filter(Boolean);
}

const NAME_MASK_STOPWORDS = new Set([
    'The', 'A', 'An', 'This', 'That', 'These', 'Those',
    'Please', 'Select', 'Choose', 'Click', 'Tap', 'Press', 'Enter',
    'Continue', 'Next', 'Back', 'Submit', 'Save', 'Cancel', 'Allow', 'Deny',
    'Open', 'Close', 'Yes', 'No', 'True', 'False',
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    'January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'
]);

// Lightweight bilingual given-name hints to catch cases like Bobby -> Roberto
// even when the token appears at sentence start.
const NAME_MASK_GIVEN_NAMES = new Set([
    'Aaron', 'Abigail', 'Adrian', 'Agustin', 'Aitana', 'Alberto', 'Alejandro', 'Alejandra',
    'Alicia', 'Alma', 'Andres', 'Ana', 'Angel', 'Angela', 'Antonio', 'Ariana', 'Beatriz',
    'Benjamin', 'Bianca', 'Bobbie', 'Bobby', 'Bruno', 'Camila', 'Carlos', 'Carla', 'Carmen', 'Carolina',
    'Catalina', 'Cecilia', 'Charlotte', 'Clara', 'Claudia', 'Daniel', 'Daniela', 'David',
    'Diego', 'Dylan', 'Eduardo', 'Elena', 'Elias', 'Elian', 'Elisa', 'Emily', 'Emma', 'Enzo',
    'Eric', 'Erika', 'Esteban', 'Ethan', 'Eva', 'Felipe', 'Florencia', 'Francisco', 'Gabriel',
    'Gabriela', 'Genaro', 'Gonzalo', 'Graciela', 'Guadalupe', 'Hector', 'Hugo', 'Ignacio',
    'Ines', 'Isabel', 'Isabella', 'Ivan', 'Joaquin', 'Jorge', 'Jose', 'Josefina', 'Juan',
    'Juana', 'Julia', 'Julian', 'Julieta', 'Lautaro', 'Leo', 'Leon', 'Leonel', 'Leticia',
    'Lia', 'Liam', 'Lola', 'Lucia', 'Lucas', 'Luisa', 'Manuel', 'Manuela', 'Marco', 'Marcos',
    'Maria', 'Mariana', 'Mateo', 'Matias', 'Melina', 'Mia', 'Miguel', 'Nadia', 'Natalia',
    'Nicolas', 'Noah', 'Olivia', 'Pablo', 'Paula', 'Pedro', 'Rafael', 'Renata', 'Ricardo',
    'Robert', 'Roberto', 'Rodrigo', 'Rosa', 'Sabrina', 'Samuel', 'Sara', 'Sebastian', 'Sofia', 'Sofía',
    'Santiago', 'Tomas', 'Tomás', 'Valentina', 'Valeria', 'Victoria', 'Ximena'
].map((name) => name.toLowerCase()));

function escapeRegexToken(token) {
    return String(token || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectNameLikeTokens(text) {
    const candidateRegex = /\b[A-Z][a-z]{2,}(?:['’.-][A-Za-z]+)?\b/g;
    const raw = String(text || '');
    const matches = Array.from(raw.matchAll(candidateRegex));
    const out = [];
    matches.forEach((match) => {
        const token = String(match[0] || '');
        if (!token || NAME_MASK_STOPWORDS.has(token)) return;
        const lower = token.toLowerCase();
        const start = Number(match.index || 0);
        const prefix = raw.slice(0, start);
        const prevNonSpaceMatch = prefix.match(/\S(?=\s*$)/);
        const prevNonSpace = prevNonSpaceMatch ? prevNonSpaceMatch[0] : '';
        const isSentenceInitial = !prevNonSpace || /[.!?]/.test(prevNonSpace);
        // Keep sentence-initial token only when it looks like an actual given name.
        if (isSentenceInitial && !NAME_MASK_GIVEN_NAMES.has(lower)) return;
        if (!out.includes(token)) out.push(token);
    });
    return out;
}

function isStoriesTaskContext({ itemId = '', taskName = '' } = {}) {
    const id = String(itemId || '').toLowerCase();
    const task = String(taskName || '').toLowerCase();
    return id.includes('stories.xliff') || task.includes('stories');
}

function collectStorySourceGivenNames(text) {
    const raw = String(text || '');
    if (!raw) return [];
    return collectNameLikeTokens(raw).filter((token) => NAME_MASK_GIVEN_NAMES.has(String(token || '').toLowerCase()));
}

function collectBackTranslationNameCandidates(text) {
    const raw = String(text || '');
    if (!raw) return [];
    return collectNameLikeTokens(raw).filter((token) => NAME_MASK_GIVEN_NAMES.has(String(token || '').toLowerCase()));
}

function normalizeNameTokenForMatch(token) {
    return String(token || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function applyStoryNamePlaceholderMask(originalText, backTranslation, context = {}) {
    const src = String(originalText || '');
    const bt = String(backTranslation || '');
    if (!src || !bt) {
        return { originalMasked: src, backMasked: bt, applied: false, tokenCount: 0 };
    }
    if (!isStoriesTaskContext(context)) {
        return { originalMasked: src, backMasked: bt, applied: false, tokenCount: 0 };
    }

    // Source-anchored masking: detect names in English source only, then align back-translation
    // names to placeholders so localized variants (Bobby -> Roberto -> Robert) do not penalize score.
    const srcNames = collectStorySourceGivenNames(src);
    if (!srcNames.length) {
        return { originalMasked: src, backMasked: bt, applied: false, tokenCount: 0 };
    }

    const btNameCandidates = collectBackTranslationNameCandidates(bt);
    if (!btNameCandidates.length) {
        return { originalMasked: src, backMasked: bt, applied: false, tokenCount: 0 };
    }

    let originalMasked = src;
    let backMasked = bt;
    const uniqueSourceNames = Array.from(new Set(srcNames));
    const uniqueBtNames = Array.from(new Set(btNameCandidates));
    if (uniqueBtNames.length < uniqueSourceNames.length) {
        // Avoid partial/ambiguous alignment (e.g., two source names but one back-translation name).
        return { originalMasked: src, backMasked: bt, applied: false, tokenCount: 0 };
    }
    const consumedBtNames = new Set();
    const maxNames = Math.min(uniqueSourceNames.length, 6);

    for (let i = 0; i < maxNames; i++) {
        const sourceName = uniqueSourceNames[i];
        const placeholder = `__NAME${i + 1}__`;
        const sourcePattern = new RegExp(`\\b${escapeRegexToken(sourceName)}\\b`, 'g');
        originalMasked = originalMasked.replace(sourcePattern, placeholder);

        // Prefer direct same-token match in back-translation; otherwise align by order of detected names.
        const sourceNorm = normalizeNameTokenForMatch(sourceName);
        const directBtToken = uniqueBtNames.find((token) => normalizeNameTokenForMatch(token) === sourceNorm && !consumedBtNames.has(token));
        const alignedBtToken = directBtToken || uniqueBtNames.find((token) => !consumedBtNames.has(token));
        if (alignedBtToken) {
            const btPattern = new RegExp(`\\b${escapeRegexToken(alignedBtToken)}\\b`, 'g');
            backMasked = backMasked.replace(btPattern, placeholder);
            consumedBtNames.add(alignedBtToken);
        }
    }

    const applied = originalMasked !== src && backMasked !== bt;
    const tokenCount = applied ? Math.min(uniqueSourceNames.length, 6) : 0;
    return { originalMasked, backMasked, applied, tokenCount };
}

function applyEntityMaskingForLexical(originalText, backTranslation, itemType, context = {}) {
    return applyStoryNamePlaceholderMask(originalText, backTranslation, context);
}

function levenshteinDistance(a, b) {
    const s = String(a || '');
    const t = String(b || '');
    const m = s.length;
    const n = t.length;
    if (!m) return n;
    if (!n) return m;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = s[i - 1] === t[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }
    return dp[m][n];
}

function computeLexicalScore(originalText, backTranslation) {
    const src = String(originalText || '').trim().toLowerCase();
    const bt = String(backTranslation || '').trim().toLowerCase();
    if (!src || !bt) return 0;
    if (src === bt) return 100;
    const distance = levenshteinDistance(src, bt);
    const maxLen = Math.max(src.length, bt.length, 1);
    const score = 100 * (1 - (distance / maxLen));
    return Math.max(0, Math.min(100, Math.round(score * 100) / 100));
}

function computeLegacyOverlapScore(originalText, backTranslation) {
    const originalWords = tokenizeValidationWords(originalText);
    const backWords = tokenizeValidationWords(backTranslation);
    if (!originalWords.length || !backWords.length) return 0;
    const backSet = new Set(backWords);
    const common = originalWords.filter(word => backSet.has(word)).length;
    const similarity = common / Math.max(originalWords.length, backWords.length);
    return Math.round((similarity * 100) * 100) / 100;
}

function isVocabLikePair(originalText, translatedText) {
    const originalWords = tokenizeValidationWords(originalText);
    const translatedWords = tokenizeValidationWords(translatedText);
    const sourceChars = String(originalText || '').trim().length;
    const targetChars = String(translatedText || '').trim().length;
    return originalWords.length <= 3
        && translatedWords.length <= 3
        && sourceChars <= 40
        && targetChars <= 60;
}

function inferAiJudgeItemType({ itemId, originalText, translatedText, taskName }) {
    const id = String(itemId || '').toLowerCase();
    const task = String(taskName || '').toLowerCase();
    const src = String(originalText || '').trim();
    const srcLower = src.toLowerCase();

    if (
        isVocabLikePair(originalText, translatedText)
        || id.startsWith('vocab-')
        || task.includes('vocab')
        || task.includes('vocabulary')
    ) {
        return 'vocab';
    }

    if (
        id.includes('instruction')
        || task.includes('instruction')
        || task.includes('ui')
        || /^(select|choose|click|tap|press|enter|continue|next|back|submit|save|cancel|allow|deny|open|close)\b/i.test(srcLower)
    ) {
        return 'instruction_ui';
    }

    const sourceTokens = String(src || '').split(/\s+/).filter(Boolean);
    const looksTitleCaseShort =
        sourceTokens.length > 0
        && sourceTokens.length <= 4
        && sourceTokens.every((t) => /^[A-Z][A-Za-z0-9'’.-]*$/.test(t));
    if (
        id.includes('brand')
        || id.includes('name')
        || task.includes('brand')
        || task.includes('name')
        || looksTitleCaseShort
    ) {
        return 'proper_noun';
    }

    return 'survey_sentence';
}

function computeCompositeScore(semanticScore, lexicalScore, isVocabLike, nameMaskApplied = false) {
    const sem = Number.isFinite(Number(semanticScore)) ? Number(semanticScore) : 0;
    const lex = Number.isFinite(Number(lexicalScore)) ? Number(lexicalScore) : 0;
    const weighted = isVocabLike
        ? (0.35 * sem + 0.65 * lex)
        : (nameMaskApplied
            ? (0.95 * sem + 0.05 * lex)
            : (0.80 * sem + 0.20 * lex));
    return Math.max(0, Math.min(100, Math.round(weighted * 100) / 100));
}

async function runSemanticScorer({ originalText, backTranslation, langCode }) {
    try {
        const resp = await fetch('/api/translation-semantic-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ originalText, backTranslation, langCode })
        });
        if (!resp.ok) return { used: false, score: null, modelUsed: '' };
        const data = await resp.json();
        if (!data || data.ok !== true || !Number.isFinite(Number(data.semantic_score))) {
            return { used: false, score: null, modelUsed: data?.modelUsed || '' };
        }
        const score = Math.max(0, Math.min(100, Math.round(Number(data.semantic_score) * 100) / 100));
        return { used: true, score, modelUsed: String(data.modelUsed || '').trim() };
    } catch (_) {
        return { used: false, score: null, modelUsed: '' };
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

async function runAiJudge({ originalText, translatedText, backTranslation, langCode, baseScore, itemType = 'survey_sentence', nameMaskApplied = false }) {
    const mode = getAiJudgeMode();
    // Hybrid mode runs AI judge only for borderline scores.
    const normalizedItemType = String(itemType || 'survey_sentence').toLowerCase();
    const isNameSensitive = nameMaskApplied || normalizedItemType === 'proper_noun';
    if (
        mode !== 'all'
        && !isNameSensitive
        && (typeof baseScore !== 'number' || baseScore < VALIDATION_REVIEW_THRESHOLD || baseScore > VALIDATION_PASS_THRESHOLD)
    ) {
        return { used: false, modelUsed: null, adequacy: null, fluency: null, issues: '' };
    }
    try {
        const resp = await fetch('/api/translation-ai-judge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ originalText, translatedText, backTranslation, langCode, itemType })
        });
        if (!resp.ok) return { used: false, modelUsed: null, adequacy: null, fluency: null, issues: '' };
        const data = await resp.json();
        if (!data || data.ok !== true || typeof data.ai_score !== 'number') {
            // Keep noisy warnings out of UI, but log useful reasons once we get data.
            if (data && data.reason) console.warn('AI judge skipped:', data.reason);
            return { used: false, modelUsed: data?.modelUsed || null, adequacy: null, fluency: null, issues: '' };
        }
        const aiScore = Math.round(Number(data.ai_score) * 100) / 100;
        const adequacy = Number.isFinite(Number(data?.adequacy)) ? Math.max(0, Math.min(1, Number(data.adequacy))) : null;
        const fluency = Number.isFinite(Number(data?.fluency)) ? Math.max(0, Math.min(1, Number(data.fluency))) : null;
        const issues = String(data?.issues || data?.notes || '').trim();
        // In AI-only mode, use direct AI score (no baseline blending).
        if (mode === 'all') {
            return { used: true, aiScore, finalScore: aiScore, aiNotes: data.notes || '', modelUsed: data.modelUsed || null, adequacy, fluency, issues };
        }
        // Hybrid mode blends baseline + AI score for continuity.
        const blended = isNameSensitive
            ? Math.round((0.35 * baseScore + 0.65 * aiScore) * 100) / 100
            : Math.round((0.6 * baseScore + 0.4 * aiScore) * 100) / 100;
        return { used: true, aiScore, finalScore: blended, aiNotes: data.notes || '', modelUsed: data.modelUsed || null, adequacy, fluency, issues };
    } catch (_) {
        return { used: false, modelUsed: null, adequacy: null, fluency: null, issues: '' };
    }
}

function inferScoreSource(result) {
    if (!result) return '';
    if (result.manualApproved || String(result.scoreSource || '').toLowerCase() === 'manual') return 'manual';
    if (String(result.scoreSource || '').toLowerCase() === 'ai' || result.aiUsed || Number.isFinite(Number(result.aiScore))) return 'ai';
    if (typeof result.score === 'number') return 'calculated';
    return '';
}

function isManualApprovedResult(result) {
    if (!result || typeof result !== 'object') return false;
    if (result.requiresRevalidation === true) return false;
    if (result.manualApproved === true) return true;
    if (String(result.scoreSource || '').trim().toLowerCase() === 'manual') return true;
    if (String(result.notes || '').trim().toLowerCase() === 'manually approved') return true;
    return false;
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
        const rawModelName = String(aiModel || '').trim();
        const modelName = rawModelName.toLowerCase() === 'gpt-4.1' ? '' : rawModelName;
        badge.textContent = modelName ? `AI ${modelName}` : 'AI';
        badge.title = modelName ? `AI-refined score via ${modelName}` : 'AI-refined score';
        badge.style.color = '#0d47a1';
        badge.style.background = '#e3f2fd';
        badge.style.border = '1px solid #90caf9';
    } else {
        badge.textContent = 'Calculated';
        badge.title = 'Calculated from semantic + lexical back-translation scoring';
        badge.style.color = '#1b5e20';
        badge.style.background = '#e8f5e9';
        badge.style.border = '1px solid #a5d6a7';
    }
}

function buildScoreTooltip(result, scorePercent) {
    const finalScore = Number.isFinite(Number(scorePercent)) ? Number(scorePercent) : null;
    const compositeScore = Number.isFinite(Number(result?.compositeScore))
        ? Number(result.compositeScore)
        : (Number.isFinite(Number(result?.baselineScore)) ? Number(result.baselineScore) : null);
    const semanticScore = Number.isFinite(Number(result?.semanticScore)) ? Number(result.semanticScore) : null;
    const semanticScoreRaw = Number.isFinite(Number(result?.semanticScoreRaw)) ? Number(result.semanticScoreRaw) : null;
    const semanticScoreMasked = Number.isFinite(Number(result?.semanticScoreMasked)) ? Number(result.semanticScoreMasked) : null;
    const lexicalScore = Number.isFinite(Number(result?.lexicalScore)) ? Number(result.lexicalScore) : null;
    const aiScore = Number.isFinite(Number(result?.aiScore)) ? Number(result.aiScore) : null;
    const scoreSource = inferScoreSource(result) || 'unknown';
    const status = finalScore == null ? 'PENDING' : (finalScore >= 85 ? 'PASS' : finalScore >= 70 ? 'REVIEW' : 'FAIL');
    const parts = [
        finalScore == null ? 'Final score: n/a' : `Final score: ${finalScore.toFixed(2)}%`,
        `Status: ${status}`,
        `Source: ${scoreSource}`
    ];
    if (compositeScore != null) parts.push(`Composite: ${compositeScore.toFixed(2)}%`);
    if (semanticScore != null) parts.push(`Semantic: ${semanticScore.toFixed(2)}%`);
    if (semanticScoreRaw != null) parts.push(`Semantic raw: ${semanticScoreRaw.toFixed(2)}%`);
    if (semanticScoreMasked != null) parts.push(`Semantic entity-masked: ${semanticScoreMasked.toFixed(2)}%`);
    if (lexicalScore != null) parts.push(`Lexical: ${lexicalScore.toFixed(2)}%`);
    if (aiScore != null) {
        const aiModel = String(result?.aiModel || '').trim();
        parts.push(`AI score: ${aiScore.toFixed(2)}%${aiModel ? ` via ${aiModel}` : ''}`);
    }
    if (Number.isFinite(Number(result?.aiAdequacy))) parts.push(`AI adequacy: ${Number(result.aiAdequacy).toFixed(2)}`);
    if (Number.isFinite(Number(result?.aiFluency))) parts.push(`AI fluency: ${Number(result.aiFluency).toFixed(2)}`);
    if (result?.aiIssues) parts.push(`AI issues: ${String(result.aiIssues).trim()}`);
    if (result?.scoringVersion) parts.push(`Scoring version: ${result.scoringVersion}`);
    return parts.join(' | ');
}

function findCurrentTableRowByItemId(itemId) {
    const currentLanguage = window.dashboard?.currentLanguage;
    const table = document.getElementById(`table-${currentLanguage}`);
    if (!table) return null;
    const rows = Array.from(table.querySelectorAll('.data-row'));
    return rows.find(r => String(r.dataset.itemId || '') === String(itemId)) || null;
}

function upsertBackTranslationInRow(row, backTranslation) {
    if (!row) return;
    const englishCell = row.querySelector('.item-english');
    if (!englishCell) return;
    let backEl = englishCell.querySelector('.item-backtranslation');
    const text = String(backTranslation || '').trim();
    const isSourcePlaceholder = text.toLowerCase().startsWith('n/a');
    const displayText = isSourcePlaceholder
        ? 'Back-translation unavailable for source language'
        : (text || 'Back-translation unavailable');
    if (!backEl) {
        backEl = document.createElement('div');
        backEl.className = 'item-backtranslation';
        backEl.title = 'Back-translation';
        englishCell.appendChild(backEl);
    }
    backEl.textContent = displayText;
}

function syncApprovedRowUi(row, approved) {
    if (!row) return;
    const reviewContainer = row.querySelector('.needs-review-container');
    const needsReviewLabel = row.querySelector('.needs-review-toggle-label');
    const reasonContainer = row.querySelector('.reason-container');
    const needsReviewCheckbox = row.querySelector('.needs-review-checkbox');
    const approvedIndicator = row.querySelector('.approved-indicator');
    const approvedLabel = row.querySelector('.approved-toggle-label');
    if (reviewContainer) reviewContainer.style.display = 'flex';
    if (needsReviewLabel) needsReviewLabel.style.display = approved ? 'none' : 'flex';
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
    upsertBackTranslationInRow(row, result?.backTranslation || '');

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
        syncApprovedRowUi(row, isManualApprovedResult(result));
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
    scoreBadge.title = buildScoreTooltip(result, score);

    ensureScoreSourceBadge(statusWrap, inferScoreSource(result), result?.aiModel || '');
    syncApprovedRowUi(row, isManualApprovedResult(result));

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
        const nowIso = new Date().toISOString();
        if (typeof result.score === 'number') result.manualOverridePreviousScore = result.score;
        if (priorSource) result.manualOverridePreviousSource = priorSource;
        if (typeof result.notes === 'string') result.manualOverridePreviousNotes = result.notes;
        result.manualApproved = true;
        result.manualApprovalUpdatedAt = nowIso;
        result.updated = nowIso;
        result.score = 1.0;
        result.scoreSource = 'manual';
        result.notes = 'Manually approved';
        result.timestamp = nowIso;
    } else {
        const nowIso = new Date().toISOString();
        result.manualApproved = false;
        result.manualApprovalUpdatedAt = nowIso;
        result.updated = nowIso;
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
        const restoredNotes = result.manualOverridePreviousNotes;
        if (typeof restoredNotes === 'string') {
            result.notes = restoredNotes;
            delete result.manualOverridePreviousNotes;
        } else if (String(result.notes || '').trim().toLowerCase() === 'manually approved') {
            // Clear approval marker so this row no longer behaves like manual-approved.
            delete result.notes;
        }
        result.timestamp = nowIso;
    }
    dashboard.validation_results[itemId][langKey] = result;
    applyValidationUiFromResult(itemId, langCode, rowEl);
    // Persist immediately so manual approval is saved/reloaded with other validation metadata.
    try { dashboard.saveValidationResults(); } catch (_) {}
    if (typeof updateValidationSummary === 'function') updateValidationSummary();
}

let _validationAutoSaveTimer = null;
let _validationAutoSaveInFlight = false;
let _validationAutoSaveQueued = false;
let _validationSummaryTimer = null;

function requestValidationSummaryUpdate(delayMs = 120) {
    if (_validationSummaryTimer) clearTimeout(_validationSummaryTimer);
    _validationSummaryTimer = setTimeout(() => {
        _validationSummaryTimer = null;
        updateValidationSummary();
    }, delayMs);
}

function queueValidationAutoSave() {
    const dashboard = window.dashboard;
    if (!dashboard || typeof dashboard.saveValidationResults !== 'function') return;
    _validationAutoSaveQueued = true;
    if (_validationAutoSaveTimer) clearTimeout(_validationAutoSaveTimer);
    _validationAutoSaveTimer = setTimeout(async () => {
        if (_validationAutoSaveInFlight) {
            queueValidationAutoSave();
            return;
        }
        _validationAutoSaveInFlight = true;
        _validationAutoSaveQueued = false;
        try {
            await dashboard.saveValidationResults({ updateBaseline: false, silent: true });
        } catch (e) {
            console.warn('Auto-save failed:', e?.message || e);
        } finally {
            _validationAutoSaveInFlight = false;
            if (_validationAutoSaveQueued) queueValidationAutoSave();
        }
    }, 2000);
}

async function flushValidationAutoSave() {
    const dashboard = window.dashboard;
    if (!dashboard || typeof dashboard.saveValidationResults !== 'function') return;
    const hadPending = _validationAutoSaveQueued || !!_validationAutoSaveTimer || _validationAutoSaveInFlight;
    if (_validationAutoSaveTimer) {
        clearTimeout(_validationAutoSaveTimer);
        _validationAutoSaveTimer = null;
    }
    _validationAutoSaveQueued = false;
    if (!hadPending) return;
    try {
        await dashboard.saveValidationResults({ updateBaseline: false, silent: true });
    } catch (e) {
        console.warn('flushValidationAutoSave failed:', e?.message || e);
    }
}

function resetValidationUiForRow(row, langCode) {
    if (!row) return;
    const indicator = row.querySelector('.status-indicator');
    const button = row.querySelector('.validate-btn');
    const statusWrap = indicator ? indicator.parentElement : null;
    if (indicator) {
        indicator.className = 'status-indicator status-pending';
        indicator.title = 'Not validated yet';
        indicator.onclick = null;
    }
    if (button) {
        button.textContent = 'Validate';
        button.disabled = false;
        const itemId = String(row.dataset.itemId || '');
        button.onclick = () => {
            if (window.validateByItemId) {
                window.validateByItemId(itemId, langCode);
            }
        };
    }
    if (statusWrap) {
        const scoreBadge = statusWrap.querySelector('.score-badge');
        if (scoreBadge) scoreBadge.remove();
        const sourceBadge = statusWrap.querySelector('.score-source-badge');
        if (sourceBadge) sourceBadge.remove();
        const approvedIndicator = statusWrap.querySelector('.approved-indicator');
        if (approvedIndicator) approvedIndicator.style.display = 'none';
        const approvedCheckbox = statusWrap.querySelector('.approved-checkbox');
        if (approvedCheckbox) approvedCheckbox.checked = false;
    }
    const backEl = row.querySelector('.item-backtranslation');
    if (backEl) backEl.remove();
    row.dataset.score = '-1';
    row.dataset.approved = '0';
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
    let queuedStaleForRevalidation = 0;
    visibleRows.forEach(row => {
        const itemId = String(row.dataset.itemId || '');
        if (!itemId) return;
        const existing = getValidationResult(dashboard, itemId, langCode);
        const requiresRevalidation = existing?.requiresRevalidation === true;
        const alreadyValidated = existing && typeof existing.score === 'number' && !requiresRevalidation;
        if (alreadyValidated && !forceAll) {
            skippedAlreadyValidated++;
            return;
        }
        if (requiresRevalidation && !forceAll) {
            queuedStaleForRevalidation++;
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
            alert('No pending or stale translations to validate in the current language/filter (or translations are missing).');
        }
        return;
    }

    const tuning = getValidateAllTuning(aiMode, speedMode, jobs.length);
    const perItemDelayMs = tuning.perItemDelayMs;
    const concurrency = tuning.concurrency;
    const actionLabel = forceAll ? 're-validate' : 'validate';
    const skippedCount = forceAll ? 0 : skippedAlreadyValidated;
    const skippedMissing = forceAll ? 0 : skippedMissingTranslation;
    const staleLabel = (!forceAll && queuedStaleForRevalidation > 0)
        ? `, ${queuedStaleForRevalidation} stale row(s) queued`
        : '';
    if (confirm(
        `This will ${actionLabel} ${jobs.length} ${currentLanguage.toUpperCase()} translations ` +
        `(${skippedCount} already validated skipped${staleLabel}${skippedMissing ? `, ${skippedMissing} missing translation skipped` : ''}).\n` +
        `Mode: ${speedMode.toUpperCase()} | Concurrency: ${concurrency} | Delay: ${perItemDelayMs}ms\n\nContinue?`
    )) {
        if (forceAll) {
            const langKey = resolveValidationLangCode(dashboard, langCode);
            jobs.forEach((job) => {
                const rawId = String(job.itemId || '');
                const candidateKeys = new Set([rawId, rawId.toLowerCase()]);
                if (rawId.includes('::')) {
                    const tail = String(rawId.split('::').pop() || '').trim();
                    if (tail) {
                        candidateKeys.add(tail);
                        candidateKeys.add(tail.toLowerCase());
                    }
                }
                Object.keys(dashboard.validation_results || {}).forEach((storedKey) => {
                    const s = String(storedKey || '');
                    const sLower = s.toLowerCase();
                    if (
                        candidateKeys.has(s)
                        || candidateKeys.has(sLower)
                        || s.endsWith(`::${rawId}`)
                        || sLower.endsWith(`::${rawId.toLowerCase()}`)
                    ) {
                        const byItem = dashboard.validation_results[storedKey];
                        if (byItem && byItem[langKey]) {
                            delete byItem[langKey];
                            if (Object.keys(byItem).length === 0) delete dashboard.validation_results[storedKey];
                        }
                    }
                });
            });
            visibleRows.forEach((row) => resetValidationUiForRow(row, langCode));
            if (typeof updateValidationSummary === 'function') updateValidationSummary();
            queueValidationAutoSave();
        }
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
                    const staleDoneLabel = !forceAll && queuedStaleForRevalidation > 0
                        ? ` (${queuedStaleForRevalidation} stale row(s) refreshed)`
                        : '';
                    dashboard.setStatus(
                        `✅ Validation complete: ${total} ${doneLabel} ${currentLanguage.toUpperCase()} items${staleDoneLabel} in ${speedMode.toUpperCase()} mode (AI: ${src.ai}, Calculated: ${src.calculated}, Errors: ${src.error})`,
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
            let statusMessage = `💾 Saved ${result.itemCount} items (${result.validationCount} validations) [local: ${localMode}, shared: ${sharedLabel}]`;
            let statusLevel = result.sharedSaved ? 'success' : 'warning';

            // Auto-sync immediately after a successful shared save so users only need one click.
            if (result.sharedSaved) {
                button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saved, syncing...';
                const syncSuccess = await window.dashboard.loadFromSharedStorage();
                if (syncSuccess) {
                    if (typeof window.dashboard.noteValidationResultsChanged === 'function') {
                        window.dashboard.noteValidationResultsChanged();
                    }
                    window.dashboard.populateDataTable();
                    const source = String(window.dashboard?.sharedValidationSource || 'unknown');
                    const sourceLabel = source === 'gcs' ? 'shared bucket (GCS)' : source === 'memory' ? 'session memory fallback' : source;
                    const nowIso = new Date().toISOString();
                    try { localStorage.setItem('validation_shared_last_sync', nowIso); } catch (_) {}
                    try { localStorage.setItem('validation_shared_last_sync_source', source); } catch (_) {}
                    if (typeof window.setValidationSharedSyncLabel === 'function') {
                        window.setValidationSharedSyncLabel(nowIso, false, source);
                    }
                    statusMessage += ` · Auto-synced from ${sourceLabel}`;
                    statusLevel = source === 'memory' ? 'warning' : 'success';
                } else {
                    statusMessage += ' · Auto-sync failed (click Sync)';
                    statusLevel = 'warning';
                }
                button.innerHTML = '<i class="fas fa-check"></i> Saved + Synced!';
            }

            window.dashboard.setStatus(statusMessage, statusLevel);
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
        const success = await window.dashboard.loadFromSharedStorage('', { force: true });
        if (success) {
            if (typeof window.dashboard.noteValidationResultsChanged === 'function') {
                window.dashboard.noteValidationResultsChanged();
            }
            // Re-render the table to show updated validation results (pre-computed in HTML)
            window.dashboard.populateDataTable();
            button.innerHTML = '<i class="fas fa-check"></i> Loaded!';
            const source = String(window.dashboard?.sharedValidationSource || 'unknown');
            const sourceLabel = source === 'gcs' ? 'shared bucket (GCS)' : source === 'memory' ? 'session memory fallback' : source;
            window.dashboard.setStatus(`🌐 Successfully loaded validation results from ${sourceLabel}`, source === 'memory' ? 'warning' : 'success');
            const nowIso = new Date().toISOString();
            try { localStorage.setItem('validation_shared_last_sync', nowIso); } catch (_) {}
            try { localStorage.setItem('validation_shared_last_sync_source', source); } catch (_) {}
            if (typeof window.setValidationSharedSyncLabel === 'function') {
                window.setValidationSharedSyncLabel(nowIso, false, source);
            }
            setTimeout(() => { button.innerHTML = originalText; button.disabled = false; }, 2000);
        } else {
            button.innerHTML = '<i class="fas fa-info-circle"></i> Up to date';
            window.dashboard.setStatus('ℹ️ Shared validation already up to date (no new changes)', 'success');
            setTimeout(() => { button.innerHTML = originalText; button.disabled = false; }, 2000);
        }
    } catch (error) {
        button.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error!';
        window.dashboard.setStatus(`❌ Error loading shared validations: ${error.message}`, 'error');
        if (typeof window.setValidationSharedSyncLabel === 'function') {
            window.setValidationSharedSyncLabel('', true);
        }
        setTimeout(() => { button.innerHTML = originalText; button.disabled = false; }, 3000);
    }
}

async function validateSingle(itemId, originalText, translatedText, langCode) {
    const normalizedOriginalText = toPlainValidationText(originalText);
    const normalizedTranslatedText = toPlainValidationText(translatedText);
    const itemRow = Array.isArray(window.dashboard?.data)
        ? window.dashboard.data.find((row) => String(row.item_id || row.identifier || '') === String(itemId))
        : null;
    const taskName = itemRow?.task || itemRow?.labels || itemRow?.task_name || '';
    const aiItemType = inferAiJudgeItemType({
        itemId,
        originalText: normalizedOriginalText,
        translatedText: normalizedTranslatedText,
        taskName,
    });
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
            const preserveManualApproval = existingResult.manualApproved === true;
            const sourceHash = typeof window.dashboard?.simpleStableHash === 'function'
                ? window.dashboard.simpleStableHash(normalizedOriginalText)
                : '';
            const translationHash = typeof window.dashboard?.simpleStableHash === 'function'
                ? window.dashboard.simpleStableHash(normalizedTranslatedText)
                : '';
            window.dashboard.validation_results[itemId][langKey] = {
                score: similarity,
                originalText: normalizedOriginalText,
                translatedText: normalizedTranslatedText,
                backTranslation: 'N/A (source language)',
                timestamp: new Date().toISOString(),
                notes: 'Source language - no translation validation needed',
                scoreSource: 'calculated',
                manualApproved: preserveManualApproval,
                manualApprovalUpdatedAt: existingResult.manualApprovalUpdatedAt || '',
                needsReview: !!existingResult.needsReview,
                reason: existingResult.reason || '',
                requiresRevalidation: false,
                changeKind: '',
                changeDetectedAt: '',
                lastSeenSourceHash: sourceHash,
                lastSeenTranslationHash: translationHash
            };
            if (preserveManualApproval) {
                window.dashboard.validation_results[itemId][langKey].score = 1.0;
                window.dashboard.validation_results[itemId][langKey].scoreSource = 'manual';
                window.dashboard.validation_results[itemId][langKey].notes = 'Manually approved';
                if (typeof existingResult.manualOverridePreviousScore === 'number') {
                    window.dashboard.validation_results[itemId][langKey].manualOverridePreviousScore = existingResult.manualOverridePreviousScore;
                }
                if (existingResult.manualOverridePreviousSource) {
                    window.dashboard.validation_results[itemId][langKey].manualOverridePreviousSource = existingResult.manualOverridePreviousSource;
                }
            }

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
            queueValidationAutoSave();
            return { scoreSource: 'calculated' };
        }

        let backTranslation = '';
        let baselineScore = null; // composite baseline score
        let semanticScore = null;
        let semanticScoreRaw = null;
        let semanticScoreMasked = null;
        let lexicalScore = null;
        let compositeScore = null;
        let semanticModel = '';
        let lexicalMethod = 'normalized-levenshtein';
        let isVocabLike = isVocabLikePair(normalizedOriginalText, normalizedTranslatedText);
        let aiJudge = { used: false, aiScore: null, finalScore: null, aiNotes: '', modelUsed: null, adequacy: null, fluency: null, issues: '' };
        const googleLangCode = mapToGoogleTranslateCode(langCode);
        console.log('🌍 Language mapping:', { original: langCode, mapped: googleLangCode });

        // Always compute back-translation for explainability/UI context.
        const backTranslationResult = await runBackTranslationProvider({
            text: normalizedTranslatedText,
            fromLang: googleLangCode,
            toLang: 'en',
            userKey
        });
        backTranslation = toPlainValidationText(backTranslationResult.translatedText);

        // Deterministic scoring layer: semantic + lexical -> composite baseline
        const lexicalMask = applyEntityMaskingForLexical(
            normalizedOriginalText,
            backTranslation,
            aiItemType,
            { itemId, taskName }
        );
        lexicalScore = computeLexicalScore(lexicalMask.originalMasked, lexicalMask.backMasked);
        if (lexicalMask.applied) lexicalMethod = 'normalized-levenshtein-entity-masked';
        const semantic = await runSemanticScorer({
            originalText: normalizedOriginalText,
            backTranslation,
            langCode
        });
        if (semantic.used) {
            semanticScoreRaw = semantic.score;
            semanticScore = semantic.score;
            semanticModel = semantic.modelUsed || '';
        } else {
            semanticScoreRaw = computeLegacyOverlapScore(normalizedOriginalText, backTranslation);
            semanticScore = semanticScoreRaw;
            semanticModel = 'word-overlap-fallback';
        }
        const semanticMask = applyEntityMaskingForLexical(
            normalizedOriginalText,
            backTranslation,
            aiItemType,
            { itemId, taskName }
        );
        const semanticMaskApplied = !!semanticMask.applied;
        if (semanticMaskApplied) {
            const maskedSemantic = await runSemanticScorer({
                originalText: semanticMask.originalMasked,
                backTranslation: semanticMask.backMasked,
                langCode
            });
            semanticScoreMasked = maskedSemantic.used
                ? maskedSemantic.score
                : computeLegacyOverlapScore(semanticMask.originalMasked, semanticMask.backMasked);
            // For proper nouns, keep the higher of raw/masked semantic to reduce false penalties from name localization.
            semanticScore = Math.max(Number(semanticScore) || 0, Number(semanticScoreMasked) || 0);
            if (semanticScoreMasked > semanticScoreRaw) {
                semanticModel = `${semanticModel || 'semantic'}|entity-masked-max`;
            }
        }
        compositeScore = computeCompositeScore(semanticScore, lexicalScore, isVocabLike, lexicalMask.applied);
        baselineScore = compositeScore;

        aiJudge = await runAiJudge({
            originalText: normalizedOriginalText,
            translatedText: normalizedTranslatedText,
            backTranslation,
            langCode,
            baseScore: baselineScore,
            itemType: aiItemType,
            nameMaskApplied: lexicalMask.applied
        });
        const score = aiJudge.used ? aiJudge.finalScore : baselineScore;

        // Store validation result
        if (!window.dashboard.validation_results[itemId]) {
            window.dashboard.validation_results[itemId] = {};
        }
        const langKey = resolveValidationLangCode(window.dashboard, langCode);
        
        const existingResult = getValidationResult(window.dashboard, itemId, langCode) || {};
        const preserveManualApproval = existingResult.manualApproved === true;
        const sourceHash = typeof window.dashboard?.simpleStableHash === 'function'
            ? window.dashboard.simpleStableHash(normalizedOriginalText)
            : '';
        const translationHash = typeof window.dashboard?.simpleStableHash === 'function'
            ? window.dashboard.simpleStableHash(normalizedTranslatedText)
            : '';
        window.dashboard.validation_results[itemId][langKey] = {
            score: score / 100, // Store as decimal for consistency
            originalText: normalizedOriginalText,
            translatedText: normalizedTranslatedText,
            backTranslation: backTranslation,
            timestamp: new Date().toISOString(),
            notes: score >= VALIDATION_PASS_THRESHOLD ? 'Excellent translation' : score >= VALIDATION_REVIEW_THRESHOLD ? 'Good translation, review recommended' : 'Poor translation quality',
            baselineScore: baselineScore,
            semanticScore: semanticScore,
            semanticScoreRaw: semanticScoreRaw,
            semanticScoreMasked: semanticScoreMasked,
            semanticEntityMaskApplied: semanticMaskApplied,
            lexicalScore: lexicalScore,
            compositeScore: compositeScore,
            semanticModel: semanticModel,
            lexicalMethod: lexicalMethod,
            lexicalEntityMaskApplied: !!lexicalMask.applied,
            lexicalEntityMaskTokenCount: lexicalMask.tokenCount || 0,
            isVocabLike: isVocabLike,
            aiItemType: aiItemType,
            scoringVersion: VALIDATION_SCORING_VERSION,
            aiScore: aiJudge.used ? aiJudge.aiScore : null,
            aiUsed: aiJudge.used === true,
            aiNotes: aiJudge.used ? aiJudge.aiNotes : '',
            aiModel: aiJudge.used ? (aiJudge.modelUsed || '') : '',
            aiAdequacy: aiJudge.used ? aiJudge.adequacy : null,
            aiFluency: aiJudge.used ? aiJudge.fluency : null,
            aiIssues: aiJudge.used ? aiJudge.issues : '',
            scoreSource: aiJudge.used ? 'ai' : 'calculated',
            manualApproved: preserveManualApproval,
            manualApprovalUpdatedAt: existingResult.manualApprovalUpdatedAt || '',
            needsReview: !!existingResult.needsReview,
            reason: existingResult.reason || '',
            requiresRevalidation: false,
            changeKind: '',
            changeDetectedAt: '',
            lastSeenSourceHash: sourceHash,
            lastSeenTranslationHash: translationHash
        };
        if (preserveManualApproval) {
            window.dashboard.validation_results[itemId][langKey].score = 1.0;
            window.dashboard.validation_results[itemId][langKey].scoreSource = 'manual';
            window.dashboard.validation_results[itemId][langKey].notes = 'Manually approved';
            if (typeof existingResult.manualOverridePreviousScore === 'number') {
                window.dashboard.validation_results[itemId][langKey].manualOverridePreviousScore = existingResult.manualOverridePreviousScore;
            }
            if (existingResult.manualOverridePreviousSource) {
                window.dashboard.validation_results[itemId][langKey].manualOverridePreviousSource = existingResult.manualOverridePreviousSource;
            }
        }

        // Determine status based on score (using original dashboard-core.js logic)
        let statusClass, statusTitle, buttonText, scoreEmoji;
        if (score >= VALIDATION_PASS_THRESHOLD) {
            statusClass = 'status-good';
            statusTitle = `✅ Excellent: ${score}% similarity`;
            buttonText = 'Good match';
            scoreEmoji = '✅';
        } else if (score >= VALIDATION_REVIEW_THRESHOLD) {
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
        upsertBackTranslationInRow(rowEl, backTranslation);
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
        scoreBadge.style.color = score >= VALIDATION_PASS_THRESHOLD ? '#155724' : score >= VALIDATION_REVIEW_THRESHOLD ? '#856404' : '#721c24';
        scoreBadge.title = buildScoreTooltip(window.dashboard.validation_results[itemId]?.[langKey], score);

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

        window.dashboard.setStatus(`${scoreEmoji} Validated ${itemId}: ${score}% composite similarity`, 'success');
        queueValidationAutoSave();
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
            
            // Update summary counts (debounced to avoid expensive per-row recomputation storms).
            requestValidationSummaryUpdate();
        }
}

function exportValidationsToJSONFile() {
    let totalValidations = 0;
    Object.keys(window.dashboard.validation_results).forEach(itemId => { totalValidations += Object.keys(window.dashboard.validation_results[itemId]).length; });
    const exportData = {
        metadata: {
            exported_at: new Date().toISOString(),
            exported_by: 'Levante Cockpit Dashboard',
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
    const ids = ['goodCount', 'warningCount', 'errorCount', 'needsReviewCount', 'approvedCount', 'pendingCount'];
    const spinner = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i>';
    const loadingLabel = document.getElementById('validationSummaryLoadingLabel');
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (loading) el.innerHTML = spinner;
            // Do not write "0" here — that flashes before setValidationSummaryCounts / updateValidationSummary run.
        }
    });
    if (loadingLabel) loadingLabel.style.display = loading ? 'inline-block' : 'none';
}

function setValidationSummaryCounts(counts) {
    const goodEl = document.getElementById('goodCount');
    const warningEl = document.getElementById('warningCount');
    const errorEl = document.getElementById('errorCount');
    const needsReviewEl = document.getElementById('needsReviewCount');
    const approvedEl = document.getElementById('approvedCount');
    const pendingEl = document.getElementById('pendingCount');
    if (goodEl) goodEl.textContent = Number(counts?.good || 0);
    if (warningEl) warningEl.textContent = Number(counts?.warning || 0);
    if (errorEl) errorEl.textContent = Number(counts?.error || 0);
    if (needsReviewEl) needsReviewEl.textContent = Number(counts?.needsReview || 0);
    if (approvedEl) approvedEl.textContent = Number(counts?.approved || 0);
    if (pendingEl) pendingEl.textContent = Number(counts?.pending || 0);
}

function updateValidationSummary() {
    const dash = window.dashboard;
    const currentLanguage = dash?.currentLanguage;
    if (!currentLanguage) return;
    const langCode = String(dash.languages?.[currentLanguage]?.lang_code || '').trim();
    // Prefer live validation_results — DOM row datasets can lag async shared-storage merges.
    if (langCode && typeof dash.computeValidationSummaryCountsForRows === 'function' && typeof dash.getVisibleValidationRowsForLanguage === 'function') {
        const rows = dash.getVisibleValidationRowsForLanguage(currentLanguage);
        const counts = dash.computeValidationSummaryCountsForRows(rows, langCode);
        setValidationSummaryCounts(counts);
        return;
    }
    const currentTable = document.getElementById(`table-${currentLanguage}`);
    if (!currentTable) return;
    const indicators = currentTable.querySelectorAll('.status-indicator');
    let allowedIds = null;
    const filterEl = document.getElementById('reviewTablePathFilter');
    const filter = String(filterEl?.value || 'all').toLowerCase();
    // Fast path: when viewing all files, skip expensive full data scan/set creation.
    if (filter !== 'all' && typeof getReviewTableAllowedItemIds === 'function') {
        allowedIds = getReviewTableAllowedItemIds();
    }
    let good = 0, warning = 0, error = 0, needsReview = 0, approved = 0, pending = 0;
    indicators.forEach(indicator => {
        const row = indicator.closest('.data-row');
        const itemId = row ? row.dataset.itemId : indicator.getAttribute('data-item-id');
        if (allowedIds && itemId != null && !allowedIds.has(String(itemId))) return;
        if (row && row.dataset.needsReview === '1') needsReview++;
        if (row && row.dataset.approved === '1') approved++;
        if (indicator.classList.contains('status-good')) good++;
        else if (indicator.classList.contains('status-warning')) warning++;
        else if (indicator.classList.contains('status-error')) error++;
        else pending++;
    });
    setValidationSummaryCounts({ good, warning, error, needsReview, approved, pending });
}

// Ensure inline HTML handlers can resolve these functions.
if (typeof window !== 'undefined') {
    window.setManualApprovalForValidation = setManualApprovalForValidation;
    window.flushValidationAutoSave = flushValidationAutoSave;
    window.showStoredValidationResult = showStoredValidationResult;
    window.validateByItemId = validateByItemId;
    window.toggleValidateAllRun = toggleValidateAllRun;
    window.setValidationSummaryCounts = setValidationSummaryCounts;
}

