#!/usr/bin/env node

const { Storage } = require('@google-cloud/storage');
const NodeID3 = require('node-id3');
require('events').defaultMaxListeners = 50;

const DEV_BUCKET = String(process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev').trim();
const LOG_BUCKET = String(process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft').trim();
const LOG_PREFIX = 'logs/approver-audio-events/';
const ROLLUP_PREFIX = 'logs/approver-audio-rollups/';
const AUDIO_PREFIX = 'audio/';

const APPROVAL_EVENTS = new Set([
  'task_finish_item_promoted',
  'approve_single_success',
  'bulk_approve_item_success',
  'bulk_approve_task_item_staged',
  'bulk_approve_item_staged',
  'approve_single_staged'
]);

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (raw) {
    const credentials = JSON.parse(raw);
    return new Storage({ credentials, projectId: credentials.project_id });
  }
  return new Storage();
}

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  const getValue = (flag) => {
    const prefix = `${flag}=`;
    const entry = argv.find((part) => String(part).startsWith(prefix));
    return entry ? String(entry).slice(prefix.length) : '';
  };
  const langsRaw = getValue('--langs');
  const langs = langsRaw
    ? langsRaw.split(',').map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const limitRaw = getValue('--limit');
  const limit = Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0 ? Number(limitRaw) : Infinity;
  const offsetRaw = getValue('--offset');
  const offset = Number.isFinite(Number(offsetRaw)) && Number(offsetRaw) >= 0 ? Number(offsetRaw) : 0;
  return {
    apply: args.has('--apply'),
    overwrite: args.has('--overwrite'),
    rawLogs: args.has('--raw-logs'),
    langs,
    limit,
    offset
  };
}

function getAudioLangPrefixCandidates(langCode) {
  const normalized = String(langCode || '').trim().replace(/_/g, '-');
  if (!normalized) return [];
  const out = new Set([
    normalized,
    normalized.toLowerCase(),
    normalized.replace(/-/g, '_'),
    normalized.toLowerCase().replace(/-/g, '_')
  ]);
  const parts = normalized.split('-').filter(Boolean);
  if (parts.length >= 2) {
    const primary = parts[0].toLowerCase();
    const region = parts.slice(1).join('-');
    out.add(`${primary}-${region.toUpperCase()}`);
    out.add(`${primary}_${region.toUpperCase().replace(/-/g, '_')}`);
  }
  return Array.from(out).filter(Boolean);
}

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getCustomTag(list, description) {
  const target = normalizeId(description);
  if (!target) return '';
  const found = asArray(list).find((entry) => normalizeId(entry?.description) === target);
  return String(found?.value || '').trim();
}

function upsertCustomTag(list, description, value) {
  const desc = String(description || '').trim();
  const val = String(value || '').trim();
  const next = asArray(list)
    .filter(Boolean)
    .map((entry) => ({
      description: String(entry?.description || '').trim(),
      value: String(entry?.value || '').trim()
    }))
    .filter((entry) => entry.description);
  if (!desc || !val) return next;
  const idx = next.findIndex((entry) => normalizeId(entry.description) === normalizeId(desc));
  if (idx >= 0) {
    next[idx].value = val;
  } else {
    next.push({ description: desc, value: val });
  }
  return next;
}

function parseTimestamp(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : 0;
}

function parseAudioPath(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  const match = normalized.match(/^audio\/([^/]+)\/(.+?)\.mp3$/i);
  if (!match) return null;
  const language = String(match[1] || '').trim().toLowerCase();
  const rawId = String(match[2] || '').trim();
  const baseId = rawId.replace(/_v\d{3}$/i, '').toLowerCase();
  if (!language || !baseId) return null;
  return { language, baseId };
}

function buildApprovalKey(language, baseId) {
  const lang = String(language || '').trim().toLowerCase();
  const id = String(baseId || '').trim().toLowerCase();
  if (!lang || !id) return '';
  return `${lang}/${id}`;
}

function normalizeLogicalUpdated(metadata) {
  return String(
    metadata?.metadata?.logical_updated_at
    || metadata?.metadata?.original_updated_at
    || metadata?.updated
    || metadata?.timeCreated
    || ''
  ).trim();
}

