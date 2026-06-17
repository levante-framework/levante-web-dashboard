const { unzipSync } = require('fflate');

const CROWDIN_API_BASE = 'https://api.crowdin.com/api/v2';
const DEFAULT_PROJECT_ID = '756721';

function normalizeLangCode(value) {
  return String(value || '').trim().replace(/_/g, '-').toLowerCase();
}

function normalizeItemToken(value) {
  return String(value || '').trim().toLowerCase();
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripTags(text) {
  return decodeEntities(String(text || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function getAttr(attrText, key) {
  const re = new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i');
  const m = String(attrText || '').match(re);
  return m && m[1] ? String(m[1]).trim() : '';
}

function extractTagText(block, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = String(block || '').match(re);
  return m ? stripTags(m[1]) : '';
}

function parseXliffUnits(xliffText) {
  const units = [];
  const text = String(xliffText || '');

  const transUnitRe = /<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi;
  let match;
  while ((match = transUnitRe.exec(text)) !== null) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    units.push({
      id: getAttr(attrs, 'id'),
      resname: getAttr(attrs, 'resname') || getAttr(attrs, 'name'),
      source: extractTagText(body, 'source'),
      target: extractTagText(body, 'target'),
      approved: getAttr(attrs, 'approved'),
    });
  }
  if (units.length) return units;

  const unitRe = /<unit\b([^>]*)>([\s\S]*?)<\/unit>/gi;
  while ((match = unitRe.exec(text)) !== null) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    const segmentMatch = body.match(/<segment\b[^>]*>([\s\S]*?)<\/segment>/i);
    const scope = segmentMatch ? segmentMatch[1] : body;
    units.push({
      id: getAttr(attrs, 'id'),
      resname: getAttr(attrs, 'resname') || getAttr(attrs, 'name'),
      source: extractTagText(scope, 'source'),
      target: extractTagText(scope, 'target'),
      approved: getAttr(attrs, 'approved'),
    });
  }
  return units;
}

function itemTokenCandidates(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const base = raw.includes('::') ? raw.split('::').pop() : raw;
  const out = new Set([normalizeItemToken(raw), normalizeItemToken(base)]);
  return Array.from(out).filter(Boolean);
}

function taskFromPath(pathValue) {
  const normalized = String(pathValue || '').replace(/\\/g, '/');
  const match = normalized.match(/\/main\/itembank_by_task\/([^/]+)\.xli?ff$/i);
  return match && match[1] ? String(match[1]).trim() : '';
}

async function crowdinFetch(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${options.method || 'GET'} ${url} failed: ${res.status} ${body}`);
  }
  return res;
}

async function createOrReuseBuild(projectId, token, approvedOnly) {
  const buildRes = await fetch(`${CROWDIN_API_BASE}/projects/${projectId}/translations/builds`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ exportApprovedOnly: approvedOnly }),
  });

  if (buildRes.ok) {
    const body = await buildRes.json();
    return body?.data?.id || null;
  }

  if (buildRes.status !== 409) {
    const errText = await buildRes.text().catch(() => '');
    throw new Error(`Crowdin build failed: ${buildRes.status} ${errText}`);
  }

  const listRes = await crowdinFetch(
    `${CROWDIN_API_BASE}/projects/${projectId}/translations/builds?limit=10`,
    token
  );
  const listBody = await listRes.json();
  const active = (listBody?.data || []).find((entry) => {
    const status = String(entry?.data?.status || '').toLowerCase();
    return status === 'building' || status === 'inprogress';
  });
  return active?.data?.id || null;
}

async function waitForBuild(projectId, token, buildId) {
  const maxAttempts = 28;
  const pollMs = 2000;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const statusRes = await crowdinFetch(
      `${CROWDIN_API_BASE}/projects/${projectId}/translations/builds/${buildId}`,
      token
    );
    const statusBody = await statusRes.json();
    const status = String(statusBody?.data?.status || '').toLowerCase();
    if (status === 'finished') return true;
    if (status === 'failed' || status === 'cancelled') return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  try {
    const payload = req.method === 'POST'
      ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}))
      : (req.query || {});

    const lang = normalizeLangCode(payload.lang || '');
    const approvedOnly = String(payload.approvedOnly || 'true').toLowerCase() !== 'false';
    const rawItemIds = []
      .concat(payload.itemIds || [])
      .concat(payload.itemId || [])
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const itemIds = Array.from(new Set(rawItemIds));

    if (!itemIds.length) {
      res.status(400).json({ ok: false, error: 'missing_item_id', message: 'Pass itemId or itemIds[]' });
      return;
    }
    if (!lang) {
      res.status(400).json({ ok: false, error: 'missing_lang', message: 'Pass lang=<langCode>' });
      return;
    }

    const token = String(process.env.CROWDIN_API_TOKEN || '').trim();
    if (!token) {
      res.status(500).json({ ok: false, error: 'missing_crowdin_token' });
      return;
    }
    const projectId = String(process.env.LEVANTE_TRANSLATIONS_PROJECT_ID || DEFAULT_PROJECT_ID).trim();

    const buildId = await createOrReuseBuild(projectId, token, approvedOnly);
    if (!buildId) {
      res.status(500).json({ ok: false, error: 'build_id_unavailable' });
      return;
    }

    const finished = await waitForBuild(projectId, token, buildId);
    if (!finished) {
      res.status(504).json({ ok: false, error: 'build_not_ready', buildId });
      return;
    }

    const downloadRes = await crowdinFetch(
      `${CROWDIN_API_BASE}/projects/${projectId}/translations/builds/${buildId}/download`,
      token
    );
    const downloadBody = await downloadRes.json();
    const zipUrl = String(downloadBody?.data?.url || '').trim();
    if (!zipUrl) {
      res.status(500).json({ ok: false, error: 'missing_zip_url' });
      return;
    }

    const zipRes = await fetch(zipUrl);
    if (!zipRes.ok) {
      res.status(502).json({ ok: false, error: 'zip_download_failed', status: zipRes.status });
      return;
    }
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
    const archive = unzipSync(new Uint8Array(zipBuffer));

    const lowerLang = normalizeLangCode(lang);
    const requestedByToken = new Map();
    itemIds.forEach((requestedId) => {
      const normalizedRequestedId = normalizeItemToken(requestedId);
      if (!normalizedRequestedId) return;
      itemTokenCandidates(requestedId).forEach((token) => {
        if (!requestedByToken.has(token)) requestedByToken.set(token, new Set());
        requestedByToken.get(token).add(requestedId);
      });
    });

    const matchesByRequestedId = new Map();
    const entries = Object.entries(archive);
    entries.forEach(([pathValue, bytes]) => {
      const normalizedPath = String(pathValue || '').replace(/\\/g, '/');
      const lowerPath = normalizedPath.toLowerCase();
      if (!(lowerPath.endsWith('.xlf') || lowerPath.endsWith('.xliff'))) return;
      if (!lowerPath.includes('/main/itembank_by_task/')) return;
      if (!lowerPath.startsWith(`${lowerLang}/`)) return;

      const xliffText = Buffer.from(bytes).toString('utf8');
      const units = parseXliffUnits(xliffText);
      units.forEach((unit) => {
        const unitTokens = [
          ...itemTokenCandidates(unit?.resname || ''),
          ...itemTokenCandidates(unit?.id || ''),
        ];
        const matchedRequestedIds = new Set();
        unitTokens.forEach((token) => {
          const ids = requestedByToken.get(token);
          if (!ids) return;
          ids.forEach((id) => matchedRequestedIds.add(id));
        });
        if (!matchedRequestedIds.size) return;

        const payloadMatch = {
          path: normalizedPath,
          task: taskFromPath(normalizedPath),
          resname: String(unit?.resname || ''),
          id: String(unit?.id || ''),
          source: String(unit?.source || ''),
          target: String(unit?.target || ''),
          approved: String(unit?.approved || ''),
        };
        matchedRequestedIds.forEach((requestedId) => {
          if (!matchesByRequestedId.has(requestedId)) matchesByRequestedId.set(requestedId, []);
          matchesByRequestedId.get(requestedId).push(payloadMatch);
        });
      });
    });

    const resultsByItemId = {};
    itemIds.forEach((requestedId) => {
      const matches = matchesByRequestedId.get(requestedId) || [];
      const withTarget = matches.filter((entry) => String(entry.target || '').trim());
      resultsByItemId[requestedId] = {
        itemId: requestedId,
        matchCount: matches.length,
        matches,
        bestMatch: withTarget[0] || matches[0] || null,
      };
    });

    const singleRequestedId = itemIds.length === 1 ? itemIds[0] : '';
    const singleResult = singleRequestedId ? resultsByItemId[singleRequestedId] : null;

    res.status(200).json({
      ok: true,
      itemIds,
      lang: lowerLang,
      approvedOnly,
      resultsByItemId,
      // Backward-compatible fields for single-item callers.
      itemId: singleRequestedId || '',
      matchCount: singleResult?.matchCount || 0,
      matches: singleResult?.matches || [],
      bestMatch: singleResult?.bestMatch || null,
    });
  } catch (error) {
    console.error('Crowdin approved item lookup failed:', error);
    res.status(500).json({
      ok: false,
      error: 'internal_error',
      message: error?.message || String(error),
    });
  }
};
