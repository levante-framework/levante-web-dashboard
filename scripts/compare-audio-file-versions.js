#!/usr/bin/env node

/**
 * Compare local audio files (from levante_translations/audio_files/<lang>) against GCS dev/prod buckets.
 *
 * For each item key, we find the "latest" object in the bucket:
 * - audio/<lang>/<key>_v###.mp3 (highest ###), else audio/<lang>/<key>.mp3
 * Then we compare:
 * - local filesystem mtime
 * - bucket metadata.updated / timeCreated
 * - (optional) ID3 "created" custom tag from local + bucket object (requires downloading the bucket object)
 *
 * Intended use: after retagging local audio, quickly see whether dev/prod are older/newer.
 *
 * Usage:
 *   node scripts/compare-audio-file-versions.js --lang de --report /path/to/fix-report-de-applied.json
 *
 * Optional:
 *   --buckets levante-assets-dev,levante-assets-prod
 *   --download-tags  (downloads each bucket mp3 to read ID3 tags)
 *   --out out.json
 */

const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const NodeID3 = require('node-id3');

function normalizeStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function getStorageClient() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (raw) {
    const creds = JSON.parse(raw);
    return new Storage({ credentials: creds, projectId: creds.project_id });
  }
  return new Storage();
}

function normalizeLangFolder(lang) {
  // Buckets are structured audio/<lang>/..., for de we use 'de'
  return (lang || '').trim();
}

function parseVersionFromName(objectName, key) {
  const re = new RegExp(`${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}_v(\\d{3})\\.mp3$`, 'i');
  const m = objectName.match(re);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return Number.isFinite(v) ? v : null;
}

function pickLatestObject(files, key) {
  const mp3s = files
    .map(f => f.name)
    .filter(Boolean)
    .filter(n => n.toLowerCase().endsWith('.mp3'));
  let best = null;
  let bestV = -1;
  for (const name of mp3s) {
    const v = parseVersionFromName(name, key);
    if (v != null && v > bestV) {
      bestV = v;
      best = name;
    }
  }
  if (best) return { name: best, version: bestV };
  // fallback to unversioned exact match
  const unversioned = mp3s.find(n => n.toLowerCase().endsWith(`/${key.toLowerCase()}.mp3`));
  if (unversioned) return { name: unversioned, version: 0 };
  // fallback: if only versioned mismatched patterns exist, pick most recently updated by later metadata fetch (handled upstream)
  return null;
}

function extractCustomTag(tags, desc) {
  // node-id3 returns { userDefinedText: [{description,value}, ...] }
  const list = tags && tags.userDefinedText;
  if (!Array.isArray(list)) return '';
  const target = (desc || '').toLowerCase();
  const found = list.find(t => (t && (t.description || '').toLowerCase() === target));
  return found && found.value ? String(found.value) : '';
}

function looksLikeKeyText(text, key) {
  const t = normalizeStr(text);
  if (!t) return false;
  if (t === key) return true;
  if (t === `['${key}']` || t === `["${key}"]`) return true;
  return false;
}

function tagSnapshot(tags, keyForHeuristic) {
  if (!tags) return null;
  const snap = {
    title: normalizeStr(tags.title),
    artist: normalizeStr(tags.artist),
    album: normalizeStr(tags.album),
    voice: normalizeStr(extractCustomTag(tags, 'voice')),
    service: normalizeStr(extractCustomTag(tags, 'service')),
    lang_code: normalizeStr(extractCustomTag(tags, 'lang_code')),
    created: normalizeStr(extractCustomTag(tags, 'created')),
    text: normalizeStr(extractCustomTag(tags, 'text')),
  };
  snap.textLooksLikeKey = looksLikeKeyText(snap.text, keyForHeuristic);
  return snap;
}

function compareTagValue(localVal, bucketVal) {
  const a = normalizeStr(localVal);
  const b = normalizeStr(bucketVal);
  if (!a && !b) return 'missing_both';
  if (!a && b) return 'missing_local';
  if (a && !b) return 'missing_bucket';
  return a === b ? 'same' : 'different';
}

