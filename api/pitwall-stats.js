import fs from 'fs';
import path from 'path';
import { Storage } from '@google-cloud/storage';

const DEV_BUCKET = process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev';
const DRAFT_BUCKET = process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';
const VISUAL_PREFIX = 'visual/';
const AUDIO_PREFIX = 'audio/';

const DATA_BUCKET = process.env.DASHBOARD_DATA_BUCKET || 'levante-dashboard-dev';
const COVERAGE_SUMMARY_PREFIX = process.env.AUDIO_COVERAGE_SUMMARY_PREFIX || 'pitwall/audio-coverage-summary';

let storageClient = null;

function getStorageClient() {
  if (storageClient !== null) return storageClient;
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  try {
    if (raw) {
      const creds = JSON.parse(raw);
      storageClient = new Storage({ credentials: creds, projectId: creds.project_id });
    } else {
      storageClient = new Storage();
    }
  } catch (error) {
    console.warn('GCS client init failed:', error.message);
    storageClient = null;
  }
  return storageClient;
}

function sanitizeBucketName(name) {
  return (name || '').toString().trim().replace(/[^a-zA-Z0-9._-]+/g, '_') || 'default';
}

function getCoverageSummaryPath(bucketName) {
  const prefix = COVERAGE_SUMMARY_PREFIX.endsWith('/') ? COVERAGE_SUMMARY_PREFIX : `${COVERAGE_SUMMARY_PREFIX}/`;
  return `${prefix}${sanitizeBucketName(bucketName)}.json`;
}

async function readCachedCoverageSummary(bucketName) {
  try {
    const storage = getStorageClient();
    if (!storage) return null;
    const bucket = storage.bucket(DATA_BUCKET);
    const file = bucket.file(getCoverageSummaryPath(bucketName));
    const [exists] = await file.exists();
    if (!exists) return null;
    const [contents] = await file.download();
    return JSON.parse(contents.toString('utf8')) || null;
  } catch (error) {
    console.warn('readCachedCoverageSummary error:', error.message);
    return null;
  }
}

function removeVersionSuffix(fileName) {
  if (!fileName) return fileName;
  const withoutExt = fileName.replace(/\.mp3$/i, '');
  const match = withoutExt.match(/^(.*)_v\d{3}$/i);
  return match ? match[1] : withoutExt;
}

async function countDraftAudio() {
  try {
    const storage = getStorageClient();
    if (!storage) {
      return { totalFiles: 0, uniqueItems: 0, message: 'Draft bucket credentials not configured.' };
    }

    const bucket = storage.bucket(DRAFT_BUCKET);
    const [files] = await bucket.getFiles({ prefix: AUDIO_PREFIX, autoPaginate: true });
    const mp3Files = files.filter(f => f.name && f.name.toLowerCase().endsWith('.mp3'));
    const uniqueRoots = new Set();
    for (const file of mp3Files) {
      const parts = file.name.split('/');
      const fileName = parts[parts.length - 1];
      uniqueRoots.add(`${parts[1] || ''}/${removeVersionSuffix(fileName)}`);
    }

    return {
      totalFiles: mp3Files.length,
      uniqueItems: uniqueRoots.size
    };
  } catch (error) {
    console.warn('countDraftAudio error:', error.message);
    return { totalFiles: 0, uniqueItems: 0, message: error.message };
  }
}

function countRepoAudio() {
  const repoDir = path.join(process.cwd(), 'audio_files');
  let total = 0;
  try {
    const languages = fs.readdirSync(repoDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const langDir of languages) {
      const langPath = path.join(repoDir, langDir.name);
      const files = fs.readdirSync(langPath, { withFileTypes: true });
      total += files.filter(f => f.isFile() && f.name.toLowerCase().endsWith('.mp3')).length;
    }
    return total;
  } catch (error) {
    console.warn('countRepoAudio error:', error.message);
    return 0;
  }
}


