const CrowdinOtaClient = require('@crowdin/ota-client').default;

let otaClientSingleton = null;

function getDistributionHash() {
  const distributionHash = String(process.env.CROWDIN_DISTRIBUTION_HASH || '').trim();
  if (!distributionHash) {
    throw new Error('Missing required server env var: CROWDIN_DISTRIBUTION_HASH');
  }
  return distributionHash;
}

function getOtaClient() {
  if (otaClientSingleton) return otaClientSingleton;
  otaClientSingleton = new CrowdinOtaClient(getDistributionHash());
  return otaClientSingleton;
}

function clearOtaClientCache() {
  otaClientSingleton = null;
}

async function listLanguages() {
  const client = getOtaClient();
  const languages = await client.listLanguages();
  return Array.isArray(languages) ? languages : [];
}

async function listFiles() {
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

  const client = getOtaClient();
  const languageTranslations = await client.getLanguageTranslations(locale);
  const match = (Array.isArray(languageTranslations) ? languageTranslations : [])
    .find((entry) => String(entry?.file || '').trim() === file);
  return normalizeTranslationResult(match?.content ?? '');
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
