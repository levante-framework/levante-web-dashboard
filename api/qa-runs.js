/**
 * LEVANTE-QA run history (read-only, GCS-backed).
 *
 * Surfaces the QA task-runner's durable run history — which the levante-qa
 * dashboard mirrors to gs://levante-tools/levante-qa/ — so it can be viewed in
 * Pitwall without running anything locally.
 *
 *   GET /api/qa-runs                      → { runs: [...], source, gcsUri }
 *   GET /api/qa-runs?runId=<id>           → { runId, artifacts: [name, ...] }
 *   GET /api/qa-runs?runId=<id>&artifact=<name>&tail=40
 *                                         → { runId, name, lines, totalLines, truncated }
 *
 * Auth reuses the same service-account pattern as the other Pitwall GCS
 * endpoints (GCP_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS_JSON, or
 * ADC). The account only needs read access to the levante-tools bucket.
 */
import { Storage } from '@google-cloud/storage';

const BUCKET = process.env.QA_GCS_BUCKET || process.env.TOOLS_BUCKET || 'levante-tools';
const PREFIX = (process.env.QA_GCS_PREFIX || 'levante-qa').replace(/\/+$/, '');
const INDEX_OBJECT = `${PREFIX}/runs.json`;

let storageClient = null;

function getStorageClient() {
  if (storageClient !== null) return storageClient;
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  try {
    if (raw) {
      const credentials = JSON.parse(raw);
      storageClient = new Storage({ credentials, projectId: credentials.project_id });
    } else {
      storageClient = new Storage();
    }
  } catch (error) {
    console.warn('qa-runs GCS client init failed:', error?.message || error);
    storageClient = null;
  }
  return storageClient;
}

async function readIndex() {
  const storage = getStorageClient();
  if (!storage) return { runs: [], source: 'unavailable' };
  try {
    const file = storage.bucket(BUCKET).file(INDEX_OBJECT);
    const [exists] = await file.exists();
    if (!exists) return { runs: [], source: 'empty' };
    const [buf] = await file.download();
    const parsed = JSON.parse(buf.toString('utf-8'));
    const runs = Array.isArray(parsed) ? parsed : [];
    runs.sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime());
    return { runs, source: 'gcs' };
  } catch (error) {
    console.warn('qa-runs readIndex error:', error?.message || error);
    return { runs: [], source: 'error', error: error?.message || String(error) };
  }
}

async function listArtifacts(runId) {
  const storage = getStorageClient();
  if (!storage) return [];
  const prefix = `${PREFIX}/runs/${runId}/`;
  try {
    const [files] = await storage.bucket(BUCKET).getFiles({ prefix });
    return files
      .map((f) => f.name.slice(prefix.length))
      .filter((n) => n && !n.includes('/') && (n.endsWith('.jsonl') || n === 'dashboard.log'))
      .sort();
  } catch (error) {
    console.warn('qa-runs listArtifacts error:', error?.message || error);
    return [];
  }
}

async function readArtifact(runId, name, tail) {
  const storage = getStorageClient();
  if (!storage) return null;
  const safe = String(name).replace(/[/\\]/g, '');
  if (!safe.endsWith('.jsonl') && safe !== 'dashboard.log') return null;
  try {
    const [buf] = await storage.bucket(BUCKET).file(`${PREFIX}/runs/${runId}/${safe}`).download();
    const text = buf.toString('utf-8');
    const all = text.split('\n').filter((l) => l.trim().length);
    const n = Math.min(200, Math.max(1, Number(tail) || 40));
    const lines = all.slice(-n);
    return { name: safe, lines, totalLines: all.length, truncated: all.length > lines.length };
  } catch (error) {
    if (error && (error.code === 404 || error.code === '404')) return null;
    console.warn('qa-runs readArtifact error:', error?.message || error);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const runId = req.query?.runId;
    const artifact = req.query?.artifact;
    const gcsUri = `gs://${BUCKET}/${PREFIX}`;

    if (runId && artifact) {
      const data = await readArtifact(runId, artifact, req.query?.tail);
      if (!data) return res.status(404).json({ error: 'Artifact not found' });
      return res.status(200).json({ runId, ...data });
    }
    if (runId) {
      const artifacts = await listArtifacts(runId);
      return res.status(200).json({ runId, artifacts, gcsUri: `${gcsUri}/runs/${runId}/` });
    }
    const { runs, source, error } = await readIndex();
    return res.status(200).json({ runs, source, gcsUri, ...(error ? { error } : {}) });
  } catch (error) {
    console.error('qa-runs error:', error);
    return res.status(500).json({ error: 'Internal error', message: error?.message });
  }
}
