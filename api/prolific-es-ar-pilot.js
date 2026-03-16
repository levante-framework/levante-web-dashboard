import fs from 'fs';
import path from 'path';
import { Storage } from '@google-cloud/storage';

const DATA_BUCKET = process.env.DASHBOARD_DATA_BUCKET || 'levante-dashboard-dev';
const SUBMISSIONS_PREFIX = process.env.PROLIFIC_ES_AR_PREFIX || 'prolific/es-ar-pilot/submissions';
const LOCAL_CSV_PATH = path.resolve(__dirname, '..', 'data', 'validation', 'prolific-study-es-AR-pilot.csv');
const ASSIGNMENT_SLOTS = 18;
const SLOT_OFFSETS = [0, 6, 12]; // 3 ratings/item when 18 slots are filled
const COMPLETION_CODE = process.env.PROLIFIC_COMPLETION_CODE || 'CCW2JO16';

let storageClient = null;
let inMemorySubmissions = [];
let cachedItems = null;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function normalizePrefix(prefix) {
  const cleaned = String(prefix || '').replace(/^\/+|\/+$/g, '');
  return `${cleaned}/`;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function sanitizeId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80) || 'unknown';
}

function hashString(input) {
  let h = 2166136261;
  const text = String(input || '');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((v) => String(v).trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  if (row.some((v) => String(v).trim() !== '')) rows.push(row);
  return rows;
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  return rows.slice(1).map((r) => {
    const out = {};
    headers.forEach((h, idx) => {
      out[h] = r[idx] == null ? '' : String(r[idx]);
    });
    return out;
  });
}

function getStorage() {
  if (storageClient) return storageClient;
  try {
    const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (raw) {
      const creds = JSON.parse(raw);
      storageClient = new Storage({ credentials: creds, projectId: creds.project_id });
    } else {
      storageClient = new Storage();
    }
  } catch (e) {
    console.warn('prolific-es-ar-pilot: failed to init storage client', e.message);
    storageClient = null;
  }
  return storageClient;
}

function loadItemsFromLocalCsv() {
  const csvText = fs.readFileSync(LOCAL_CSV_PATH, 'utf8');
  const items = rowsToObjects(parseCsv(csvText));
  return items.map((item) => ({
    study_item_id: item.study_item_id,
    item_id: item.item_id,
    lang_code: item.lang_code,
    content_type: item.content_type,
    path_prefix: item.path_prefix,
    source_en: item.source_en,
    translation_target: item.translation_target,
    instructions: item.instructions
  }));
}

function getAllItems() {
  if (cachedItems) return cachedItems;
  cachedItems = loadItemsFromLocalCsv();
  return cachedItems;
}

function pickItemsForPid(items, prolificPid) {
  if (!prolificPid) return items;
  const slot = hashString(prolificPid) % ASSIGNMENT_SLOTS;
  return items.filter((_item, idx) => {
    const base = idx % ASSIGNMENT_SLOTS;
    return SLOT_OFFSETS.some((offset) => ((base + offset) % ASSIGNMENT_SLOTS) === slot);
  });
}

async function listSubmissionObjects() {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const bucket = storage.bucket(DATA_BUCKET);
    const [files] = await bucket.getFiles({
      prefix: normalizePrefix(SUBMISSIONS_PREFIX),
      autoPaginate: true
    });
    return files.filter((f) => String(f.name || '').toLowerCase().endsWith('.json'));
  } catch (e) {
    console.warn('prolific-es-ar-pilot: list GCS files failed', e.message);
    return null;
  }
}

async function loadAllSubmissions() {
  const files = await listSubmissionObjects();
  if (!files) return inMemorySubmissions;
  const loaded = [];
  for (const file of files) {
    try {
      const [buf] = await file.download();
      const parsed = JSON.parse(buf.toString());
      loaded.push(parsed);
    } catch (e) {
      console.warn(`prolific-es-ar-pilot: failed reading ${file.name}:`, e.message);
    }
  }
  inMemorySubmissions = loaded;
  return loaded;
}

async function saveSubmission(payload) {
  const storage = getStorage();
  if (!storage) {
    inMemorySubmissions.push(payload);
    return { source: 'memory', path: null };
  }
  const bucket = storage.bucket(DATA_BUCKET);
  const name = `${normalizePrefix(SUBMISSIONS_PREFIX)}${new Date().toISOString().replace(/[:.]/g, '-')}_${sanitizeId(payload.prolific_pid)}_${sanitizeId(payload.session_id)}.json`;
  const file = bucket.file(name);
  await file.save(JSON.stringify(payload, null, 2), {
    contentType: 'application/json',
    resumable: false
  });
  inMemorySubmissions.push(payload);
  return { source: 'gcs', path: name };
}

