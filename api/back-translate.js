import { GoogleAuth } from 'google-auth-library';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const HF_RUNTIME_ENABLED = String(process.env.HF_BACKTRANSLATE_RUNTIME_ENABLED || '').toLowerCase() === 'true';
const HF_PYTHON_BIN = process.env.HF_PYTHON_BIN || '.venv-emb/bin/python';
const HF_TIMEOUT_MS = Number(process.env.HF_BACKTRANSLATE_TIMEOUT_MS || 180000);

async function getServiceAccountClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '';
  if (!raw || !raw.trim()) return null;
  try {
    const credentials = JSON.parse(raw);
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    return auth.getClient();
  } catch (_) {
    return null;
  }
}

async function googleTranslate({ text, from, to, req }) {
  const authHeader = req.headers.authorization;
  const envKey = process.env.GOOGLE_TRANSLATE_APIKEY;
  const bearerKey = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.replace('Bearer ', '').trim() : '';
  const apiKey = (envKey && envKey.trim()) || bearerKey || null;
  const serviceClient = await getServiceAccountClient();
  if (!serviceClient && !apiKey) {
    throw new Error('Google Translate authentication required');
  }

  const formData = new URLSearchParams();
  formData.append('q', text);
  formData.append('source', from);
  formData.append('target', to);
  formData.append('format', 'text');

  const translateUrl = serviceClient
    ? 'https://translation.googleapis.com/language/translate/v2'
    : `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (serviceClient) {
    const tokenResponse = await serviceClient.getAccessToken();
    const accessToken = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
    if (!accessToken) throw new Error('Failed to obtain service account access token');
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const response = await fetch(translateUrl, {
    method: 'POST',
    headers,
    body: formData,
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Google Translate API error: ${response.status} ${details}`);
  }
  const data = await response.json();
  const translatedText = data?.data?.translations?.[0]?.translatedText;
  if (!translatedText) throw new Error('Invalid response from Google Translate API');
  return String(translatedText);
}

async function hfTranslateToEnglish({ text, fromLang }) {
  if (!HF_RUNTIME_ENABLED) {
    throw new Error('HF runtime disabled (set HF_BACKTRANSLATE_RUNTIME_ENABLED=true to enable)');
  }

  const scriptPath = path.join(process.cwd(), 'scripts', 'hf_backtranslation.py');
  const args = [
    scriptPath,
    '--mode',
    'to-english',
    '--source-locale',
    String(fromLang || ''),
    '--text-stdin',
    '--json',
  ];
  const { stdout } = await execFileAsync(HF_PYTHON_BIN, args, {
    input: String(text || ''),
    timeout: HF_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  const data = JSON.parse(String(stdout || '{}'));
  const translatedText = String(data.translatedText || '').trim();
  if (!translatedText) throw new Error('HF back-translation produced empty response');
  return { translatedText, model: String(data.model || '') };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const provider = String(body.provider || 'google').trim().toLowerCase();
    const text = String(body.text || '').trim();
    const fromLang = String(body.fromLang || '').trim();
    const toLang = String(body.toLang || 'en').trim();
    if (!text || !fromLang || !toLang) {
      res.status(400).json({ error: 'Missing required fields: text, fromLang, toLang' });
      return;
    }

    if (provider === 'google') {
      const translatedText = await googleTranslate({ text, from: fromLang, to: toLang, req });
      res.status(200).json({
        translatedText,
        originalText: text,
        fromLanguage: fromLang,
        toLanguage: toLang,
        provider: 'google',
      });
      return;
    }

    if (provider === 'hf') {
      const hf = await hfTranslateToEnglish({ text, fromLang });
      res.status(200).json({
        translatedText: hf.translatedText,
        originalText: text,
        fromLanguage: fromLang,
        toLanguage: toLang,
        provider: 'hf',
        model: hf.model,
      });
      return;
    }

    res.status(400).json({ error: `Unsupported provider '${provider}'` });
  } catch (error) {
    res.status(500).json({
      error: 'Back-translation failed',
      details: error?.message || String(error),
    });
  }
}

