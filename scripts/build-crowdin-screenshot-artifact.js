#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const CROWDIN_API_BASE = 'https://api.crowdin.com/api/v2';
const DEFAULT_PROJECT_ID = '756721';
const DEFAULT_BUCKET = process.env.DASHBOARD_DATA_BUCKET || 'levante-dashboard-dev';
const DEFAULT_PREFIX = process.env.CROWDIN_SCREENSHOT_ARTIFACT_PREFIX || 'pitwall/crowdin';
const DEFAULT_OBJECT = process.env.CROWDIN_SCREENSHOT_ARTIFACT_OBJECT || 'crowdin-screenshot-artifact.json';
const DEFAULT_CACHE_BUCKET = process.env.CROWDIN_SCREENSHOT_CACHE_BUCKET || 'levante-assets-draft';
const DEFAULT_CACHE_PREFIX = process.env.CROWDIN_SCREENSHOT_CACHE_PREFIX || 'screenshots';
const DEFAULT_CACHE_PUBLIC_BASE =
  process.env.CROWDIN_SCREENSHOT_CACHE_PUBLIC_BASE ||
  'https://storage.googleapis.com/levante-assets-draft';

const argv = yargs(hideBin(process.argv))
  .option('project-id', {
    type: 'string',
    default: process.env.LEVANTE_TRANSLATIONS_PROJECT_ID || DEFAULT_PROJECT_ID,
    describe: 'Crowdin project id',
  })
  .option('output-json', {
    type: 'string',
    default: 'data/validation/crowdin-screenshot-artifact.json',
    describe: 'Local output artifact path',
  })
  .option('bucket', {
    type: 'string',
    default: DEFAULT_BUCKET,
    describe: 'GCS bucket to upload artifact',
  })
  .option('prefix', {
    type: 'string',
    default: DEFAULT_PREFIX,
    describe: 'GCS object prefix/folder',
  })
  .option('object', {
    type: 'string',
    default: DEFAULT_OBJECT,
    describe: 'GCS object name for uploaded artifact',
  })
  .option('cache-bucket', {
    type: 'string',
    default: DEFAULT_CACHE_BUCKET,
    describe: 'GCS bucket for cached screenshots',
  })
  .option('cache-prefix', {
    type: 'string',
    default: DEFAULT_CACHE_PREFIX,
    describe: 'GCS prefix/folder for cached screenshots',
  })
  .option('cache-public-base', {
    type: 'string',
    default: DEFAULT_CACHE_PUBLIC_BASE,
    describe: 'Public base URL for cached screenshots',
  })
  .option('cache-concurrency', {
    type: 'number',
    default: Number(process.env.CROWDIN_SCREENSHOT_CACHE_CONCURRENCY || 6),
    describe: 'Concurrency for screenshot caching',
  })
  .option('skip-cache', {
    type: 'boolean',
    default: false,
    describe: 'Skip caching screenshots to GCS',
  })
  .option('skip-upload', {
    type: 'boolean',
    default: false,
    describe: 'Build artifact only; skip GCS upload',
  })
  .help(false)
  .parse();

function normalizePrefix(prefix) {
  if (!prefix) return '';
  return String(prefix).endsWith('/') ? String(prefix) : `${String(prefix)}/`;
}

function normalizePublicBase(value) {
  if (!value) return '';
  return String(value).replace(/\/+$/, '');
}

function guessImageExtension(url, contentType) {
  if (contentType) {
    const type = String(contentType).toLowerCase();
    if (type.includes('image/png')) return '.png';
    if (type.includes('image/jpeg') || type.includes('image/jpg')) return '.jpg';
    if (type.includes('image/webp')) return '.webp';
    if (type.includes('image/gif')) return '.gif';
  }
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname || '');
    return ext || '.png';
  } catch (_e) {
    return '.png';
  }
}

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (raw) {
    const creds = JSON.parse(raw);
    return new Storage({ credentials: creds, projectId: creds.project_id });
  }
  return new Storage();
}