function parseTime(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function compare(localDate, bucketDate) {
  if (!localDate || !bucketDate) return 'unknown';
  const diff = localDate.getTime() - bucketDate.getTime();
  const minutes = diff / 60000;
  if (Math.abs(minutes) < 2) return 'same';
  return minutes > 0 ? 'newer' : 'older';
}

async function getLatestForBucket(storage, bucketName, lang, key) {
  const prefix = `audio/${lang}/${key}`;
  const bucket = storage.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
  if (!files || !files.length) return null;

  const picked = pickLatestObject(files, key);
  if (picked) {
    const f = bucket.file(picked.name);
    const [meta] = await f.getMetadata();
    return { object: picked.name, version: picked.version, meta };
  }

  // If we couldn't pick a versioned/unversioned deterministically, pick the most recently updated.
  let best = null;
  for (const f of files) {
    const [meta] = await bucket.file(f.name).getMetadata();
    const upd = parseTime(meta.updated) || parseTime(meta.timeCreated);
    if (!upd) continue;
    if (!best || upd > best.updated) {
      best = { object: f.name, version: null, meta, updated: upd };
    }
  }
  if (!best) return null;
  return { object: best.object, version: best.version, meta: best.meta };
}

async function maybeReadBucketId3(storage, bucketName, objectName, downloadTags) {
  if (!downloadTags) return null;
  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(objectName);
    const [buf] = await file.download();
    const tags = NodeID3.read(buf);
    return tags || null;
  } catch {
    return null;
  }
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('lang', { type: 'string', demandOption: true })
    .option('report', { type: 'string', demandOption: true })
    .option('buckets', { type: 'string', default: 'levante-assets-dev,levante-assets-prod' })
    .option('download-tags', { type: 'boolean', default: false })
    .option('compare-id3', { type: 'boolean', default: true })
    .option('out', { type: 'string', default: '' })
    .parse();

  const lang = normalizeLangFolder(argv.lang);
  const reportPath = argv.report;
  const buckets = String(argv.buckets).split(',').map(s => s.trim()).filter(Boolean);
  const downloadTags = Boolean(argv['download-tags']);
  const compareId3 = Boolean(argv['compare-id3']);

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const files = Array.isArray(report.files) ? report.files : [];
  const targets = files.filter(r => r && r.changed_text).map(r => ({
    item_key: r.item_key,
    file: r.file,
  }));

  if (!targets.length) {
    console.log('No changed_text items found in report.');
    process.exit(0);
  }

  const storage = getStorageClient();
  const results = [];

  for (const t of targets) {
    const localPath = t.file;
    const localStat = fs.existsSync(localPath) ? fs.statSync(localPath) : null;
    const localMtime = localStat ? new Date(localStat.mtimeMs) : null;
    const localBuf = localStat ? fs.readFileSync(localPath) : null;
    const localId3 = localBuf ? NodeID3.read(localBuf) : null;
    const localCreated = localId3 ? parseTime(extractCustomTag(localId3, 'created')) : null;
    const localTagSnap = (downloadTags && compareId3 && localId3) ? tagSnapshot(localId3, t.item_key) : null;

    const entry = {
      item_key: t.item_key,
      local: {
        path: localPath,
        mtime: localMtime ? localMtime.toISOString() : null,
        created: localCreated ? localCreated.toISOString() : null,
        id3: localTagSnap,
      },
      buckets: {},
    };

    for (const bucketName of buckets) {
      try {
        const latest = await getLatestForBucket(storage, bucketName, lang, t.item_key);
        if (!latest) {
          entry.buckets[bucketName] = { found: false };
          continue;
        }
        const meta = latest.meta || {};
        const updated = parseTime(meta.updated) || parseTime(meta.timeCreated);
        const created = parseTime(meta.timeCreated);
        const bucketId3 = await maybeReadBucketId3(storage, bucketName, latest.object, downloadTags);
        const bucketCreatedTag = bucketId3 ? parseTime(extractCustomTag(bucketId3, 'created')) : null;
        const bucketTagSnap = (downloadTags && compareId3 && bucketId3) ? tagSnapshot(bucketId3, t.item_key) : null;
        const id3Compare = (downloadTags && compareId3 && localTagSnap && bucketTagSnap) ? {
          voice: compareTagValue(localTagSnap.voice, bucketTagSnap.voice),
          service: compareTagValue(localTagSnap.service, bucketTagSnap.service),
          lang_code: compareTagValue(localTagSnap.lang_code, bucketTagSnap.lang_code),
          created: compareTagValue(localTagSnap.created, bucketTagSnap.created),
          text: compareTagValue(localTagSnap.text, bucketTagSnap.text),
          textLooksLikeKey_bucket: Boolean(bucketTagSnap.textLooksLikeKey),
        } : null;

        entry.buckets[bucketName] = {
          found: true,
          object: latest.object,
          version: latest.version,
          updated: updated ? updated.toISOString() : null,
          timeCreated: created ? created.toISOString() : null,
          createdTag: bucketCreatedTag ? bucketCreatedTag.toISOString() : null,
          compareByUpdated: compare(localMtime, updated),
          compareByCreatedTag: bucketCreatedTag && localCreated ? compare(localCreated, bucketCreatedTag) : 'unknown',
          id3: bucketTagSnap,
          id3Compare,
        };
      } catch (e) {
        entry.buckets[bucketName] = { found: false, error: String(e && e.message ? e.message : e) };
      }
    }

    results.push(entry);
  }

  // Summaries
  function summarize(bucketName, field) {
    const counts = { newer: 0, older: 0, same: 0, unknown: 0, missing: 0 };
    for (const r of results) {
      const b = r.buckets[bucketName];
      if (!b || !b.found) { counts.missing += 1; continue; }
      const v = b[field] || 'unknown';
      counts[v] = (counts[v] || 0) + 1;
    }
    return counts;
  }

  console.log(`Compared ${results.length} item(s) for lang=${lang}`);
  for (const bucketName of buckets) {
    console.log(`\nBucket: ${bucketName}`);
    console.log(`  by updated:`, summarize(bucketName, 'compareByUpdated'));
    if (downloadTags) {
      console.log(`  by ID3 created tag:`, summarize(bucketName, 'compareByCreatedTag'));
    }
    if (downloadTags && compareId3) {
      const counts = {
        voice: { same: 0, different: 0, missing_local: 0, missing_bucket: 0, missing_both: 0 },
        service: { same: 0, different: 0, missing_local: 0, missing_bucket: 0, missing_both: 0 },
        lang_code: { same: 0, different: 0, missing_local: 0, missing_bucket: 0, missing_both: 0 },
        created: { same: 0, different: 0, missing_local: 0, missing_bucket: 0, missing_both: 0 },
        text: { same: 0, different: 0, missing_local: 0, missing_bucket: 0, missing_both: 0 },
        textLooksLikeKey_bucket: 0,
        missing: 0,
      };
      for (const r of results) {
        const b = r.buckets[bucketName];
        if (!b || !b.found) { counts.missing += 1; continue; }
        const c = b.id3Compare;
        if (!c) { counts.missing += 1; continue; }
        for (const k of ['voice','service','lang_code','created','text']) {
          counts[k][c[k]] = (counts[k][c[k]] || 0) + 1;
        }
        if (c.textLooksLikeKey_bucket) counts.textLooksLikeKey_bucket += 1;
      }
      console.log(`  ID3 tag compare (local vs bucket):`);
      console.log(`    voice:`, counts.voice);
      console.log(`    service:`, counts.service);
      console.log(`    lang_code:`, counts.lang_code);
      console.log(`    created:`, counts.created);
      console.log(`    text:`, counts.text);
      console.log(`    bucket text looks like key: ${counts.textLooksLikeKey_bucket}`);
      if (counts.missing) console.log(`    (missing comparisons for ${counts.missing} item(s))`);
    }
  }

  if (argv.out) {
    fs.writeFileSync(argv.out, JSON.stringify({ lang, report: reportPath, buckets, downloadTags, results }, null, 2));
    console.log(`\nWrote: ${argv.out}`);
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});


