// core-tasks.js
// API endpoint to interact with the core-tasks repository (GitHub):
// - List branches (sorted by recent activity)
// - Check for timeline existence for a task on a given branch

import fetch from 'node-fetch';

function getRepoConfig() {
    const defaultRepo = process.env.CORE_TASKS_DEFAULT_REPO || 'levante-framework/core-tasks';
    const repo = process.env.CORE_TASKS_GITHUB_REPO || process.env.CORE_TASKS_REPO || defaultRepo;
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    return { repo, token };
}

// Simple in-memory cache (TTL ms)
const cache = new Map();
function getCached(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) { cache.delete(key); return null; }
    return hit.value;
}
function setCached(key, value, ttlMs = 10 * 60 * 1000) { // 10 minutes
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function githubRequest(path) {
    const { repo, token } = getRepoConfig();
    const url = `https://api.github.com/repos/${repo}${path}`;
    const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'levante-dashboard' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
        const text = await resp.text();
        const err = new Error(`GitHub request failed: ${resp.status} ${resp.statusText} - ${text}`);
        err.status = resp.status;
        throw err;
    }
    return resp.json();
}

async function fetchRaw(repoPath, branch) {
    const { repo } = getRepoConfig();
    const key = `raw:${repo}:${branch}:${repoPath}`;
    const cached = getCached(key);
    if (cached) return cached;
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/${repoPath}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'levante-dashboard' } });
    if (!resp.ok) throw new Error(`Failed to fetch raw ${repoPath}: ${resp.status} ${resp.statusText}`);
    const text = await resp.text();
    setCached(key, text);
    return text;
}