async function buildApprovalMap(storage, options) {
  const bucket = storage.bucket(LOG_BUCKET);
  const map = new Map();
  const upsert = (langCode, baseId, approvalAt, approver) => {
    const key = buildApprovalKey(langCode, baseId);
    if (!key) return;
    const ts = parseTimestamp(approvalAt);
    const existing = map.get(key);
    if (!existing || ts >= existing.ts) {
      map.set(key, { ts, approvalAt, approver });
    }
  };

  const [rollupFiles] = await bucket.getFiles({ prefix: ROLLUP_PREFIX, autoPaginate: true });
  const summaryFiles = rollupFiles.filter((file) => String(file?.name || '').endsWith('/summary.json'));
  for (const file of summaryFiles) {
    try {
      const [buf] = await file.download();
      const payload = JSON.parse(buf.toString('utf8'));
      const details = Array.isArray(payload?.approvalDetails) ? payload.approvalDetails : [];
      details.forEach((entry) => {
        const langCode = String(entry?.langCode || '').trim().toLowerCase();
        if (!langCode) return;
        if (options.langs.length && !options.langs.includes(langCode)) return;
        const baseId = normalizeId(entry?.itemId || '');
        const approvalAt = String(entry?.approvalAt || '').trim();
        const approver = String(entry?.approver || '').trim();
        if (!baseId || baseId.startsWith('__') || !approvalAt || !approver) return;
        upsert(langCode, baseId, approvalAt, approver);
      });
    } catch (_) {
      // Ignore malformed rollups.
    }
  }

  if (!options.rawLogs) {
    return map;
  }

  const [files] = await bucket.getFiles({ prefix: LOG_PREFIX, autoPaginate: true });
  for (const file of files) {
    try {
      const [buf] = await file.download();
      const event = JSON.parse(buf.toString('utf8'));
      const eventType = String(event?.eventType || '').trim().toLowerCase();
      if (!APPROVAL_EVENTS.has(eventType)) continue;
      const langCode = String(event?.langCode || '').trim().toLowerCase();
      if (!langCode) continue;
      if (options.langs.length && !options.langs.includes(langCode)) continue;
      const baseId = normalizeId(event?.baseItemId || event?.itemBaseId || event?.itemId || '');
      if (!baseId || baseId.startsWith('__')) continue;
      const approvalAt = String(event?.serverTimestamp || '').trim();
      const approver = String(event?.approver || '').trim();
      if (!approvalAt || !approver) continue;
      upsert(langCode, baseId, approvalAt, approver);
    } catch (_) {
      // Ignore malformed log records.
    }
  }
  return map;
}