async function computeAudioCoverage() {
  const cached = await readCachedCoverageSummary(DEV_BUCKET);

  if (cached && typeof cached.availableCount === 'number') {
    const expected = Number.isFinite(cached.expectedCount) ? cached.expectedCount : countRepoAudio();
    const available = cached.availableCount;
    const noTagCount = Number.isFinite(cached.noTagCount) ? cached.noTagCount : 0;
    const missingCount = Number.isFinite(cached.missingCount) ? cached.missingCount : Math.max(expected - available, 0);
    const percent = Number.isFinite(cached.coveragePercent)
      ? Math.min(100, cached.coveragePercent)
      : (expected > 0 ? Math.min(100, Math.round((available / expected) * 1000) / 10) : 0);

    return {
      repoTotal: expected,
      bucketTotal: available,
      percent,
      missingCount,
      noTagCount,
      message: cached.generatedAt ? `Cached ${cached.generatedAt}` : 'Using cached coverage summary (refresh from Audio Coverage to update)',
      cached: true,
      sourceBucket: cached.bucket || DEV_BUCKET
    };
  }

  return {
    repoTotal: null,
    bucketTotal: null,
    percent: null,
    missingCount: null,
    noTagCount: null,
    message: 'Awaiting audio coverage summary. Open Audio Coverage to generate the latest snapshot.',
    cached: false,
    pending: true,
    sourceBucket: DEV_BUCKET
  };
}

async function countVisualPending() {
  try {
    const storage = getStorageClient();
    if (!storage) {
      return { pending: 0, message: 'Visual bucket credentials not configured.' };
    }

    const bucket = storage.bucket(DEV_BUCKET);
    const [files] = await bucket.getFiles({ prefix: VISUAL_PREFIX, autoPaginate: true });
    const names = files.map(f => f.name);
    const nameSet = new Set(names.map(n => n.toLowerCase()));
    const pngs = names.filter(n => n.toLowerCase().endsWith('.png'));
    const missing = [];

    for (const png of pngs) {
      const expectedWebp = png.replace(/\.png$/i, '.webp').toLowerCase();
      if (!nameSet.has(expectedWebp)) {
        missing.push(png);
      }
    }

    return { pending: missing.length };
  } catch (error) {
    console.warn('countVisualPending error:', error.message);
    return { pending: 0, message: error.message };
  }
}

async function fetchGithubIssueSummary() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { p0: 0, p1: 0, message: 'Missing GITHUB_TOKEN' };
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Levante-Pitwall',
    'Authorization': `Bearer ${token}`
  };

  const query = {
    query: `
      query {
        organization(login: "levante-framework") {
          projectV2(number: 1) {
            items(first: 100) {
              nodes {
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2SingleSelectField { name } }
                    }
                  }
                }
                content {
                  __typename
                  ... on Issue { state }
                  ... on PullRequest { state }
                }
              }
            }
          }
        }
      }
    `
  };

  try {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify(query)
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn('GitHub GraphQL error:', response.status, text);
      return { p0: 0, p1: 0, message: `GitHub API error: ${response.status}` };
    }

    const data = await response.json();
    const project = data?.data?.organization?.projectV2;
    if (!project) {
      return { p0: 0, p1: 0, message: 'Project data unavailable' };
    }

    let p0 = 0;
    let p1 = 0;

    for (const item of project.items.nodes) {
      const content = item.content;
      if (!content || content.state !== 'OPEN') continue;

      let priority = null;
      for (const fieldValue of item.fieldValues.nodes) {
        if (fieldValue?.field?.name?.toLowerCase().includes('priority')) {
          priority = fieldValue.name;
          break;
        }
      }

      if (priority === 'P0') p0 += 1;
      else if (priority === 'P1') p1 += 1;
    }

    return { p0, p1 };
  } catch (error) {
    console.warn('fetchGithubIssueSummary error:', error.message);
    return { p0: 0, p1: 0, message: error.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const [draftSummary, coverageSummary, visualSummary, githubSummary] = await Promise.all([
      countDraftAudio(),
      computeAudioCoverage(),
      countVisualPending(),
      fetchGithubIssueSummary()
    ]);

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      draftsAwaitingApproval: draftSummary,
      audioCoverage: coverageSummary,
      visualAssets: visualSummary,
      githubIssues: githubSummary
    });
  } catch (error) {
    console.error('pitwall-stats error:', error);
    res.status(500).json({ error: 'Internal error', message: error.message });
  }
}