async function listDir(repoPath, branch) {
    // Keep Contents API only for listing (raw does not list directories)
    const { repo, token } = getRepoConfig();
    const key = `list:${repo}:${branch}:${repoPath}`;
    const cached = getCached(key);
    if (cached) return cached;
    const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'levante-dashboard' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const url = `https://api.github.com/repos/${repo}/contents/${repoPath}?ref=${encodeURIComponent(branch)}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) return [];
    const json = await resp.json();
    setCached(key, json);
    return json;
}

async function existsAt(repoPath, branch) {
    try {
        await fetchRaw(repoPath, branch);
        return true;
    } catch (e) {
        return false;
    }
}

async function resolveWithExtensions(basePath, branch) {
    const candidates = [
        `${basePath}.ts`,
        `${basePath}.js`
    ];
    for (const p of candidates) {
        try {
            await fetchRaw(p, branch);
            return { exists: true, path: p };
        } catch (e) {
            // ignore
        }
    }
    return { exists: false, path: candidates[0] };
}

async function listBranchesSorted() {
    // Get branches and fetch their latest commit dates for sorting
    const branches = await githubRequest('/branches?per_page=100');
    const withDates = await Promise.all(branches.map(async (b) => {
        try {
            const commit = await githubRequest(`/commits/${b.commit.sha}`);
            const date = commit && commit.commit && commit.commit.author && commit.commit.author.date;
            return { name: b.name, date: date || null };
        } catch (_) {
            return { name: b.name, date: null };
        }
    }));
    // Sort by date desc, ensuring 'main' stays first when present
    withDates.sort((a, b) => {
        if (a.name === 'main') return -1;
        if (b.name === 'main') return 1;
        const da = a.date ? Date.parse(a.date) : 0;
        const db = b.date ? Date.parse(b.date) : 0;
        return db - da;
    });
    return withDates;
}

async function checkTimelineExists(task, branch) {
    // Path inside core-tasks repo
    const base = `task-launcher/src/tasks/${task}/timeline`;
    const res = await resolveWithExtensions(base, branch);
    return { exists: res.exists, path: res.path, resolvedFrom: 'default' };
}

function kebabToCamel(str) {
    return str.replace(/-([a-z0-9])/g, (_, c) => (c || '').toUpperCase());
}

async function findTimelineHeuristic(task, branch) {
    const base = 'task-launcher/src/tasks';
    try {
        const roots = await listDir(base, branch);
        if (!Array.isArray(roots)) return null;

        // Priority 1: <group>/<task>/timeline.{ts,js} for any group
        for (const entry of roots) {
            if (entry.type !== 'dir') continue;
            const basePath = `${entry.path}/${task}/timeline`;
            const resolved = await resolveWithExtensions(basePath, branch);
            if (resolved.exists) {
                return { exists: true, path: resolved.path, resolvedFrom: 'heuristic-group-task' };
            }
        }

        // Priority 2: <group>/timeline.{ts,js} (single timeline inside group)
        for (const entry of roots) {
            if (entry.type !== 'dir') continue;
            const basePath = `${entry.path}/timeline`;
            const resolved = await resolveWithExtensions(basePath, branch);
            if (resolved.exists) {
                return { exists: true, path: resolved.path, resolvedFrom: 'heuristic-group' };
            }
        }
    } catch (_) {}
    return null;
}

async function locateTimelineViaConfig(task, branch) {
    const registryKey = kebabToCamel(task);
    const configPath = 'task-launcher/src/tasks/taskConfig.ts';
    try {
        const ts = await fetchRaw(configPath, branch);
        // Try dynamic import inside buildTaskTimeline entry for this registryKey
        const registryBlockRe = new RegExp(`${registryKey}[^\n]*?[:=][\n\r\s\S]*?buildTaskTimeline[\n\r\s\S]*?`, 'm');
        const block = ts.match(registryBlockRe)?.[0] || '';
        // 1) dynamic import("./path/to/timeline")
        const dynMatch = block.match(/import\(\s*['\"]([^'\"]+)['\"]\s*\)/);
        if (dynMatch && dynMatch[1]) {
            let rel = dynMatch[1];
            const basePath = `task-launcher/src/tasks/${rel.replace(/^\.\//, '')}`.replace(/\.(ts|js)$/,'');
            const resolved = await resolveWithExtensions(basePath, branch);
            return { exists: resolved.exists, path: resolved.path, resolvedFrom: 'taskConfig' };
        }
        // 2) static import mapping: import X from './math/timeline'; buildTaskTimeline: X
        const idMatch = block.match(/buildTaskTimeline\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
        if (idMatch && idMatch[1]) {
            const ident = idMatch[1];
            const importRe = new RegExp(`import\\s+${ident}\\s+from\\s+['\"]([^'\"]+)['\"];?`);
            const importMatch = ts.match(importRe);
            if (importMatch && importMatch[1]) {
                let rel = importMatch[1];
                const basePath = `task-launcher/src/tasks/${rel.replace(/^\.\//, '')}`.replace(/\.(ts|js)$/,'');
                const resolved = await resolveWithExtensions(basePath, branch);
                return { exists: resolved.exists, path: resolved.path, resolvedFrom: 'taskConfig-import' };
            }
        }
    } catch (_) {}
    return null;
}

function deriveGroupCandidates(task) {
    const overrides = {
        'egma-math': ['math']
    };
    const parts = String(task).split('-').filter(Boolean);
    const candidates = new Set();
    if (overrides[task]) overrides[task].forEach(g => candidates.add(g));
    if (parts.length > 1) candidates.add(parts[parts.length - 1]); // last token e.g., 'math'
    if (parts.length > 0) candidates.add(parts[0]); // first token e.g., 'egma'
    return Array.from(candidates);
}

async function findTimelineByDerivedGroups(task, branch) {
    const groups = deriveGroupCandidates(task);
    // Prefer group-flat first, then group/task
    for (const group of groups) {
        const res = await resolveWithExtensions(`task-launcher/src/tasks/${group}/timeline`, branch);
        if (res.exists) {
            return { exists: true, path: res.path, resolvedFrom: `derived-group-${group}` };
        }
    }
    for (const group of groups) {
        const res = await resolveWithExtensions(`task-launcher/src/tasks/${group}/${task}/timeline`, branch);
        if (res.exists) {
            return { exists: true, path: res.path, resolvedFrom: `derived-group-task-${group}` };
        }
    }
    // Provide candidate paths to help the UI when GitHub is unavailable
    const candidates = [];
    for (const group of groups) {
        candidates.push(`task-launcher/src/tasks/${group}/timeline.ts`);
        candidates.push(`task-launcher/src/tasks/${group}/timeline.js`);
        candidates.push(`task-launcher/src/tasks/${group}/${task}/timeline.ts`);
        candidates.push(`task-launcher/src/tasks/${group}/${task}/timeline.js`);
    }
    return { exists: false, path: `task-launcher/src/tasks/${task}/timeline.ts`, resolvedFrom: 'derived-group', candidates };
}

// Extract variant names and languages for a given task from taskConfig.ts
async function getVariantLanguages(task, branch) {
    const registryKey = kebabToCamel(task);
    const configPath = 'task-launcher/src/tasks/taskConfig.ts';
    const variants = [];
    const languages = new Set();
    try {
        const ts = await fetchRaw(configPath, branch);
        const registryBlockRe = new RegExp(`${registryKey}[^\n]*?[:=][\n\r\s\S]*?(?:(?:},?)\s*\n|\n\})`, 'm');
        const block = ts.match(registryBlockRe)?.[0] || '';
        if (!block) return { variants: [], languages: [] };

        // Find a variants object literal inside the task block
        // e.g., variants: { short: { ... }, spanish: { language: 'es-CO' } }
        const variantsSectionMatch = block.match(/variants\s*:\s*\{([\s\S]*?)\}/m);
        if (variantsSectionMatch) {
            const inner = variantsSectionMatch[1];
            // Capture variant keys
            const nameMatches = Array.from(inner.matchAll(/([A-Za-z0-9_$-]+)\s*:\s*\{/g));
            nameMatches.forEach(m => {
                const name = (m[1] || '').trim();
                if (name) variants.push(name);
            });
            // Capture language codes in variant bodies
            const langMatches = Array.from(inner.matchAll(/language\s*:\s*['\"]([A-Za-z]{2}(?:-[A-Za-z]{2})?)['\"]/g));
            langMatches.forEach(m => languages.add(m[1]));
        }

        // Also look for an array of variants with language fields
        // e.g., variants: [ { name: 'spanish', language: 'es-CO' }, ... ]
        const variantsArrayMatch = block.match(/variants\s*:\s*\[([\s\S]*?)\]/m);
        if (variantsArrayMatch) {
            const arr = variantsArrayMatch[1];
            const nameMatches2 = Array.from(arr.matchAll(/name\s*:\s*['\"]([^'\"]+)['\"]/g));
            nameMatches2.forEach(m => variants.push(m[1]));
            const langMatches2 = Array.from(arr.matchAll(/language\s*:\s*['\"]([A-Za-z]{2}(?:-[A-Za-z]{2})?)['\"]/g));
            langMatches2.forEach(m => languages.add(m[1]));
        }
    } catch (_) {}

    // Unique and stable order
    const uniqueVariants = Array.from(new Set(variants));
    const uniqueLangs = Array.from(languages);
    return { variants: uniqueVariants, languages: uniqueLangs };
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }
    const op = (req.query.op || '').toString();
    try {
        if (op === 'branches') {
            const branches = await listBranchesSorted();
            res.status(200).json({ branches });
            return;
        }
        if (op === 'timeline') {
            const task = (req.query.task || '').toString();
            const branch = (req.query.branch || 'main').toString();
            if (!task) {
                res.status(400).json({ error: 'Missing task parameter' });
                return;
            }
            let result = { exists: false, path: `task-launcher/src/tasks/${task}/timeline.ts`, resolvedFrom: 'default' };
            let hadGithubIssue = false;
            // Step 1: default location
            try {
                const def = await checkTimelineExists(task, branch);
                result = def;
            } catch (e) {
                hadGithubIssue = true;
            }

            // Step 2: taskConfig mapping (only accept if it actually exists)
            let altCandidate = null;
            if (!result.exists) {
                try {
                    const alt = await locateTimelineViaConfig(task, branch);
                    if (alt && alt.exists) {
                        result = alt;
                    } else if (alt) {
                        altCandidate = alt; // keep as fallback info, but continue scanning
                    }
                } catch (_) {
                    hadGithubIssue = true;
                }
            }

            // Step 3: heuristic scan
            if (!result.exists) {
                try {
                    const guessed = await findTimelineHeuristic(task, branch);
                    if (guessed) {
                        result = guessed;
                    } else if (altCandidate) {
                        result = altCandidate; // fall back to non-existing alt only if nothing else
                    }
                } catch (_) {
                    hadGithubIssue = true;
                }
            }

            // Step 4: Derived group mapping (explicitly map egma-math -> math and similar heuristics)
            if (!result.exists) {
                try {
                    const mapped = await findTimelineByDerivedGroups(task, branch);
                    if (mapped) result = mapped;
                } catch (_) {
                    hadGithubIssue = true;
                }
            }

            // Fetch file contents to run lightweight static checks
            let checks = { 
                defaultExport: null, 
                imports: { getTranslations: false, getMediaAssets: false }, 
                providers: { staticGetTranslationsImport: false, dynamicGetTranslationsImport: false, useTranslationsHook: false, ctxProvidesT: false, paramProvidesT: false, any: false },
                uses: { tAccess: false, getTranslationsCall: false, useTranslationsHook: false, any: false },
                mentions: { audio: false, translations: false } 
            };
            if (result.exists) {
                try {
                    const ts = await fetchRaw(result.path, branch);
                    checks.defaultExport = /export\s+default\s+function|export\s+default\s*\w+|export\s+default\s*\(/.test(ts);

                    // Static imports
                    const staticGetTranslationsImport = /import\s+(?:\{[^}]*\bgetTranslations\b[^}]*\}|getTranslations)\s+from\s+['"][^'"]+['"]/m.test(ts);
                    const staticGetMediaAssetsImport = /import\s+(?:\{[^}]*\bgetMediaAssets\b[^}]*\}|getMediaAssets)\s+from\s+['"][^'"]+['"]/m.test(ts);

                    // Dynamic imports / calls
                    const dynamicGetTranslationsImport = /const\s*\{\s*getTranslations\s*\}\s*=\s*await\s*import\(/m.test(ts) || /import\([^)]*getTranslations[^)]*\)/m.test(ts);
                    const callsGetTranslations = /\bgetTranslations\s*\(/m.test(ts);
                    const useTranslationsHook = /\buseTranslations\s*\(/m.test(ts);

                    // Alternate providers
                    const ctxProvidesT = /\bctx\s*\.\s*t\b/.test(ts) || /\bcontext\s*\.\s*t\b/.test(ts);
                    const paramProvidesT = /export\s+default[\s\S]{0,120}\(\s*\{[^}]*\bt\b[\s\S]*\)/m.test(ts) || /function[\s\S]{0,80}\(\s*\{[^}]*\bt\b[\s\S]*\)/m.test(ts);
                    const tAccess = /\bt\s*\[|\bt\s*\./m.test(ts);

                    const providerAny = staticGetTranslationsImport || dynamicGetTranslationsImport || callsGetTranslations || useTranslationsHook || ctxProvidesT || paramProvidesT;
                    const usesAny = tAccess || callsGetTranslations || useTranslationsHook;

                    checks.imports.getTranslations = staticGetTranslationsImport || dynamicGetTranslationsImport || callsGetTranslations;
                    checks.imports.getMediaAssets = staticGetMediaAssetsImport;
                    checks.providers = { staticGetTranslationsImport, dynamicGetTranslationsImport, useTranslationsHook, ctxProvidesT, paramProvidesT, any: providerAny };
                    checks.uses = { tAccess, getTranslationsCall: callsGetTranslations, useTranslationsHook, any: usesAny };

                    checks.mentions.audio = /audio/i.test(ts);
                    checks.mentions.translations = /translation/i.test(ts) || /getTranslations/.test(ts) || tAccess;
                } catch (_) { /* ignore static check failure */ }
            }

            const payload = hadGithubIssue ? { task, branch, ...result, checks, warning: 'github_unavailable' } : { task, branch, ...result, checks };
            res.status(200).json(payload);
            return;
        }
        if (op === 'variants') {
            const task = (req.query.task || '').toString();
            const branch = (req.query.branch || 'main').toString();
            if (!task) {
                res.status(400).json({ error: 'Missing task parameter' });
                return;
            }
            try {
                const { variants, languages } = await getVariantLanguages(task, branch);
                res.status(200).json({ task, branch, variants, languages });
            } catch (error) {
                res.status(200).json({ task, branch, variants: [], languages: [], warning: 'github_unavailable' });
            }
            return;
        }
        res.status(400).json({ error: 'Unknown op. Use op=branches or op=timeline' });
    } catch (error) {
        res.status(500).json({ error: 'core-tasks API error', details: error.message });
    }
}