function validateResponseEntry(entry) {
  const allowedEquivalence = new Set(['same_meaning', 'mostly_same', 'different_meaning', 'cannot_judge']);
  const allowedClarity = new Set(['1', '2', '3', '4', '5']);
  const equivalence = String(entry.equivalence_rating || '').trim();
  const clarity = String(entry.child_clarity_rating || '').trim();
  if (!entry.study_item_id || !entry.item_id) return 'Missing study_item_id/item_id';
  if (!allowedEquivalence.has(equivalence)) return `Invalid equivalence_rating for ${entry.study_item_id}`;
  if (!allowedClarity.has(clarity)) return `Invalid child_clarity_rating for ${entry.study_item_id}`;
  return null;
}

function normalizeSubmissionBody(body) {
  const prolificPid = String(body.prolific_pid || body.prolificPid || '').trim();
  const studyId = String(body.study_id || body.studyId || '').trim();
  const sessionId = String(body.session_id || body.sessionId || '').trim();
  const responses = Array.isArray(body.responses) ? body.responses : [];
  const durationSecondsRaw = Number(body.duration_seconds);
  const interactionEventsRaw = Number(body.interaction_events);
  const durationSeconds = Number.isFinite(durationSecondsRaw) ? Math.max(0, Math.round(durationSecondsRaw)) : null;
  const interactionEvents = Number.isFinite(interactionEventsRaw) ? Math.max(0, Math.round(interactionEventsRaw)) : null;
  return {
    prolific_pid: prolificPid,
    study_id: studyId,
    session_id: sessionId,
    submitted_at: new Date().toISOString(),
    completion_code: COMPLETION_CODE,
    started_at: body.started_at ? String(body.started_at) : '',
    duration_seconds: durationSeconds,
    interaction_events: interactionEvents,
    user_agent: String(body.user_agent || ''),
    responses: responses.map((r) => ({
      study_item_id: String(r.study_item_id || '').trim(),
      item_id: String(r.item_id || '').trim(),
      lang_code: String(r.lang_code || 'es-AR').trim() || 'es-AR',
      equivalence_rating: String(r.equivalence_rating || '').trim(),
      child_clarity_rating: String(r.child_clarity_rating || '').trim(),
      issue_notes: String(r.issue_notes || '').trim()
    }))
  };
}

function evaluateSubmissionQuality(submission, allItems) {
  const expectedCount = pickItemsForPid(allItems, submission.prolific_pid || '').length;
  const responseCount = Array.isArray(submission.responses) ? submission.responses.length : 0;
  const durationRaw = submission.duration_seconds;
  const durationSeconds = Number.isFinite(Number(durationRaw))
    ? Number(durationRaw)
    : null;

  const reasons = [];
  const warnings = [];

  if (!submission.prolific_pid || !submission.study_id || !submission.session_id) {
    reasons.push('missing_required_ids');
  }
  if (responseCount !== expectedCount) {
    reasons.push(`response_count_mismatch:${responseCount}/${expectedCount}`);
  }
  const uniqueIds = new Set((submission.responses || []).map((r) => r.study_item_id).filter(Boolean));
  if (uniqueIds.size !== responseCount) {
    reasons.push('duplicate_or_missing_study_item_ids');
  }
  // Treat 0/invalid duration as unknown telemetry rather than hard fraud.
  if (durationSeconds == null || durationSeconds <= 0) {
    warnings.push('missing_duration_seconds');
  } else {
    if (durationSeconds < 120) reasons.push(`too_fast_hard:${durationSeconds}s`);
    else if (durationSeconds < 240) warnings.push(`too_fast_soft:${durationSeconds}s`);
  }
  const interactionRaw = submission.interaction_events;
  const interactionEvents = Number.isFinite(Number(interactionRaw))
    ? Number(interactionRaw)
    : null;
  if (interactionEvents != null && interactionEvents < 30) {
    warnings.push(`low_interaction_events:${interactionEvents}`);
  }

  return {
    status: reasons.length ? 'fail' : (warnings.length ? 'review' : 'pass'),
    reasons,
    warnings,
    expected_item_count: expectedCount,
    response_count: responseCount,
    duration_seconds: durationSeconds,
    interaction_events: interactionEvents
  };
}

