#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();

const { unzipSync } = require('fflate');

const CROWDIN_API_BASE = 'https://api.crowdin.com/api/v2';
const DEFAULT_PROJECT_ID = '756721';
const COST_PER_MILLION_CHARS_USD = 20;

function parseArgs(argv) {
  const out = { langs: [], approvedOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--langs' && argv[i + 1]) {
      out.langs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith('--langs=')) {
      out.langs = a.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--approved-only') {
      out.approvedOnly = true;
    }
  }
  return out;
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
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

function extractTargetStrings(xliffText) {
  const targets = [];
  const re = /<target\b[^>]*>([\s\S]*?)<\/target>/gi;
  let m;
  while ((m = re.exec(xliffText)) !== null) {
    const raw = m[1] || '';
    const withoutTags = raw.replace(/<[^>]+>/g, '');
    const decoded = decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
    if (decoded) targets.push(decoded);
  }
  return targets;
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
    const text = await res.text();
    throw new Error(`${options.method || 'GET'} ${url} failed: ${res.status} ${text}`);
  }
  return res;
}

async function getBuildZipUrl({ token, projectId, approvedOnly }) {
  const buildRes = await crowdinFetch(
    `${CROWDIN_API_BASE}/projects/${projectId}/translations/builds`,
    token,
    { method: 'POST', body: JSON.stringify({ exportApprovedOnly: approvedOnly }) }
  );
  const buildBody = await buildRes.json();
  const buildId = buildBody?.data?.id;
  if (!buildId) throw new Error('No build id returned by Crowdin.');

  for (let i = 0; i < 40; i++) {
    const statusRes = await crowdinFetch(
      `${CROWDIN_API_BASE}/projects/${projectId}/translations/builds/${buildId}`,
      token
    );
    const statusBody = await statusRes.json();
    const status = statusBody?.data?.status;
    if (status === 'finished') break;
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`Build ${status}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const downloadRes = await crowdinFetch(
    `${CROWDIN_API_BASE}/projects/${projectId}/translations/builds/${buildId}/download`,
    token
  );
  const downloadBody = await downloadRes.json();
  const zipUrl = downloadBody?.data?.url;
  if (!zipUrl) throw new Error('No download URL returned by Crowdin.');
  return zipUrl;
}

function summarize(zipEntries, langs) {
  const wanted = new Set(langs.map((l) => l.toLowerCase()));
  const decoder = new TextDecoder('utf-8');
  const perLang = {};

  const ensure = (lang) => {
    if (!perLang[lang]) {
      perLang[lang] = {
        taskFiles: new Set(),
        surveyFiles: new Set(),
        taskSegments: 0,
        surveySegments: 0,
        taskChars: 0,
        surveyChars: 0,
      };
    }
    return perLang[lang];
  };

  for (const [rawPath, bytes] of Object.entries(zipEntries)) {
    const path = normalizePath(rawPath);
    const lower = path.toLowerCase();
    if (!lower.endsWith('.xlf') && !lower.endsWith('.xliff')) continue;
    const first = (path.split('/')[0] || '').trim();
    if (!first) continue;
    const lang = first.toLowerCase();
    if (!wanted.has(lang)) continue;

    const isTask = lower.includes('/main/itembank_by_task/');
    const isSurvey = lower.includes('/main/surveys/');
    if (!isTask && !isSurvey) continue;

    const text = decoder.decode(bytes);
    const targets = extractTargetStrings(text);
    const chars = targets.reduce((sum, t) => sum + t.length, 0);
    const row = ensure(lang);
    if (isTask) {
      row.taskFiles.add(path);
      row.taskSegments += targets.length;
      row.taskChars += chars;
    } else if (isSurvey) {
      row.surveyFiles.add(path);
      row.surveySegments += targets.length;
      row.surveyChars += chars;
    }
  }

  return perLang;
}

function printReport(perLang) {
  console.log('\nValidation cost estimate (Google Translate back-translation)');
  console.log(`Rate: $${COST_PER_MILLION_CHARS_USD} per 1,000,000 chars\n`);
  Object.keys(perLang).sort().forEach((lang) => {
    const s = perLang[lang];
    const totalChars = s.taskChars + s.surveyChars;
    const totalSegments = s.taskSegments + s.surveySegments;
    const cost = (totalChars * COST_PER_MILLION_CHARS_USD) / 1000000;
    console.log(`Language: ${lang}`);
    console.log(`  Task files   : ${s.taskFiles.size}`);
    console.log(`  Survey files : ${s.surveyFiles.size}`);
    console.log(`  Task items   : ${s.taskSegments.toLocaleString()} targets`);
    console.log(`  Survey items : ${s.surveySegments.toLocaleString()} targets`);
    console.log(`  Total items  : ${totalSegments.toLocaleString()} targets`);
    console.log(`  Total chars  : ${totalChars.toLocaleString()}`);
    console.log(`  Est. cost    : $${cost.toFixed(2)}\n`);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.langs.length) {
    console.error('Usage: node scripts/estimate-validation-cost.js --langs es-CO,de [--approved-only]');
    process.exit(1);
  }
  const token = process.env.CROWDIN_API_TOKEN;
  const projectId = process.env.LEVANTE_TRANSLATIONS_PROJECT_ID || DEFAULT_PROJECT_ID;
  if (!token) {
    console.error('Missing CROWDIN_API_TOKEN in environment.');
    process.exit(1);
  }

  console.log(`Building Crowdin export for project ${projectId} (approvedOnly=${args.approvedOnly})...`);
  const zipUrl = await getBuildZipUrl({ token, projectId, approvedOnly: args.approvedOnly });
  const zipRes = await fetch(zipUrl);
  if (!zipRes.ok) throw new Error(`ZIP download failed: ${zipRes.status}`);
  const zipBuffer = await zipRes.arrayBuffer();
  const entries = unzipSync(new Uint8Array(zipBuffer));
  const perLang = summarize(entries, args.langs);
  printReport(perLang);
}

main().catch((err) => {
  console.error('\nFailed to estimate validation cost:\n', err.message || err);
  process.exit(1);
});

