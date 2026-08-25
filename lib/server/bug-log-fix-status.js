const DEFAULT_OWNER = 'levante-framework';
const REPO_ALIASES = {
  dashboard: 'levante-dashboard',
  'levante-dashboard': 'levante-dashboard',
  'core-tasks': 'core-tasks',
  functions: 'levante-firebase-functions',
  'firebase-functions': 'levante-firebase-functions',
  'levante-firebase-functions': 'levante-firebase-functions',
};
const INTEGRATION_BASES = new Set(['dev', 'main', 'master']);

function getGithubToken() {
  return String(
    process.env.GITHUB_TOKEN
    || process.env.github_token
    || process.env.GH_TOKEN
    || process.env.GITHUB_AUTH_TOKEN
    || ''
  ).trim();
}

export function canonicalAssessment(assessment) {
  const key = String(assessment || '').trim().toLowerCase();
  if (key === 'real regression' || key === 'needs a fix') return 'Needs a fix';
  if (key === 'likely test artifact' || key === 'safe to ignore') return 'Safe to ignore';
  if (
    key === 'mixed (real + test artifact)'
    || key === 'mixed / noisy'
    || key === 'needs a fix (also noisy)'
  ) return 'Needs a fix (also noisy)';
  if (key === 'inconclusive' || key === 'needs more info') return 'Needs more info';
  return String(assessment || '').trim() || '—';
}

function normalizeRepo(owner, repo) {
  const ownerName = String(owner || DEFAULT_OWNER).trim() || DEFAULT_OWNER;
  const raw = String(repo || '').trim();
  const mapped = REPO_ALIASES[raw.toLowerCase()] || raw;
  return {
    owner: ownerName.toLowerCase() === 'levante-framework' ? DEFAULT_OWNER : ownerName,
    repo: mapped,
  };
}

function addRef(refs, owner, repo, number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) return;
  const resolved = normalizeRepo(owner, repo);
  if (!resolved.repo) return;
  refs.set(`${resolved.owner}/${resolved.repo}#${n}`, {
    owner: resolved.owner,
    repo: resolved.repo,
    number: n,
  });
}

export function extractGithubRefs(text, fallbackRepo = '') {
  const refs = new Map();
  const raw = String(text || '');
  const fallback = normalizeRepo(DEFAULT_OWNER, fallbackRepo);

  const urlRe = /https?:\/\/github\.com\/([^/\s)]+)\/([^/\s)]+)\/(?:pull|issues)\/(\d+)/gi;
  let match = urlRe.exec(raw);
  while (match) {
    addRef(refs, match[1], match[2], match[3]);
    match = urlRe.exec(raw);
  }

  const fullRe = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g;
  match = fullRe.exec(raw);
  while (match) {
    addRef(refs, match[1], match[2], match[3]);
    match = fullRe.exec(raw);
  }

  const aliasRe = /\b(dashboard|levante-dashboard|core-tasks|functions|firebase-functions|levante-firebase-functions)#(\d+)\b/gi;
  match = aliasRe.exec(raw);
  while (match) {
    addRef(refs, DEFAULT_OWNER, match[1], match[2]);
    match = aliasRe.exec(raw);
  }

  if (fallback.repo) {
    const prRe = /\bPR\s*#(\d+)\b/gi;
    match = prRe.exec(raw);
    while (match) {
      addRef(refs, fallback.owner, fallback.repo, match[1]);
      match = prRe.exec(raw);
    }
  }

  return Array.from(refs.values());
}

export function fallbackRepoFromText(text) {
  const match = String(text || '').match(/https?:\/\/github\.com\/([^/\s)]+)\/([^/\s)]+)/i);
  if (!match) return '';
  return normalizeRepo(match[1], match[2]).repo;
}

export function parseClosingIssueNumbers(body, defaultOwner = DEFAULT_OWNER, defaultRepo = '') {
  const refs = [];
  const raw = String(body || '');
  const re = /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?\s+(?:https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)|(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#(\d+))/gi;
  let match = re.exec(raw);
  while (match) {
    const owner = match[1] || match[4] || defaultOwner;
    const repo = match[2] || match[5] || defaultRepo;
    const number = Number(match[3] || match[6]);
    const resolved = normalizeRepo(owner, repo);
    if (resolved.repo && Number.isInteger(number) && number > 0) {
      refs.push({ owner: resolved.owner, repo: resolved.repo, number });
    }
    match = re.exec(raw);
  }
  return refs;
}

export function isIgnoredForever(issue) {
  const text = [issue?.status, issue?.statusDetail]
    .map((value) => String(value || ''))
    .join('\n');
  return /ignored forever/i.test(text);
}

export function pickViewerAssessment(baseAssessment, pulls, options = {}) {
  if (options.ignoredForever) return 'Safe to ignore';
  const base = canonicalAssessment(baseAssessment);
  if (base !== 'Needs a fix') return base;
  const list = Array.isArray(pulls) ? pulls.filter(Boolean) : [];
  const merged = list.find((pull) => pull.merged && INTEGRATION_BASES.has(String(pull.base || '').toLowerCase()));
  if (merged) return 'Fix Merged';
  const anyMerged = list.find((pull) => pull.merged);
  if (anyMerged) return 'Fix Merged';
  const open = list.find((pull) => String(pull.state || '').toLowerCase() === 'open');
  if (open) return 'Open PR';
  return base;
}

function issueCorpus(issue) {
  const followUps = Array.isArray(issue?.followUps) ? issue.followUps : [];
  return [
    issue?.github,
    issue?.status,
    issue?.statusDetail,
    issue?.actions,
    issue?.oneLiner,
    issue?.bodyMarkdown,
    ...followUps.map((item) => `${item?.title || ''}\n${item?.body || ''}`),
  ].filter(Boolean).join('\n');
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const size = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({ length: size }, run));
  return results;
}

function githubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'levante-web-dashboard-bug-log',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function toPull(owner, repo, payload) {
  if (!payload || payload.number == null) return null;
  const number = Number(payload.number);
  const closes = parseClosingIssueNumbers(payload.body, owner, repo)
    .filter((ref) => ref.owner === owner && ref.repo === repo)
    .map((ref) => ref.number);
  return {
    owner,
    repo,
    number,
    state: String(payload.state || ''),
    merged: Boolean(payload.merged),
    base: String(payload.base?.ref || ''),
    url: String(payload.html_url || `https://github.com/${owner}/${repo}/pull/${number}`),
    closes,
  };
}

async function fetchPull(ref, token, signal) {
  const url = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${encodeURIComponent(String(ref.number))}`;
  const response = await fetch(url, { headers: githubHeaders(token), signal });
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  return toPull(ref.owner, ref.repo, payload);
}

async function fetchOpenPulls(owner, repo, token, signal) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100`;
  const response = await fetch(url, { headers: githubHeaders(token), signal });
  if (!response.ok) return [];
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload)) return [];
  return payload.map((item) => toPull(owner, repo, item)).filter(Boolean);
}

function dedupePulls(list) {
  const map = new Map();
  for (const pull of (Array.isArray(list) ? list : []).filter(Boolean)) {
    map.set(`${pull.owner}/${pull.repo}#${pull.number}`, pull);
  }
  return Array.from(map.values());
}

export async function applyFixAssessments(issues, options = {}) {
  const rows = Array.isArray(issues) ? issues : [];
  const token = options.token != null ? options.token : getGithubToken();
  const fetchPullFn = options.fetchPull || fetchPull;
  const fetchOpenPullsFn = options.fetchOpenPulls || fetchOpenPulls;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;

  const unique = new Map();
  const repos = new Map();
  for (const issue of rows) {
    const corpus = issueCorpus(issue);
    const fallbackRepo = fallbackRepoFromText(issue?.github || corpus);
    for (const ref of extractGithubRefs(corpus, fallbackRepo)) {
      unique.set(`${ref.owner}/${ref.repo}#${ref.number}`, ref);
      repos.set(`${ref.owner}/${ref.repo}`, { owner: ref.owner, repo: ref.repo });
    }
  }

  const pullsByKey = new Map();
  const openByRepo = new Map();
  if (unique.size > 0 || repos.size > 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await Promise.all([
        mapPool(Array.from(unique.values()), 6, async (ref) => {
          try {
            const pull = await fetchPullFn(ref, token, controller.signal);
            if (pull) pullsByKey.set(`${ref.owner}/${ref.repo}#${ref.number}`, pull);
          } catch (_) {}
        }),
        mapPool(Array.from(repos.values()), 3, async (repoRef) => {
          try {
            const pulls = await fetchOpenPullsFn(repoRef.owner, repoRef.repo, token, controller.signal);
            openByRepo.set(`${repoRef.owner}/${repoRef.repo}`, Array.isArray(pulls) ? pulls : []);
          } catch (_) {
            openByRepo.set(`${repoRef.owner}/${repoRef.repo}`, []);
          }
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return rows.map((issue) => {
    const corpus = issueCorpus(issue);
    const fallbackRepo = fallbackRepoFromText(issue?.github || corpus);
    const refs = extractGithubRefs(corpus, fallbackRepo);
    const pulls = dedupePulls(refs.flatMap((ref) => {
      const fetched = pullsByKey.get(`${ref.owner}/${ref.repo}#${ref.number}`);
      const openPulls = openByRepo.get(`${ref.owner}/${ref.repo}`) || [];
      const linked = openPulls.filter((pull) => (
        pull.number === ref.number
        || (Array.isArray(pull.closes) && pull.closes.includes(ref.number))
      ));
      return [fetched, ...linked];
    }));
    const viewerAssessment = pickViewerAssessment(issue.assessment, pulls, {
      ignoredForever: isIgnoredForever(issue),
    });
    const fixPr = pulls.find((pull) => pull.merged) || pulls.find((pull) => pull.state === 'open') || pulls[0] || null;
    return {
      ...issue,
      viewerAssessment,
      fixPr,
    };
  });
}