async function cacheScreenshot(storage, bucketName, prefix, publicBase, screenshotId, sourceUrl) {
  if (!bucketName || !publicBase || !screenshotId || !sourceUrl) return null;
  const safePrefix = normalizePrefix(prefix);
  const bucket = storage.bucket(bucketName);
  const placeholderExt = path.extname(sourceUrl.split('?')[0] || '') || '.png';
  const objectPath = `${safePrefix}${screenshotId}${placeholderExt}`;
  const file = bucket.file(objectPath);
  const [exists] = await file.exists();
  if (exists) {
    return `${normalizePublicBase(publicBase)}/${objectPath}`;
  }

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Screenshot download failed: ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = guessImageExtension(sourceUrl, contentType);
  const finalPath = `${safePrefix}${screenshotId}${ext}`;
  const finalFile = bucket.file(finalPath);
  try {
    await finalFile.save(buffer, {
      resumable: false,
      metadata: {
        contentType: contentType || undefined,
        cacheControl: 'public, max-age=31536000, immutable',
      },
      predefinedAcl: 'publicRead',
    });
  } catch (_error) {
    await finalFile.save(buffer, {
      resumable: false,
      metadata: {
        contentType: contentType || undefined,
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });
  }
  return `${normalizePublicBase(publicBase)}/${finalPath}`;
}

async function crowdinFetchJson(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${options.method || 'GET'} ${url} failed: ${res.status} ${body}`);
  }
  return res.json();
}

async function crowdinFetchJsonOptional(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    return null;
  }
  return res.json();
}

async function fetchAllPaged(urlBuilder, token, pageSize = 500) {
  const out = [];
  let offset = 0;
  for (;;) {
    const url = urlBuilder(offset, pageSize);
    const body = await crowdinFetchJson(url, token);
    const rows = Array.isArray(body?.data) ? body.data : [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

function extractStringIdentifier(stringData) {
  return String(
    stringData?.identifier ||
    stringData?.key ||
    stringData?.context ||
    stringData?.name ||
    ''
  ).trim();
}

function extractScreenshotUrl(screenshotData) {
  return String(
    screenshotData?.thumbnailUrl ||
    screenshotData?.previewUrl ||
    screenshotData?.url ||
    screenshotData?.webUrl ||
    screenshotData?.imageUrl ||
    ''
  ).trim();
}

function normalizeItemKeys(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return [];
  const out = new Set([id, id.toLowerCase()]);
  if (id.includes('::')) {
    const tail = id.split('::').pop();
    if (tail) {
      out.add(tail);
      out.add(String(tail).toLowerCase());
    }
  }
  return Array.from(out);
}

function extractStringIdsFromRelationRows(rows) {
  const ids = new Set();
  rows.forEach((row) => {
    const data = row?.data || row || {};
    const directId = data.stringId || data.id;
    if (directId) ids.add(String(directId));

    const nestedStringId = data?.string?.id || data?.string?.data?.id || data?.string?.stringId;
    if (nestedStringId) ids.add(String(nestedStringId));
  });
  return Array.from(ids);
}

async function fetchScreenshotStringIds(projectId, screenshotId, token) {
  const base = `${CROWDIN_API_BASE}/projects/${projectId}/screenshots/${screenshotId}`;

  // Try screenshots/{id}/strings first
  try {
    const stringRows = await fetchAllPaged(
      (offset, limit) => `${base}/strings?offset=${offset}&limit=${limit}`,
      token
    );
    const ids = extractStringIdsFromRelationRows(stringRows);
    if (ids.length) return ids;
  } catch (_) {
    // Continue to fallback endpoint below
  }

  // Fallback to screenshots/{id}/tags
  const tagRows = await crowdinFetchJsonOptional(`${base}/tags?offset=0&limit=500`, token);
  const rows = Array.isArray(tagRows?.data) ? tagRows.data : [];
  return extractStringIdsFromRelationRows(rows);
}

async function mapWithConcurrency(items, limit, worker) {
  const safeLimit = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let index = 0;

  async function runOne() {
    for (;;) {
      const current = index;
      if (current >= items.length) return;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(safeLimit, items.length) }, () => runOne());
  await Promise.all(workers);
  return results;
}

async function buildArtifact() {
  const token = process.env.CROWDIN_API_TOKEN;
  if (!token) {
    throw new Error('Missing CROWDIN_API_TOKEN environment variable');
  }
  const projectId = String(argv['project-id'] || DEFAULT_PROJECT_ID);
  const generatedAt = new Date().toISOString();

  console.log(`📥 Loading Crowdin strings for project ${projectId}...`);
  const stringRows = await fetchAllPaged(
    (offset, limit) => `${CROWDIN_API_BASE}/projects/${projectId}/strings?offset=${offset}&limit=${limit}`,
    token
  );

  const stringById = new Map();
  stringRows.forEach((row) => {
    const data = row?.data || row || {};
    const id = String(data.id || '').trim();
    if (!id) return;
    const identifier = extractStringIdentifier(data);
    stringById.set(id, {
      id,
      identifier,
    });
  });
  console.log(`✅ Loaded ${stringById.size} strings`);

  console.log(`📥 Loading Crowdin screenshots for project ${projectId}...`);
  const screenshotRows = await fetchAllPaged(
    (offset, limit) => `${CROWDIN_API_BASE}/projects/${projectId}/screenshots?offset=${offset}&limit=${limit}`,
    token
  );
  console.log(`✅ Loaded ${screenshotRows.length} screenshots`);

  const byItemId = new Map();
  const relationConcurrency = Number(process.env.CROWDIN_SCREENSHOT_CONCURRENCY || 8);
  let processed = 0;

  const rowResults = await mapWithConcurrency(screenshotRows, relationConcurrency, async (row, idx) => {
    const data = row?.data || row || {};
    const screenshotId = String(data.id || '').trim();
    if (!screenshotId) return null;
    const stringIds = await fetchScreenshotStringIds(projectId, screenshotId, token);
    processed += 1;
    if (processed % 100 === 0 || processed === screenshotRows.length) {
      console.log(`   ↳ Resolved screenshot relations: ${processed}/${screenshotRows.length}`);
    }
    if (!stringIds.length) return null;

    const screenshotInfo = {
      screenshotId,
      name: String(data.name || '').trim(),
      url: extractScreenshotUrl(data),
      tagsCount: stringIds.length,
    };
    const attachments = [];
    stringIds.forEach((stringId) => {
      const stringMeta = stringById.get(String(stringId));
      const identifier = stringMeta?.identifier || '';
      if (!identifier) return;
      const itemKeys = normalizeItemKeys(identifier);
      itemKeys.forEach((itemKey) => {
        attachments.push({
          itemKey,
          data: {
            ...screenshotInfo,
            stringId: String(stringId),
            stringIdentifier: identifier,
          },
        });
      });
    });
    return attachments.length ? attachments : null;
  });

  let matchedScreenshots = 0;
  let skippedScreenshots = 0;
  rowResults.forEach((attachments) => {
    if (!attachments || !attachments.length) {
      skippedScreenshots++;
      return;
    }
    matchedScreenshots++;
    attachments.forEach((attachment) => {
      if (!byItemId.has(attachment.itemKey)) byItemId.set(attachment.itemKey, []);
      byItemId.get(attachment.itemKey).push(attachment.data);
    });
  });

  // De-dupe entries per item by screenshotId + stringId
  let entries = Array.from(byItemId.entries())
    .map(([itemId, screenshots]) => {
      const uniq = new Map();
      screenshots.forEach((shot) => {
        const key = `${shot.screenshotId}::${shot.stringId}`;
        if (!uniq.has(key)) uniq.set(key, shot);
      });
      return {
        itemId,
        screenshots: Array.from(uniq.values()),
      };
    })
    .sort((a, b) => a.itemId.localeCompare(b.itemId));

  let cachedScreenshots = 0;
  let cacheErrors = 0;
  if (!argv['skip-cache']) {
    const bucketName = String(argv['cache-bucket'] || '').trim();
    const prefix = String(argv['cache-prefix'] || '').trim();
    const publicBase = normalizePublicBase(String(argv['cache-public-base'] || '').trim());
    if (bucketName && publicBase) {
      console.log(`🖼️  Caching screenshots to gs://${bucketName}/${normalizePrefix(prefix)}...`);
      const storage = getStorageClient();
      const screenshotMap = new Map();
      entries.forEach((entry) => {
        entry.screenshots.forEach((shot) => {
          const id = String(shot.screenshotId || '').trim();
          const url = String(shot.url || '').trim();
          if (id && url && !screenshotMap.has(id)) {
            screenshotMap.set(id, url);
          }
        });
      });
      const cacheConcurrency = Number(argv['cache-concurrency'] || 6);
      const cacheIds = Array.from(screenshotMap.keys());
      const cachedById = new Map();
      await mapWithConcurrency(cacheIds, cacheConcurrency, async (id) => {
        const url = screenshotMap.get(id);
        try {
          const cachedUrl = await cacheScreenshot(storage, bucketName, prefix, publicBase, id, url);
          if (cachedUrl) {
            cachedById.set(id, cachedUrl);
            cachedScreenshots += 1;
          }
        } catch (error) {
          cacheErrors += 1;
          console.warn(`⚠️  Screenshot cache failed (${id}):`, error?.message || error);
        }
      });
      entries = entries.map((entry) => ({
        ...entry,
        screenshots: entry.screenshots.map((shot) => {
          const cachedUrl = cachedById.get(String(shot.screenshotId || '').trim());
          if (!cachedUrl) return shot;
          return {
            ...shot,
            sourceUrl: shot.url,
            cachedUrl,
            url: cachedUrl,
            cached: true,
          };
        }),
      }));
    } else {
      console.log('⚠️  Screenshot cache skipped: missing cache bucket or public base URL');
    }
  } else {
    console.log('⏭️  Skipped screenshot caching (--skip-cache)');
  }

  return {
    schemaVersion: 1,
    generatedAt,
    source: 'crowdin-screenshots',
    projectId,
    counts: {
      strings: stringById.size,
      screenshots: screenshotRows.length,
      matchedScreenshots,
      skippedScreenshots,
      itemKeys: entries.length,
      cachedScreenshots,
      cacheErrors,
    },
    entries,
  };
}