function toImporterRows(submissions) {
  const allItems = getAllItems();
  const rows = [];
  submissions.forEach((submission) => {
    const raterId = submission.prolific_pid || 'unknown';
    const qc = evaluateSubmissionQuality(submission, allItems);
    (submission.responses || []).forEach((entry) => {
      rows.push({
        study_item_id: entry.study_item_id,
        item_id: entry.item_id,
        lang_code: entry.lang_code || 'es-AR',
        equivalence_rating: entry.equivalence_rating,
        child_clarity_rating: entry.child_clarity_rating,
        issue_notes: entry.issue_notes || '',
        rater_id: raterId,
        rater_passed_qc: qc.status === 'fail' ? '0' : '1',
        study_id: submission.study_id || '',
        session_id: submission.session_id || '',
        submitted_at: submission.submitted_at || '',
        duration_seconds: qc.duration_seconds == null ? '' : qc.duration_seconds,
        interaction_events: qc.interaction_events == null ? '' : qc.interaction_events,
        expected_item_count: qc.expected_item_count,
        response_count: qc.response_count,
        submission_qc_status: qc.status,
        submission_qc_reasons: [...qc.reasons, ...qc.warnings].join('|')
      });
    });
  });
  return rows;
}

function buildCsv(rows) {
  const headers = [
    'study_item_id',
    'item_id',
    'lang_code',
    'equivalence_rating',
    'child_clarity_rating',
    'issue_notes',
    'rater_id',
    'rater_passed_qc',
    'study_id',
    'session_id',
    'submitted_at',
    'duration_seconds',
    'interaction_events',
    'expected_item_count',
    'response_count',
    'submission_qc_status',
    'submission_qc_reasons'
  ];
  const lines = [headers.join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  });
  return `${lines.join('\n')}\n`;
}

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function buildSummary(submissions) {
  const rows = toImporterRows(submissions);
  const uniqueRaters = new Set(rows.map((r) => r.rater_id).filter(Boolean));
  const allItems = getAllItems();
  const evaluations = submissions.map((s) => ({
    rater_id: s.prolific_pid || '',
    study_id: s.study_id || '',
    session_id: s.session_id || '',
    submitted_at: s.submitted_at || '',
    ...evaluateSubmissionQuality(s, allItems)
  }));
  const statusCounts = evaluations.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  const durations = evaluations
    .map((e) => e.duration_seconds)
    .filter((d) => Number.isFinite(d) && d > 0);
  return {
    submissions: submissions.length,
    unique_raters: uniqueRaters.size,
    total_ratings: rows.length,
    quality: {
      pass: statusCounts.pass || 0,
      review: statusCounts.review || 0,
      fail: statusCounts.fail || 0,
      median_duration_seconds: median(durations),
      evaluations
    },
    completion_code: COMPLETION_CODE,
    updated_at: new Date().toISOString()
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const mode = String(req.query.mode || 'items');
      if (mode === 'items') {
        const allItems = getAllItems();
        const prolificPid = String(req.query.prolific_pid || req.query.prolificPid || '').trim();
        const assigned = pickItemsForPid(allItems, prolificPid);
        return res.status(200).json({
          success: true,
          completion_code: COMPLETION_CODE,
          assignment: prolificPid ? 'deterministic_slot' : 'full_set',
          item_count: assigned.length,
          total_items: allItems.length,
          items: assigned
        });
      }
      if (mode === 'summary') {
        const submissions = await loadAllSubmissions();
        return res.status(200).json({ success: true, summary: buildSummary(submissions) });
      }
      if (mode === 'export_csv') {
        const submissions = await loadAllSubmissions();
        const rows = toImporterRows(submissions);
        const csv = buildCsv(rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="prolific-responses-es-AR.csv"');
        return res.status(200).send(csv);
      }
      return res.status(400).json({ success: false, error: 'invalid_mode' });
    }

    if (req.method === 'POST') {
      const mode = String(req.query.mode || 'submit');
      if (mode !== 'submit') {
        return res.status(400).json({ success: false, error: 'invalid_mode' });
      }
      const submission = normalizeSubmissionBody(req.body || {});
      if (!submission.prolific_pid || !submission.study_id || !submission.session_id) {
        return res.status(400).json({
          success: false,
          error: 'missing_ids',
          message: 'prolific_pid, study_id, and session_id are required'
        });
      }
      if (!Array.isArray(submission.responses) || submission.responses.length === 0) {
        return res.status(400).json({ success: false, error: 'missing_responses' });
      }
      for (const entry of submission.responses) {
        const problem = validateResponseEntry(entry);
        if (problem) {
          return res.status(400).json({ success: false, error: 'invalid_response', message: problem });
        }
      }

      const saveInfo = await saveSubmission(submission);
      return res.status(200).json({
        success: true,
        source: saveInfo.source,
        path: saveInfo.path,
        completion_url: `https://app.prolific.com/submissions/complete?cc=${encodeURIComponent(COMPLETION_CODE)}`
      });
    }

    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  } catch (error) {
    console.error('prolific-es-ar-pilot error:', error);
    return res.status(500).json({ success: false, error: 'internal_error', message: error.message });
  }
}
