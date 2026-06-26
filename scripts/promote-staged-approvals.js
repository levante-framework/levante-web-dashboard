#!/usr/bin/env node

/**
 * Backfill approved_by/approved_at onto staged (but un-promoted) draft audio
 * from the approval logs, then promote those files to the dev bucket.
 *
 * Use this to "carry forward" items that were approved in the tool (recorded in
 * the server-side staged-approvals file) but whose task was never finished, so
 * they were never copied to -dev and never got approval ID3 tags.
 *
 * Usage:
 *   node -r dotenv/config scripts/promote-staged-approvals.js \
 *     dotenv_config_path=.env.local --langs=es-ar --task="Thoughts & Feelings"
 *
 * Add --apply to actually write/promote (default is a dry run).
 */

const { Storage } = require('@google-cloud/storage');
const NodeID3 = require('node-id3');
require('events').defaultMaxListeners = 50;

const DRAFT_BUCKET = String(process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft').trim();
const DEV_BUCKET = String(process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev').trim();
// Staged-approvals JSON lives where the server persists it (TOOLS_BUCKET in prod).
const STAGED_BUCKET = String(
  process.env.PARTNER_AUDIO_STAGED_APPROVALS_BUCKET
  || process.env.VALIDATION_BUCKET
  || process.env.TOOLS_BUCKET
  || 'levante-tools'
).trim();
const LOG_PREFIX = 'logs/approver-audio-events/';
const ROLLUP_PREFIX = 'logs/approver-audio-rollups/';
const STAGED_PREFIX = String(process.env.PARTNER_AUDIO_STAGED_APPROVALS_PREFIX || 'partner-audio/staged-approvals')
  .trim()
  .replace(/^\/+|\/+$/g, '');

const APPROVAL_EVENTS = new Set([
  'task_finish_item_promoted',
  'approve_single_success',
  'bulk_approve_item_success',
  'bulk_approve_task_item_staged',
  'bulk_approve_item_staged',
  'approve_single_staged'
]);

// Tolerant JSON parse: some env setups expand "\n" to real newlines, which is
// invalid inside JSON string literals (e.g. PEM private_key). Escape control
// characters that occur inside string literals before parsing.
function parseCredentialJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (const ch of String(raw)) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = !inStr; out += ch; continue; }
      if (inStr) {
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') { out += '\\r'; continue; }
        if (ch === '\t') { out += '\\t'; continue; }
      }
      out += ch;
    }
    return JSON.parse(out);
  }
}

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (raw) {
    const credentials = parseCredentialJson(raw);
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
  const daysRaw = getValue('--days');
  const days = Number.isFinite(Number(daysRaw)) && Number(daysRaw) > 0 ? Number(daysRaw) : 30;
  return {
    apply: args.has('--apply'),
    overwrite: args.has('--overwrite'),
    keepDraft: args.has('--keep-draft'),
    keepStaged: args.has('--keep-staged'),
    langs,
    days,
    task: getValue('--task').trim()
  };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (idx < items.length) {
      const current = idx;
      idx += 1;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function recentDayPrefixes(basePrefix, days, now = new Date()) {
  const out = [];
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let offset = 0; offset < days; offset += 1) {
    const d = new Date(anchor.getTime());
    d.setUTCDate(d.getUTCDate() - offset);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    out.push(`${basePrefix}${yyyy}/${mm}/${dd}/`);
  }
  return out;
}

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeLang(value) {
  return String(value || '').trim().replace(/_/g, '-').toLowerCase();
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

function audioLangPrefixCandidates(langCode) {
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

function baseIdFromPath(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  const match = normalized.match(/^audio\/[^/]+\/(.+?)\.mp3$/i);
  if (!match) return '';
  return String(match[1] || '').replace(/_v\d{3}$/i, '').toLowerCase();
}

function logicalUpdated(metadata) {
  return String(
    metadata?.metadata?.logical_updated_at
    || metadata?.metadata?.original_updated_at
    || metadata?.updated
    || metadata?.timeCreated
    || ''
  ).trim();
}

// Builds lang/baseId -> {approver, approvalAt} from recent raw event logs.
// Scans only the last `days` of logs and keeps only events for `targetIds`.
async function buildApprovalMap(storage, langs, targetIds, days) {
  const bucket = storage.bucket(DRAFT_BUCKET);
  const map = new Map();
  const wanted = targetIds instanceof Set ? targetIds : new Set(targetIds || []);
  const upsert = (langCode, baseId, approvalAt, approver) => {
    const key = `${normalizeLang(langCode)}/${normalizeId(baseId)}`;
    if (!key || !approvalAt) return;
    const ts = parseTimestamp(approvalAt);
    const existing = map.get(key);
    if (!existing || ts >= existing.ts) {
      map.set(key, { ts, approvalAt, approver: String(approver || '').trim() });
    }
  };

  const dayPrefixes = recentDayPrefixes(LOG_PREFIX, days);
  let scanned = 0;
  for (const prefix of dayPrefixes) {
    let files = [];
    try {
      [files] = await bucket.getFiles({ prefix, autoPaginate: true });
    } catch (_) { files = []; }
    files = (files || []).filter((f) => String(f?.name || '').toLowerCase().endsWith('.json'));
    if (!files.length) continue;
    await mapWithConcurrency(files, 25, async (file) => {
      try {
        const [buf] = await file.download();
        const event = JSON.parse(buf.toString('utf8'));
        const eventType = normalizeId(event?.eventType);
        if (!APPROVAL_EVENTS.has(eventType)) return;
        const langCode = normalizeLang(event?.langCode);
        if (!langCode || (langs.length && !langs.includes(langCode))) return;
        const baseId = normalizeId(event?.baseItemId || event?.itemBaseId || event?.itemId);
        if (!baseId || baseId.startsWith('__')) return;
        if (wanted.size && !wanted.has(baseId)) return;
        const approver = String(event?.approved_by || event?.approvedBy || event?.approver || '').trim();
        const approvalAt = String(event?.approved_at || event?.approvedAt || event?.serverTimestamp || '').trim();
        upsert(langCode, baseId, approvalAt, approver);
      } catch (_) { /* ignore malformed records */ }
    });
    scanned += files.length;
  }
  console.log(`Scanned ${scanned} raw log file(s) across last ${days} day(s).`);
  return map;
}

async function readStaged(storage, langCode) {
  const safe = normalizeLang(langCode).replace(/[^a-z0-9._-]/g, '');
  const objectPath = `${STAGED_PREFIX}/${safe}.json`;
  const file = storage.bucket(STAGED_BUCKET).file(objectPath);
  const [exists] = await file.exists();
  if (!exists) return { objectPath, tasks: {}, payload: null };
  const [buf] = await file.download();
  let payload = {};
  try { payload = JSON.parse(buf.toString('utf8')); } catch (_) { payload = {}; }
  return { objectPath, tasks: payload?.tasks || {}, payload };
}

// Find the newest draft mp3 for a base id across language path variants.
async function findNewestDraftFile(storage, langCode, baseId) {
  const bucket = storage.bucket(DRAFT_BUCKET);
  const target = normalizeId(baseId);
  let best = null;
  for (const prefixLang of audioLangPrefixCandidates(langCode)) {
    let files = [];
    try {
      [files] = await bucket.getFiles({ prefix: `audio/${prefixLang}/`, autoPaginate: true });
    } catch (_) { continue; }
    for (const file of files || []) {
      const name = String(file?.name || '');
      if (!name.toLowerCase().endsWith('.mp3')) continue;
      if (baseIdFromPath(name) !== target) continue;
      const ts = parseTimestamp(logicalUpdated(file.metadata) || file.metadata?.updated);
      if (!best || ts >= best.ts) best = { file, ts, name };
    }
  }
  return best;
}

async function promoteOne(storage, draftFile, { approver, approvedAt }, options) {
  const sourcePath = draftFile.name;
  const targetPath = sourcePath.replace(/_v\d{3}(?=\.mp3$)/i, '');
  const draftBucket = storage.bucket(DRAFT_BUCKET);
  const devBucket = storage.bucket(DEV_BUCKET);

  const [metadata] = await draftFile.getMetadata();
  const [buffer] = await draftFile.download();
  const tags = NodeID3.read(buffer) || {};
  const beforeBy = getCustomTag(tags.userDefinedText, 'approved_by');
  const beforeAt = getCustomTag(tags.userDefinedText, 'approved_at');

  const nextBy = (options.overwrite ? approver : (beforeBy || approver)) || '';
  const nextAt = (options.overwrite ? approvedAt : (beforeAt || approvedAt)) || '';

  let outBuffer = buffer;
  if (nextBy || nextAt) {
    let udt = tags.userDefinedText;
    if (nextBy) udt = upsertCustomTag(udt, 'approved_by', nextBy);
    if (nextAt) udt = upsertCustomTag(udt, 'approved_at', nextAt);
    const updated = NodeID3.update({ userDefinedText: udt }, buffer);
    if (Buffer.isBuffer(updated)) outBuffer = updated;
  }

  const preservedLogical = logicalUpdated(metadata);
  const customMetadata = { ...(metadata?.metadata || {}) };
  if (preservedLogical) {
    customMetadata.logical_updated_at = preservedLogical;
    if (!customMetadata.original_updated_at) customMetadata.original_updated_at = preservedLogical;
  }
  if (nextAt) {
    customMetadata.logical_approved_at = nextAt;
    customMetadata.approved_at = nextAt;
  }
  if (nextBy) customMetadata.approved_by = nextBy;

  if (!options.apply) {
    return { targetPath, nextBy, nextAt, wroteTags: Boolean(nextBy || nextAt) };
  }

  const devFile = devBucket.file(targetPath);
  await devFile.save(outBuffer, { contentType: 'audio/mpeg', resumable: false });
  await devFile.setMetadata({ metadata: customMetadata });

  if (!options.keepDraft) {
    const parsed = String(sourcePath).match(/^audio\/([^/]+)\/(.+?)(?:_v\d{3})?\.mp3$/i);
    const deletions = [];
    if (parsed) {
      const siblingPrefix = `audio/${parsed[1]}/${parsed[2]}`;
      const versionPattern = new RegExp(`^${siblingPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_v\\d{3}\\.mp3$`, 'i');
      let siblings = [];
      try { [siblings] = await draftBucket.getFiles({ prefix: siblingPrefix }); } catch (_) { siblings = []; }
      (siblings || []).forEach((f) => {
        const name = String(f?.name || '');
        if (!name.toLowerCase().endsWith('.mp3')) return;
        if (name === `${siblingPrefix}.mp3` || versionPattern.test(name)) {
          deletions.push(draftBucket.file(name).delete().then(() => true, () => false));
        }
      });
    } else {
      deletions.push(draftBucket.file(sourcePath).delete().then(() => true, () => false));
    }
    await Promise.all(deletions);
  }

  return { targetPath, nextBy, nextAt, wroteTags: Boolean(nextBy || nextAt) };
}

async function writeStaged(storage, objectPath, payload, tasks) {
  const file = storage.bucket(STAGED_BUCKET).file(objectPath);
  const next = {
    metadata: {
      ...(payload?.metadata || {}),
      updatedAt: new Date().toISOString(),
      taskCount: Object.keys(tasks).length
    },
    tasks
  };
  await file.save(JSON.stringify(next, null, 2), { contentType: 'application/json', resumable: false });
}

async function main() {
  const options = parseArgs(process.argv);
  if (!options.langs.length) {
    console.error('Missing --langs (e.g. --langs=es-ar)');
    process.exit(1);
  }
  const storage = getStorageClient();

  console.log(`Mode: ${options.apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Draft bucket: ${DRAFT_BUCKET}`);
  console.log(`Dev bucket: ${DEV_BUCKET}`);
  console.log(`Staged bucket: ${STAGED_BUCKET}`);
  console.log(`Languages: ${options.langs.join(', ')}`);
  if (options.task) console.log(`Task filter: ${options.task}`);
  console.log(`Delete draft after promote: ${options.keepDraft ? 'no (--keep-draft)' : 'yes'}`);
  console.log(`Clear staged after promote: ${options.keepStaged ? 'no (--keep-staged)' : 'yes'}`);
  console.log('');

  // Read staged files first so we only scan logs for the items we care about.
  const stagedByLang = new Map();
  const targetIds = new Set();
  for (const lang of options.langs) {
    const staged = await readStaged(storage, lang);
    stagedByLang.set(lang, staged);
    Object.entries(staged.tasks || {}).forEach(([taskName, ids]) => {
      if (options.task && taskName !== options.task) return;
      asArray(ids).map(normalizeId).filter(Boolean).forEach((id) => targetIds.add(id));
    });
  }
  console.log(`Target staged item ids: ${targetIds.size}`);

  const approvalMap = await buildApprovalMap(storage, options.langs, targetIds, options.days);
  console.log(`Approval log keys matched: ${approvalMap.size}\n`);

  let total = 0;
  let promoted = 0;
  let missingDraft = 0;
  let missingLog = 0;
  let failed = 0;

  for (const lang of options.langs) {
    const { objectPath, tasks, payload } = stagedByLang.get(lang);
    const taskNames = Object.keys(tasks).filter((t) => !options.task || t === options.task);
    if (!taskNames.length) {
      console.log(`[${lang}] no matching staged tasks (file: ${objectPath})`);
      continue;
    }
    const promotedByTask = {};
    for (const taskName of taskNames) {
      const ids = Array.from(new Set(asArray(tasks[taskName]).map(normalizeId).filter(Boolean)));
      console.log(`[${lang}] task "${taskName}" — ${ids.length} staged item(s)`);
      promotedByTask[taskName] = new Set();
      for (const baseId of ids) {
        total += 1;
        const best = await findNewestDraftFile(storage, lang, baseId);
        if (!best) {
          missingDraft += 1;
          console.log(`  ✗ ${baseId}: no draft audio found`);
          continue;
        }
        const approval = approvalMap.get(`${normalizeLang(lang)}/${baseId}`) || { approver: '', approvalAt: '' };
        if (!approval.approver && !approval.approvalAt) missingLog += 1;
        const approvedAt = approval.approvalAt || logicalUpdated(best.file.metadata);
        try {
          const result = await promoteOne(storage, best.file, { approver: approval.approver, approvedAt }, options);
          const logTag = approval.approver || approval.approvalAt ? 'log' : 'fallback(no log)';
          console.log(`  ${options.apply ? '✓' : '•'} ${baseId}: ${best.name} -> ${result.targetPath}`);
          console.log(`      approved_by="${result.nextBy}" approved_at="${result.nextAt}" [${logTag}]`);
          if (options.apply) {
            promoted += 1;
            promotedByTask[taskName].add(baseId);
          }
        } catch (error) {
          failed += 1;
          console.log(`  ✗ ${baseId}: ${error?.message || error}`);
        }
      }
    }

    if (options.apply && !options.keepStaged) {
      const nextTasks = {};
      Object.entries(tasks).forEach(([taskName, rawIds]) => {
        const remaining = asArray(rawIds)
          .map(normalizeId)
          .filter(Boolean)
          .filter((id) => !(promotedByTask[taskName] && promotedByTask[taskName].has(id)));
        if (remaining.length) nextTasks[taskName] = Array.from(new Set(remaining));
      });
      await writeStaged(storage, objectPath, payload, nextTasks);
      console.log(`[${lang}] staged file updated: removed promoted ids (${objectPath})`);
    }
    console.log('');
  }

  console.log('--- Summary ---');
  console.log(`Staged items processed: ${total}`);
  console.log(`Promoted to dev:        ${promoted}${options.apply ? '' : ' (dry-run: 0)'}`);
  console.log(`Missing draft audio:    ${missingDraft}`);
  console.log(`Missing approval log:   ${missingLog} (used draft timestamp fallback)`);
  console.log(`Failed:                 ${failed}`);
}

main().catch((error) => {
  console.error('promote-staged-approvals failed:', error);
  process.exit(1);
});