async function writeLocalArtifact(artifact, outputPath) {
  const abs = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(artifact, null, 2), 'utf8');
  return abs;
}

async function uploadArtifact(localPath) {
  const bucketName = String(argv.bucket || '').trim();
  if (!bucketName) throw new Error('Missing --bucket (or DASHBOARD_DATA_BUCKET)');
  const objectName = String(argv.object || '').trim() || DEFAULT_OBJECT;
  const prefix = normalizePrefix(argv.prefix || '');
  const destination = `${prefix}${objectName}`;

  const storage = getStorageClient();
  const bucket = storage.bucket(bucketName);
  await bucket.upload(localPath, {
    destination,
    resumable: false,
    metadata: {
      contentType: 'application/json',
      cacheControl: 'no-cache, max-age=0',
    },
  });
  console.log(`✅ Uploaded artifact to gs://${bucketName}/${destination}`);
}

async function main() {
  const artifact = await buildArtifact();
  const localPath = await writeLocalArtifact(artifact, argv['output-json']);
  console.log(`📝 Wrote artifact: ${localPath}`);
  console.log(`📊 Item keys with screenshots: ${artifact.counts.itemKeys}`);

  if (!argv['skip-upload']) {
    await uploadArtifact(localPath);
  } else {
    console.log('⏭️ Skipped upload (--skip-upload)');
  }
}

main().catch((err) => {
  console.error('❌ Crowdin screenshot artifact job failed:', err.message);
  process.exit(1);
});