async function main() {
  const options = parseArgs(process.argv);
  const storage = getStorageClient();

  console.log(`Mode: ${options.apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Dev bucket: ${DEV_BUCKET}`);
  console.log(`Log bucket: ${LOG_BUCKET}`);
  if (options.langs.length) {
    console.log(`Language filter: ${options.langs.join(', ')}`);
  }
  console.log(`Use raw log fallback: ${options.rawLogs ? 'yes' : 'no (rollups only)'}`);
  if (Number.isFinite(options.limit)) {
    console.log(`Limit: ${options.limit}`);
  }
  if (options.offset > 0) {
    console.log(`Offset: ${options.offset}`);
  }

  const approvalMap = await buildApprovalMap(storage, options);
  console.log(`Loaded approval log keys: ${approvalMap.size}`);

  const devBucket = storage.bucket(DEV_BUCKET);
  const collectFilesForPrefix = async (prefix) => {
    const [files] = await devBucket.getFiles({ prefix, autoPaginate: true });
    return files || [];
  };
  const files = options.langs.length
    ? (
      await Promise.all(
        options.langs
          .flatMap((lang) => getAudioLangPrefixCandidates(lang))
          .map((langPrefix) => collectFilesForPrefix(`${AUDIO_PREFIX}${langPrefix}/`))
      )
    ).flat()
    : await collectFilesForPrefix(AUDIO_PREFIX);
  const mp3Files = Array.from(
    new Map(
      files
        .filter((file) => String(file?.name || '').toLowerCase().endsWith('.mp3'))
        .map((file) => [String(file?.name || ''), file])
    ).values()
  );
  console.log(`Dev audio files discovered: ${mp3Files.length}`);

  let scanned = 0;
  let withLogs = 0;
  let noLogs = 0;
  let updatedId3 = 0;
  let updatedMetadataOnly = 0;
  let unchanged = 0;
  let failed = 0;

  for (let idx = options.offset; idx < mp3Files.length; idx += 1) {
    if (scanned >= options.limit) break;
    const file = mp3Files[idx];
    scanned += 1;
    const parsed = parseAudioPath(file.name);
    if (!parsed) continue;
    if (options.langs.length && !options.langs.includes(parsed.language)) continue;
    const key = buildApprovalKey(parsed.language, parsed.baseId);
    const approval = approvalMap.get(key);
    if (!approval) {
      noLogs += 1;
      continue;
    }
    withLogs += 1;

    try {
      if (scanned % 200 === 0) {
        console.log(`Progress: scanned ${scanned} files, updated ${updatedId3}, metadata-only ${updatedMetadataOnly}, failed ${failed}`);
      }
      const [metadata] = await file.getMetadata();
      const [buffer] = await file.download();
      const tags = NodeID3.read(buffer) || {};
      const beforeApprovedBy = getCustomTag(tags.userDefinedText, 'approved_by');
      const beforeApprovedAt = getCustomTag(tags.userDefinedText, 'approved_at');

      const nextApprovedBy = approval.approver;
      const nextApprovedAt = approval.approvalAt;
      const shouldWriteId3 = options.overwrite
        ? (beforeApprovedBy !== nextApprovedBy || beforeApprovedAt !== nextApprovedAt)
        : (!beforeApprovedBy || !beforeApprovedAt);

      const preservedLogicalUpdated = normalizeLogicalUpdated(metadata);
      const customMetadata = { ...(metadata?.metadata || {}) };
      const nextLogicalUpdated = preservedLogicalUpdated || String(metadata?.updated || metadata?.timeCreated || '').trim();
      if (nextLogicalUpdated) customMetadata.logical_updated_at = nextLogicalUpdated;
      if (!customMetadata.original_updated_at && nextLogicalUpdated) customMetadata.original_updated_at = nextLogicalUpdated;
      customMetadata.logical_approved_at = nextApprovedAt;
      customMetadata.approved_at = nextApprovedAt;
      customMetadata.approved_by = nextApprovedBy;

      if (!shouldWriteId3) {
        if (options.apply) {
          await file.setMetadata({ metadata: customMetadata });
        }
        updatedMetadataOnly += 1;
        continue;
      }

      const nextUserDefinedText = upsertCustomTag(
        upsertCustomTag(tags.userDefinedText, 'approved_by', nextApprovedBy),
        'approved_at',
        nextApprovedAt
      );
      const updatedBuffer = NodeID3.update({ userDefinedText: nextUserDefinedText }, buffer);
      if (!Buffer.isBuffer(updatedBuffer)) {
        throw new Error('ID3 update returned invalid buffer');
      }

      if (options.apply) {
        await file.save(updatedBuffer, {
          contentType: 'audio/mpeg',
          resumable: false
        });
        await file.setMetadata({ metadata: customMetadata });
      }
      updatedId3 += 1;
    } catch (error) {
      failed += 1;
      console.warn(`Failed to process ${file.name}: ${error?.message || error}`);
    }
  }

  unchanged = withLogs - updatedId3 - updatedMetadataOnly - failed;
  if (unchanged < 0) unchanged = 0;

  console.log('--- Backfill summary ---');
  console.log(`Scanned audio files: ${scanned}`);
  console.log(`Files with approval logs: ${withLogs}`);
  console.log(`Files without logs: ${noLogs}`);
  console.log(`ID3 updated (approved_by/approved_at): ${updatedId3}`);
  console.log(`Metadata-only updates: ${updatedMetadataOnly}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Failed: ${failed}`);
}

main().catch((error) => {
  console.error('Backfill failed:', error);
  process.exit(1);
});
