const CrowdinOtaClient = require('@crowdin/ota-client').default;
const unzipper = require('unzipper');

let otaClientSingleton = null;
let bundleCache = null;

const CROWDIN_API_BASE = 'https://api.crowdin.com/api/v2';
const BUNDLE_CACHE_MS = 24 * 60 * 60 * 1000;

function getDistributionHash() {
  const distributionHash = String(process.env.CROWDIN_DISTRIBUTION_HASH || '').trim();
  return distributionHash;
}

function getCrowdinApiToken() {
  return String(process.env.CROWDIN_API_TOKEN || '').trim();
}

function getCrowdinProjectId() {
  return String(process.env.LEVANTE_TRANSLATIONS_PROJECT_ID || '756721').trim();
}

function getProviderMode() {
  if (getDistributionHash()) return 'ota';
  if (getCrowdinApiToken()) return 'api-token';
  throw new Error('Missing translation source config: set CROWDIN_DISTRIBUTION_HASH or CROWDIN_API_TOKEN.');
}

async function crowdinRequest(path, options = {}) {
  const token = getCrowdinApiToken();
  if (!token) {
    throw new Error('Missing required server env var: CROWDIN_API_TOKEN');
  }
  const response = await fetch(`${CROWDIN_API_BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return response;
}

async function createOrReuseBuild(projectId) {
  const buildRes = await crowdinRequest(`/projects/${projectId}/translations/builds`, {
    method: 'POST',
    body: { exportApprovedOnly: true },
  });

  if (buildRes.ok) {
    const body = await buildRes.json();
    const buildId = body?.data?.id;
    if (buildId) return buildId;
    throw new Error('Crowdin build response missing build ID.');
  }

  if (buildRes.status === 409) {
    const listRes = await crowdinRequest(`/projects/${projectId}/translations/builds?limit=10`);
    if (!listRes.ok) {
      const text = await listRes.text();
      throw new Error(`Crowdin build in progress and list failed: ${listRes.status} ${text}`);
    }
    const listBody = await listRes.json();
    const active = (listBody.data || []).find((b) => {
      const status = String(b?.data?.status || '').toLowerCase();
      return status === 'inprogress' || status === 'building';
    });
    if (active?.data?.id) return active.data.id;
  }

  const errorText = await buildRes.text();
  throw new Error(`Crowdin build failed: ${buildRes.status} ${errorText}`);
}

async function waitForBuild(projectId, buildId) {
  const maxAttempts = 28;
  const pollMs = 2000;
  for (let i = 0; i < maxAttempts; i += 1) {
    const statusRes = await crowdinRequest(`/projects/${projectId}/translations/builds/${buildId}`);
    if (!statusRes.ok) {
      const text = await statusRes.text();
      throw new Error(`Crowdin build status failed: ${statusRes.status} ${text}`);
    }
    const body = await statusRes.json();
    const status = String(body?.data?.status || '').toLowerCase();
    if (status === 'finished') return;
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`Crowdin build ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error('Crowdin build did not finish in time.');
}

async function getBuildDownloadUrl(projectId, buildId) {
  const res = await crowdinRequest(`/projects/${projectId}/translations/builds/${buildId}/download`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Crowdin build download URL failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  const url = String(body?.data?.url || '').trim();
  if (!url) throw new Error('Crowdin build download URL missing.');
  return url;
}

async function parseCrowdinZip(zipBuffer) {
  const directory = await unzipper.Open.buffer(zipBuffer);
  const perLanguage = new Map();
  const languages = new Set();
  const files = new Set();

  for (const entry of directory.files || []) {
    if (!entry || entry.type === 'Directory') continue;
    const fullPath = String(entry.path || '').trim();
    if (!fullPath || fullPath.endsWith('/')) continue;
    const segments = fullPath.split('/').filter(Boolean);
    if (segments.length < 2) continue;
    const languageCode = segments[0];
    const filePath = segments.slice(1).join('/');
    const content = (await entry.buffer()).toString('utf8');

    if (!perLanguage.has(languageCode)) perLanguage.set(languageCode, new Map());
    perLanguage.get(languageCode).set(filePath, content);
    languages.add(languageCode);
    files.add(filePath);
  }

  return {
    fetchedAt: Date.now(),
    perLanguage,
    languages: Array.from(languages.values()).sort((a, b) => a.localeCompare(b)),
    files: Array.from(files.values()).sort((a, b) => a.localeCompare(b)),
  };
}

async function ensureCrowdinBundleCache() {
  const now = Date.now();
  if (bundleCache && (now - bundleCache.fetchedAt) < BUNDLE_CACHE_MS) {
    return bundleCache;
  }

  const projectId = getCrowdinProjectId();
  const buildId = await createOrReuseBuild(projectId);
  await waitForBuild(projectId, buildId);
  const downloadUrl = await getBuildDownloadUrl(projectId, buildId);
  const zipRes = await fetch(downloadUrl);
  if (!zipRes.ok) {
    const text = await zipRes.text().catch(() => '');
    throw new Error(`Failed to download Crowdin bundle: ${zipRes.status} ${text}`);
  }
  const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
  bundleCache = await parseCrowdinZip(zipBuffer);
  return bundleCache;
}

function getOtaClient() {
  if (otaClientSingleton) return otaClientSingleton;
  const distributionHash = getDistributionHash();
  if (!distributionHash) {
    throw new Error('CROWDIN_DISTRIBUTION_HASH is not configured.');
  }
  otaClientSingleton = new CrowdinOtaClient(distributionHash);
  return otaClientSingleton;
}

function clearOtaClientCache() {
  otaClientSingleton = null;
  bundleCache = null;
}

async function listLanguages() {
  if (getProviderMode() === 'ota') {
    const client = getOtaClient();
    const languages = await client.listLanguages();
    return Array.isArray(languages) ? languages : [];
  }
  const bundle = await ensureCrowdinBundleCache();
  return bundle.languages;
}

async function listFiles() {
  if (getProviderMode() === 'ota') {
    const client = getOtaClient();
    const content = await client.getContent();
    const fileSet = new Set();
    if (content && typeof content === 'object') {
      Object.values(content).forEach((files) => {
        if (!Array.isArray(files)) return;
        files.forEach((filePath) => {
          const normalized = String(filePath || '').trim();
          if (normalized) fileSet.add(normalized);
        });
      });
    }
    return Array.from(fileSet.values()).sort((a, b) => a.localeCompare(b));
  }
  const bundle = await ensureCrowdinBundleCache();
  return bundle.files;
}

function normalizeTranslationResult(rawContent) {
  if (rawContent === null || rawContent === undefined) return '';
  if (typeof rawContent === 'string') {
    const trimmed = rawContent.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(rawContent);
      } catch (_) {
        return rawContent;
      }
    }
    return rawContent;
  }
  if (typeof rawContent === 'object') return rawContent;
  return String(rawContent);
}

async function getTranslations(languageCode, filePath) {
  const locale = String(languageCode || '').trim();
  const file = String(filePath || '').trim();
  if (!locale) throw new Error('Missing required languageCode.');
  if (!file) throw new Error('Missing required filePath.');

  if (getProviderMode() === 'ota') {
    const client = getOtaClient();
    const languageTranslations = await client.getLanguageTranslations(locale);
    const match = (Array.isArray(languageTranslations) ? languageTranslations : [])
      .find((entry) => String(entry?.file || '').trim() === file);
    return normalizeTranslationResult(match?.content ?? '');
  }

  const bundle = await ensureCrowdinBundleCache();
  const perLanguage = bundle.perLanguage.get(locale);
  const rawContent = perLanguage ? perLanguage.get(file) : '';
  return normalizeTranslationResult(rawContent ?? '');
}

function __setOtaClientForTests(mockClient) {
  otaClientSingleton = mockClient || null;
}

module.exports = {
  getOtaClient,
  clearOtaClientCache,
  listLanguages,
  listFiles,
  getTranslations,
  __setOtaClientForTests,
};
