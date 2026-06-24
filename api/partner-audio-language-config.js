import { Storage } from '@google-cloud/storage';
import { getStorageClientFromEnv } from './lib/gcp-credentials.js';
import { loadLanguageConfigLanguages } from './lib/partner-audio-language-config.js';

const PUBLIC_LANGUAGE_CONFIG_URL = 'https://storage.googleapis.com/levante-assets-dev/language_config.json';

let storageClient = null;

function getStorageClient() {
  if (storageClient) return storageClient;
  storageClient = getStorageClientFromEnv(Storage);
  return storageClient;
}

function stripApproverPasswords(languages) {
  const input = languages && typeof languages === 'object' ? languages : {};
  const redacted = {};
  Object.entries(input).forEach(([name, cfgRaw]) => {
    const cfg = cfgRaw && typeof cfgRaw === 'object' ? { ...cfgRaw } : {};
    delete cfg.approver1_password;
    delete cfg.approver2_password;
    redacted[name] = cfg;
  });
  return redacted;
}

async function fetchPublicLanguageConfig() {
  const response = await fetch(PUBLIC_LANGUAGE_CONFIG_URL, { cache: 'no-store' });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data?.languages || typeof data.languages !== 'object') return null;
  return stripApproverPasswords(data.languages);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'method_not_allowed' });

  try {
    let languages = null;
    let source = 'gcs';

    try {
      const storage = getStorageClient();
      if (storage) {
        languages = await loadLanguageConfigLanguages(storage);
      }
    } catch (error) {
      console.warn('partner-audio-language-config GCS warning:', error?.message || error);
    }

    if (!languages || Object.keys(languages).length === 0) {
      languages = await fetchPublicLanguageConfig();
      source = 'public_url';
    }

    if (!languages || Object.keys(languages).length === 0) {
      return res.status(200).json({ success: false, languages: null, error: 'no_language_config' });
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json({
      success: true,
      languages: stripApproverPasswords(languages),
      source,
    });
  } catch (error) {
    console.error('partner-audio-language-config error:', error);
    return res.status(500).json({ success: false, error: error.message || 'load_failed' });
  }
}
