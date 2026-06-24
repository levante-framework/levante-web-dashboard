import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function stripEnvQuotes(value) {
  let text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  return text.trim().replace(/\\n$/g, '').replace(/\n+$/g, '');
}

/** Normalize bucket names and other env strings pulled from Vercel CLI. */
export function trimEnvValue(value, fallback = '') {
  const text = stripEnvQuotes(value);
  return text || fallback;
}

function repairInlineServiceAccountJson(text) {
  // Vercel CLI / dotenv often leave real newlines inside the private_key string,
  // which makes JSON.parse fail even though the credential content is valid.
  return String(text || '').replace(
    /("private_key"\s*:\s*")([\s\S]*?)("\s*,)/,
    (_, prefix, keyBody, suffix) => `${prefix}${keyBody.replace(/\r?\n/g, '\\n')}${suffix}`
  );
}

function parseInlineJsonCredentials(raw) {
  const trimmed = stripEnvQuotes(raw).replace(/\\n/g, '\n');
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch (firstError) {
    try {
      return JSON.parse(repairInlineServiceAccountJson(trimmed));
    } catch (_) {
      throw firstError;
    }
  }
}

function readCredentialsFile(pathValue) {
  const rawPath = stripEnvQuotes(pathValue);
  if (!rawPath) return null;
  const resolved = rawPath.startsWith('/') ? rawPath : resolve(process.cwd(), rawPath);
  if (!existsSync(resolved)) {
    throw new Error(`GCP credentials file not found: ${resolved}`);
  }
  return JSON.parse(readFileSync(resolved, 'utf8'));
}

function hasCredentialEnvVars() {
  return Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS
    || process.env.GCP_SERVICE_ACCOUNT_JSON
    || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  );
}

function tryAdcStorageClient(Storage, reason = '') {
  try {
    return new Storage();
  } catch (error) {
    const suffix = reason ? ` (${reason})` : '';
    console.warn(`gcp-credentials: ADC fallback failed${suffix}`, error);
    return null;
  }
}

export function parseGcpCredentialsFromEnv() {
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentialsPath) {
    return readCredentialsFile(credentialsPath);
  }

  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) return null;

  const trimmed = stripEnvQuotes(raw).replace(/\\n/g, '\n');
  if (trimmed.startsWith('{')) {
    return parseInlineJsonCredentials(raw);
  }

  return readCredentialsFile(trimmed);
}

export function getStorageClientFromEnv(Storage) {
  try {
    const credentials = parseGcpCredentialsFromEnv();
    if (credentials) {
      return new Storage({ credentials, projectId: credentials.project_id });
    }
    if (!hasCredentialEnvVars()) {
      return tryAdcStorageClient(Storage, 'no credential env vars set');
    }
    console.warn('gcp-credentials: credential env vars are set but could not be parsed');
    return null;
  } catch (error) {
    console.warn('gcp-credentials: failed to load credentials from env', error);
    if (!hasCredentialEnvVars()) {
      return tryAdcStorageClient(Storage, 'after env parse error');
    }
    return null;
  }
}

export function requireStorageClientFromEnv(Storage) {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON
    || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
    || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!raw) {
    throw new Error('GCP credentials not set (GCP_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS_JSON, or GOOGLE_APPLICATION_CREDENTIALS)');
  }
  try {
    const credentials = parseGcpCredentialsFromEnv();
    if (!credentials) {
      throw new Error('Could not parse GCP credentials');
    }
    return new Storage({ credentials, projectId: credentials.project_id });
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('not found')) throw error;
    throw new Error(`GCP credentials are not valid JSON and could not be read as a file path: ${message}`);
  }
}
