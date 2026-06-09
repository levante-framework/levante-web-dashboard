#!/usr/bin/env node

const { Storage } = require('@google-cloud/storage');

const LOG_PREFIX = 'logs/approver-audio-events';
const ROLLUP_PREFIX = 'logs/approver-audio-rollups';
const ROLLUP_SCHEMA_VERSION = 2;
const DEFAULT_BUCKET = String(process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft').trim();

function parseIsoDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts);
}

function normalizeText(value, limit = 4000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeKeyParts(event) {
  const itemId = String(event?.itemId || '').trim();
  const langCode = String(event?.langCode || '').trim().toLowerCase();
  const approver = String(event?.approver || '').trim().toLowerCase();
  return { itemId, langCode, approver };
}

function isApprovalEvent(type) {
  return type === 'save_success'
    || type === 'approve_single_success'
    || type === 'bulk_approve_item_success'
    || type === 'task_finish_item_promoted';
}

function dayToParts(dayUtc) {
  const [yyyy, mm, dd] = String(dayUtc || '').split('-');
  if (!/^\d{4}$/.test(yyyy || '')) return null;
  if (!/^\d{2}$/.test(mm || '')) return null;
  if (!/^\d{2}$/.test(dd || '')) return null;
  return { yyyy, mm, dd };
}

function extractDayFromPath(path, basePrefix) {
  const prefix = `${String(basePrefix || '').replace(/\/+$/, '')}/`;
  const raw = String(path || '');
  if (!raw.startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length);
  const parts = rest.split('/');
  if (parts.length < 3) return null;
  const [yyyy, mm, dd] = parts;
  if (!/^\d{4}$/.test(yyyy || '')) return null;
  if (!/^\d{2}$/.test(mm || '')) return null;
  if (!/^\d{2}$/.test(dd || '')) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function rawDayPrefix(dayUtc) {
  const parts = dayToParts(dayUtc);
  if (!parts) return null;
  return `${LOG_PREFIX}/${parts.yyyy}/${parts.mm}/${parts.dd}/`;
}

function rollupSummaryPath(dayUtc) {
  const parts = dayToParts(dayUtc);
  if (!parts) return null;
  return `${ROLLUP_PREFIX}/${parts.yyyy}/${parts.mm}/${parts.dd}/summary.json`;
}

function buildApprovalDetails(approvalEvent, priorRegens) {
  const priorEnhanced = priorRegens.filter((regen) => regen.usedAudioEnhancedText === true);
  const priorEnhancedChanged = priorEnhanced.filter((regen) => regen.enhancedTextChanged === true);
  const latestPriorEnhanced = priorEnhanced.length ? priorEnhanced[priorEnhanced.length - 1] : null;
  const latestPriorEnhancedChanged = priorEnhancedChanged.length ? priorEnhancedChanged[priorEnhancedChanged.length - 1] : null;

  return {
    hadPriorRegen: priorRegens.length > 0,
    regensBeforeApproval: priorRegens.length,
    hadPriorEnhancedRegen: priorEnhanced.length > 0,
    hadPriorEnhancedChanged: priorEnhancedChanged.length > 0,
    priorEnhancedRegenCount: priorEnhanced.length,
    latestPriorEnhanced: latestPriorEnhanced
      ? {
          regenerateAt: latestPriorEnhanced.serverTimestamp,
          originalTranslation: normalizeText(latestPriorEnhanced.originalTranslation),
          audioEnhancedText: normalizeText(latestPriorEnhanced.audioEnhancedText),
          enhancedTextChanged: latestPriorEnhanced.enhancedTextChanged === true,
          enhancedTextCharDelta: Number.isFinite(Number(latestPriorEnhanced.enhancedTextCharDelta))
            ? Number(latestPriorEnhanced.enhancedTextCharDelta)
            : null
        }
      : null,
    latestPriorEnhancedChanged: latestPriorEnhancedChanged
      ? {
          regenerateAt: latestPriorEnhancedChanged.serverTimestamp,
          originalTranslation: normalizeText(latestPriorEnhancedChanged.originalTranslation),
          audioEnhancedText: normalizeText(latestPriorEnhancedChanged.audioEnhancedText),
          enhancedTextCharDelta: Number.isFinite(Number(latestPriorEnhancedChanged.enhancedTextCharDelta))
            ? Number(latestPriorEnhancedChanged.enhancedTextCharDelta)
            : null
        }
      : null
  };
}

function buildRollupFromEvents(rawEvents) {
  const byLanguage = new Map();
  const regenHistoryByKey = new Map();
  const approvalDetails = [];

  const ensureLanguageSummary = (langCodeRaw) => {
    const langCode = String(langCodeRaw || '').trim() || 'unknown';
    if (!byLanguage.has(langCode)) {
      byLanguage.set(langCode, {
        language: langCode,
        approvalsTotal: 0,
        approvedAsIs: 0,
        approvalsWithPriorRegen: 0,
        approvalsWithPriorEnhanced: 0,
        approvalsWithPriorEnhancedChanged: 0,
        regensBeforeApprovalsTotal: 0
      });
    }
    return byLanguage.get(langCode);
  };

  for (const event of rawEvents) {
    const eventType = event.eventType;
    const { itemId, langCode, approver } = normalizeKeyParts(event);
    const key = `${langCode}::${itemId}::${approver}`;

    if (eventType === 'regenerate_success') {
      if (!regenHistoryByKey.has(key)) regenHistoryByKey.set(key, []);
      regenHistoryByKey.get(key).push(event);
      continue;
    }
    if (!isApprovalEvent(eventType)) continue;

    const summary = ensureLanguageSummary(langCode || event.langCode);
    summary.approvalsTotal += 1;

    const priorRegens = regenHistoryByKey.get(key) || [];
    const details = buildApprovalDetails(event, priorRegens);
    if (details.hadPriorRegen) {
      summary.approvalsWithPriorRegen += 1;
      summary.regensBeforeApprovalsTotal += details.regensBeforeApproval;
    } else {
      summary.approvedAsIs += 1;
    }
    if (details.hadPriorEnhancedRegen) summary.approvalsWithPriorEnhanced += 1;
    if (details.hadPriorEnhancedChanged) summary.approvalsWithPriorEnhancedChanged += 1;

    approvalDetails.push({
      approvalType: eventType,
      itemId,
      langCode: event.langCode || langCode,
      approver: event.approver || approver,
      approvalAt: event.serverTimestamp,
      task: String(event.task || '').trim(),
      ...details
    });
  }

  const summaryByLanguage = Array.from(byLanguage.values())
    .map((row) => ({
      ...row,
      avgRegensBeforeApproval: row.approvalsWithPriorRegen > 0
        ? Number((row.regensBeforeApprovalsTotal / row.approvalsWithPriorRegen).toFixed(2))
        : 0
    }))
    .sort((a, b) => String(a.language).localeCompare(String(b.language)));

  const totals = summaryByLanguage.reduce((acc, row) => {
    acc.approvalsTotal += row.approvalsTotal;
    acc.approvedAsIs += row.approvedAsIs;
    acc.approvalsWithPriorRegen += row.approvalsWithPriorRegen;
    acc.approvalsWithPriorEnhanced += row.approvalsWithPriorEnhanced;
    acc.approvalsWithPriorEnhancedChanged += row.approvalsWithPriorEnhancedChanged;
    acc.regensBeforeApprovalsTotal += row.regensBeforeApprovalsTotal;
    return acc;
  }, {
    approvalsTotal: 0,
    approvedAsIs: 0,
    approvalsWithPriorRegen: 0,
    approvalsWithPriorEnhanced: 0,
    approvalsWithPriorEnhancedChanged: 0,
    regensBeforeApprovalsTotal: 0
  });
  totals.avgRegensBeforeApproval = totals.approvalsWithPriorRegen > 0
    ? Number((totals.regensBeforeApprovalsTotal / totals.approvalsWithPriorRegen).toFixed(2))
    : 0;

  approvalDetails.sort((a, b) => (Date.parse(b.approvalAt || '') || 0) - (Date.parse(a.approvalAt || '') || 0));
  return { eventsScanned: rawEvents.length, totals, summaryByLanguage, approvalDetails };
}

async function listFiles(bucket, prefix) {
  const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
  return files || [];
}

async function readRawEventsFromFiles(files) {
  const rawEvents = [];
  for (const file of files) {
    try {
      const [content] = await file.download();
      const parsed = JSON.parse(content.toString('utf8'));
      const eventType = String(parsed?.eventType || '').trim();
      const serverTimestampRaw = String(parsed?.serverTimestamp || '').trim();
      const serverDate = parseIsoDate(serverTimestampRaw);
      if (!eventType || !serverDate) continue;
      rawEvents.push({
        ...parsed,
        eventType,
        serverTimestamp: serverTimestampRaw,
        _serverDateMs: serverDate.getTime()
      });
    } catch {}
  }
  rawEvents.sort((a, b) => a._serverDateMs - b._serverDateMs);
  return rawEvents;
}

async function main() {
  const storage = (() => {
    const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GCP_SERVICE_ACCOUNT_JSON;
    if (!json) return new Storage();
    const credentials = JSON.parse(json);
    return new Storage({ credentials, projectId: credentials.project_id });
  })();

  const bucketName = String(process.env.BUCKET || DEFAULT_BUCKET || 'levante-assets-draft').trim();
  const bucket = storage.bucket(bucketName);
  const [rawFiles, rollupFiles] = await Promise.all([
    listFiles(bucket, `${LOG_PREFIX}/`),
    listFiles(bucket, `${ROLLUP_PREFIX}/`)
  ]);

  const days = new Set();
  for (const f of rawFiles) {
    const d = extractDayFromPath(f.name, LOG_PREFIX);
    if (d) days.add(d);
  }
  const existingRollupDay = new Map();
  for (const f of rollupFiles) {
    const d = extractDayFromPath(f.name, ROLLUP_PREFIX);
    if (d && f.name.endsWith('/summary.json')) existingRollupDay.set(d, f.name);
  }

  const today = new Date().toISOString().slice(0, 10);
  const allDays = Array.from(days).sort((a, b) => a.localeCompare(b)).filter((d) => d < today);

  let rebuilt = 0;
  let skipped = 0;
  for (const day of allDays) {
    const summaryPath = rollupSummaryPath(day);
    let shouldBuild = true;
    if (existingRollupDay.has(day) && summaryPath) {
      try {
        const [content] = await bucket.file(summaryPath).download();
        const parsed = JSON.parse(content.toString('utf8'));
        if (Number(parsed?.schemaVersion || 1) === ROLLUP_SCHEMA_VERSION) {
          shouldBuild = false;
          skipped += 1;
        }
      } catch {}
    }
    if (!shouldBuild) continue;

    const prefix = rawDayPrefix(day);
    const files = prefix ? await listFiles(bucket, prefix) : [];
    const rawEvents = await readRawEventsFromFiles(files);
    const rollup = buildRollupFromEvents(rawEvents);
    await bucket.file(summaryPath).save(JSON.stringify({
      ...rollup,
      schemaVersion: ROLLUP_SCHEMA_VERSION,
      dayUtc: day,
      source: 'raw-daily-compaction',
      compactedAt: new Date().toISOString()
    }, null, 2), {
      contentType: 'application/json',
      resumable: false
    });
    rebuilt += 1;
    process.stdout.write(`Rebuilt ${day} (${rebuilt}/${allDays.length})\n`);
  }

  console.log(JSON.stringify({
    bucket: bucketName,
    totalHistoricalDays: allDays.length,
    rebuilt,
    skipped
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
