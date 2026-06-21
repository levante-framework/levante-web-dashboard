import { Storage } from '@google-cloud/storage';

const DEFAULT_BUCKET = String(process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft').trim();
const LOG_PREFIX = 'logs/approver-audio-events';
const ROLLUP_PREFIX = 'logs/approver-audio-rollups';
const ROLLUP_SCHEMA_VERSION = 2;

let storageClient = null;

function getStorage() {
  if (storageClient) return storageClient;
  try {
    const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GCP_SERVICE_ACCOUNT_JSON;
    if (json) {
      const credentials = JSON.parse(json);
      storageClient = new Storage({ credentials, projectId: credentials.project_id });
      return storageClient;
    }
    storageClient = new Storage();
    return storageClient;
  } catch (error) {
    console.warn('approver-audio-report: failed to init storage client', error);
    return null;
  }
}

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

function getApprovalActor(event) {
  return String(event?.approved_by || event?.approvedBy || event?.approver || '').trim();
}

function getApprovalTimestamp(event) {
  const approvedAtRaw = String(event?.approved_at || event?.approvedAt || '').trim();
  const approvedAtDate = parseIsoDate(approvedAtRaw);
  if (approvedAtDate) return approvedAtDate.toISOString();
  const serverTimestampRaw = String(event?.serverTimestamp || '').trim();
  const serverTimestampDate = parseIsoDate(serverTimestampRaw);
  if (serverTimestampDate) return serverTimestampDate.toISOString();
  return approvedAtRaw || serverTimestampRaw || '';
}

function isApprovalEvent(type) {
  return type === 'save_success'
    || type === 'approve_single_success'
    || type === 'bulk_approve_item_success'
    // Current staged-approval workflow emits final approval at task finish.
    || type === 'task_finish_item_promoted';
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  return floored >= 0 ? floored : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeLangCode(value) {
  return String(value || '').trim().replace(/_/g, '-').toLowerCase();
}

function formatDayUtc(date) {
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dayToParts(dayUtc) {
  const [yyyy, mm, dd] = String(dayUtc || '').split('-');
  if (!/^\d{4}$/.test(yyyy || '')) return null;
  if (!/^\d{2}$/.test(mm || '')) return null;
  if (!/^\d{2}$/.test(dd || '')) return null;
  return { yyyy, mm, dd };
}

function getDayRangeForSinceDays(sinceDays, now = new Date()) {
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) return [];
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const days = [];
  for (let offset = sinceDays - 1; offset >= 0; offset -= 1) {
    const d = new Date(anchor.getTime());
    d.setUTCDate(d.getUTCDate() - offset);
    days.push(formatDayUtc(d));
  }
  return days;
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

async function fileExists(bucket, path) {
  try {
    const [exists] = await bucket.file(path).exists();
    return exists === true;
  } catch (_) {
    return false;
  }
}

async function readJsonFile(bucket, path) {
  const [content] = await bucket.file(path).download();
  return JSON.parse(content.toString('utf8'));
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

function buildRollupFromEvents(rawEvents, options = {}) {
  const langFilter = normalizeLangCode(options.langFilter || '');
  const includeDetails = options.includeDetails !== false;
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
    if (langFilter && langCode !== langFilter) continue;
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

    if (includeDetails) {
      approvalDetails.push({
        approvalType: eventType,
        itemId,
        langCode: event.langCode || langCode,
        approver: getApprovalActor(event) || approver,
        approvalAt: getApprovalTimestamp(event),
        loggedAt: String(event.serverTimestamp || '').trim(),
        task: String(event.task || '').trim(),
        ...details
      });
    }
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

  return {
    eventsScanned: rawEvents.length,
    totals,
    summaryByLanguage,
    approvalDetails
  };
}

function mergeSummaryRows(targetMap, rows = []) {
  for (const row of rows) {
    const language = String(row?.language || '').trim() || 'unknown';
    if (!targetMap.has(language)) {
      targetMap.set(language, {
        language,
        approvalsTotal: 0,
        approvedAsIs: 0,
        approvalsWithPriorRegen: 0,
        approvalsWithPriorEnhanced: 0,
        approvalsWithPriorEnhancedChanged: 0,
        regensBeforeApprovalsTotal: 0
      });
    }
    const acc = targetMap.get(language);
    acc.approvalsTotal += Number(row?.approvalsTotal || 0);
    acc.approvedAsIs += Number(row?.approvedAsIs || 0);
    acc.approvalsWithPriorRegen += Number(row?.approvalsWithPriorRegen || 0);
    acc.approvalsWithPriorEnhanced += Number(row?.approvalsWithPriorEnhanced || 0);
    acc.approvalsWithPriorEnhancedChanged += Number(row?.approvalsWithPriorEnhancedChanged || 0);
    acc.regensBeforeApprovalsTotal += Number(row?.regensBeforeApprovalsTotal || 0);
  }
}

async function listFiles(bucket, prefix) {
  const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
  return files || [];
}

async function readRawEventsFromFiles(files, sinceDate = null) {
  const rawEvents = [];
  for (const file of files) {
    try {
      const [content] = await file.download();
      const parsed = JSON.parse(content.toString('utf8'));
      const eventType = String(parsed?.eventType || '').trim();
      const serverTimestampRaw = String(parsed?.serverTimestamp || '').trim();
      const serverDate = parseIsoDate(serverTimestampRaw);
      if (!eventType || !serverDate) continue;
      if (sinceDate && serverDate < sinceDate) continue;
      rawEvents.push({
        ...parsed,
        eventType,
        serverTimestamp: serverTimestampRaw,
        _serverDateMs: serverDate.getTime(),
        _path: file.name
      });
    } catch (error) {
      console.warn(`approver-audio-report: skipping unreadable log ${file.name}:`, error?.message || error);
    }
  }
  rawEvents.sort((a, b) => a._serverDateMs - b._serverDateMs);
  return rawEvents;
}

function filterDayRollupByLang(dayRollup, langFilter, includeDetails) {
  if (!dayRollup) return null;
  const normalizedLang = normalizeLangCode(langFilter);
  const summaryByLanguage = Array.isArray(dayRollup.summaryByLanguage)
    ? dayRollup.summaryByLanguage.filter((row) => normalizeLangCode(row?.language) === normalizedLang)
    : [];
  const approvalDetails = includeDetails && Array.isArray(dayRollup.approvalDetails)
    ? dayRollup.approvalDetails.filter((row) => normalizeLangCode(row?.langCode) === normalizedLang)
    : [];
  return {
    ...dayRollup,
    summaryByLanguage,
    approvalDetails
  };
}

async function discoverAllKnownDays(bucket) {
  const days = new Set();
  const rawFiles = await listFiles(bucket, `${LOG_PREFIX}/`);
  for (const file of rawFiles) {
    const day = extractDayFromPath(file?.name, LOG_PREFIX);
    if (day) days.add(day);
  }
  const rollupFiles = await listFiles(bucket, `${ROLLUP_PREFIX}/`);
  for (const file of rollupFiles) {
    const day = extractDayFromPath(file?.name, ROLLUP_PREFIX);
    if (day) days.add(day);
  }
  return Array.from(days).sort((a, b) => a.localeCompare(b));
}

function sortDaysNewestFirst(days = []) {
  return Array.from(new Set(days.filter(Boolean))).sort((a, b) => b.localeCompare(a));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'method_not_allowed' });

  try {
    const storage = getStorage();
    if (!storage) {
      return res.status(500).json({
        success: false,
        error: 'gcs_unavailable',
        message: 'Could not initialize Google Cloud Storage client.'
      });
    }

    const requestStartedAt = Date.now();
    const bucketName = String(req.query.bucket || DEFAULT_BUCKET || 'levante-assets-draft').trim();
    const sinceDays = toPositiveInt(req.query.sinceDays, 0);
    const requestedLangFilter = normalizeLangCode(req.query.lang);
    const hasLangFilter = Boolean(requestedLangFilter);
    const includeDetails = toBoolean(req.query.includeDetails, true);
    const includeTodayRaw = toBoolean(req.query.includeTodayRaw, includeDetails || hasLangFilter);
    const rawFallback = toBoolean(req.query.rawFallback, hasLangFilter);
    const compactMissing = toBoolean(req.query.compactMissing, true);
    const effectiveCompactMissing = compactMissing && !hasLangFilter;
    const maxCompactionDaysPerRequest = Math.max(0, toPositiveInt(req.query.maxCompactionDaysPerRequest, 3));
    const dayCursor = Math.max(0, toPositiveInt(req.query.dayCursor, 0));
    const maxDaysPerRequest = Math.max(1, toPositiveInt(req.query.maxDaysPerRequest, 5));
    const maxRuntimeMs = Math.max(2000, toPositiveInt(req.query.maxRuntimeMs, 20000));
    const now = new Date();
    const sinceDate = sinceDays > 0 ? new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000) : null;
    const todayDayUtc = formatDayUtc(now);

    const bucket = storage.bucket(bucketName);
    const candidateDays = sinceDays > 0
      ? getDayRangeForSinceDays(sinceDays, now)
      : await discoverAllKnownDays(bucket);
    const daysToProcess = sortDaysNewestFirst(
      candidateDays.filter((day) => !sinceDate || (Date.parse(`${day}T00:00:00.000Z`) + (24 * 60 * 60 * 1000)) >= sinceDate.getTime())
    );
    const pagedDays = daysToProcess.slice(dayCursor, dayCursor + maxDaysPerRequest);
    let nextDayCursor = dayCursor + pagedDays.length;
    let reachedRuntimeBudget = false;
    let processedDaysCount = 0;

    const compaction = {
      ran: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      elapsedMs: 0,
      compactedDays: [],
      alreadyCompactedDays: [],
      pendingDays: [],
      failedDays: []
    };

    const combinedByLanguage = new Map();
    const approvalDetails = [];
    let eventsScanned = 0;

    for (let idx = 0; idx < pagedDays.length; idx += 1) {
      const day = pagedDays[idx];
      if ((Date.now() - requestStartedAt) >= maxRuntimeMs) {
        reachedRuntimeBudget = true;
        nextDayCursor = dayCursor + idx;
        break;
      }
      processedDaysCount += 1;
      const isHistoricalDay = day < todayDayUtc;
      const summaryPath = rollupSummaryPath(day);
      let dayRollup = null;

      if (isHistoricalDay && summaryPath && await fileExists(bucket, summaryPath)) {
        try {
          const parsedRollup = await readJsonFile(bucket, summaryPath);
          const schemaVersion = Number(parsedRollup?.schemaVersion || 1);
          if (schemaVersion === ROLLUP_SCHEMA_VERSION) {
            dayRollup = parsedRollup;
            compaction.alreadyCompactedDays.push(day);
          } else {
            dayRollup = null;
          }
        } catch (error) {
          console.warn(`approver-audio-report: failed reading rollup ${summaryPath}`, error?.message || error);
          dayRollup = null;
        }
      }

      if (isHistoricalDay && !dayRollup && effectiveCompactMissing && compaction.compactedDays.length < maxCompactionDaysPerRequest) {
        try {
          const prefix = rawDayPrefix(day);
          const files = prefix ? await listFiles(bucket, prefix) : [];
          const rawEvents = await readRawEventsFromFiles(files, null);
          dayRollup = buildRollupFromEvents(rawEvents);
          if (summaryPath) {
            await bucket.file(summaryPath).save(JSON.stringify({
              ...dayRollup,
              schemaVersion: ROLLUP_SCHEMA_VERSION,
              dayUtc: day,
              source: 'raw-daily-compaction',
              compactedAt: new Date().toISOString()
            }, null, 2), {
              contentType: 'application/json',
              resumable: false
            });
          }
          compaction.compactedDays.push(day);
          compaction.ran = true;
        } catch (error) {
          compaction.failedDays.push({ day, error: error?.message || String(error) });
          dayRollup = null;
        }
      }

      if (!dayRollup) {
        if (day === todayDayUtc && !includeTodayRaw) {
          compaction.pendingDays.push(day);
          continue;
        }

        const compactionBudgetExceeded = isHistoricalDay
          && effectiveCompactMissing
          && compaction.compactedDays.length >= maxCompactionDaysPerRequest;

        if (compactionBudgetExceeded) {
          compaction.pendingDays.push(day);
          continue;
        }

        if (isHistoricalDay && !rawFallback) {
          compaction.pendingDays.push(day);
          continue;
        }

        const prefix = rawDayPrefix(day);
        const files = prefix ? await listFiles(bucket, prefix) : [];
        const rawEvents = await readRawEventsFromFiles(files, day === todayDayUtc ? sinceDate : null);
        dayRollup = buildRollupFromEvents(rawEvents, {
          langFilter: requestedLangFilter,
          includeDetails
        });
      }

      if (dayRollup && hasLangFilter) {
        dayRollup = filterDayRollupByLang(dayRollup, requestedLangFilter, includeDetails);
      } else if (dayRollup && !includeDetails) {
        dayRollup = { ...dayRollup, approvalDetails: [] };
      }

      eventsScanned += Number(dayRollup?.eventsScanned || 0);
      mergeSummaryRows(combinedByLanguage, dayRollup?.summaryByLanguage || []);
      approvalDetails.push(...(Array.isArray(dayRollup?.approvalDetails) ? dayRollup.approvalDetails : []));
    }

    const summaryByLanguage = Array.from(combinedByLanguage.values())
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
    compaction.finishedAt = new Date().toISOString();
    compaction.elapsedMs = Date.now() - requestStartedAt;

    return res.status(200).json({
      success: true,
      bucket: bucketName,
      sinceDays,
      langFilter: requestedLangFilter || null,
      includeDetails,
      includeTodayRaw,
      rawFallback,
      dayCursor,
      maxDaysPerRequest,
      totalDaysToProcess: daysToProcess.length,
      processedDays: processedDaysCount,
      reachedRuntimeBudget,
      hasMore: nextDayCursor < daysToProcess.length,
      nextDayCursor: nextDayCursor < daysToProcess.length ? nextDayCursor : null,
      maxRuntimeMs,
      generatedAt: new Date().toISOString(),
      eventsScanned,
      compactMissing: effectiveCompactMissing,
      maxCompactionDaysPerRequest,
      totals,
      summaryByLanguage,
      approvalDetails,
      compaction
    });
  } catch (error) {
    console.error('approver-audio-report handler error', error);
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      message: error?.message || String(error)
    });
  }
}

