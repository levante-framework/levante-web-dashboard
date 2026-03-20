import { Storage } from '@google-cloud/storage';

const DEFAULT_BUCKET = String(process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft').trim();
const LOG_PREFIX = 'logs/approver-audio-events/';

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

function isApprovalEvent(type) {
  return type === 'save_success'
    || type === 'approve_single_success'
    || type === 'bulk_approve_item_success';
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  return floored >= 0 ? floored : fallback;
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

    const bucketName = String(req.query.bucket || DEFAULT_BUCKET || 'levante-assets-draft').trim();
    const sinceDays = toPositiveInt(req.query.sinceDays, 0);
    const now = new Date();
    const sinceDate = sinceDays > 0 ? new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000) : null;

    const bucket = storage.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix: LOG_PREFIX, autoPaginate: true });

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

    return res.status(200).json({
      success: true,
      bucket: bucketName,
      sinceDays,
      generatedAt: new Date().toISOString(),
      eventsScanned: rawEvents.length,
      totals,
      summaryByLanguage,
      approvalDetails
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

