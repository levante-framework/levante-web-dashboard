import crowdinOtaLib from './lib/crowdin-ota-client.js';

const {
  listLanguages,
  listFiles,
  getTranslations,
} = crowdinOtaLib;

const PAGE_SIZE = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 120;

function getRateLimitStore() {
  if (!globalThis.__translationsRateLimitStore) {
    globalThis.__translationsRateLimitStore = new Map();
  }
  return globalThis.__translationsRateLimitStore;
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (forwarded) return forwarded;
  return String(req.socket?.remoteAddress || 'unknown');
}

function isRateLimited(req) {
  const store = getRateLimitStore();
  const now = Date.now();
  const key = getClientIp(req);
  const current = store.get(key);
  if (!current || (now - current.windowStart) > RATE_LIMIT_WINDOW_MS) {
    store.set(key, { windowStart: now, count: 1 });
    return false;
  }
  current.count += 1;
  store.set(key, current);
  return current.count > RATE_LIMIT_MAX_REQUESTS;
}

function firstQueryValue(value, fallback = '') {
  if (Array.isArray(value)) return String(value[0] || fallback);
  return String(value ?? fallback);
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizePage(rawPage) {
  const n = Number.parseInt(String(rawPage || '1'), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

function baseShell({ title, subtitle, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="/styles.css" />
  <style>
    .translations-wrap { max-width: 1200px; margin: 0 auto; padding: 24px; color: #e2e8f0; }
    .translations-card { background: rgba(9, 17, 31, 0.92); border: 1px solid rgba(0, 160, 222, 0.24); border-radius: 14px; padding: 16px; margin-bottom: 14px; }
    .translations-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
    .translations-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .translations-table th, .translations-table td { border-bottom: 1px solid rgba(148, 163, 184, 0.18); text-align: left; padding: 8px; vertical-align: top; }
    .translations-table th { color: #93c5fd; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
    .translation-key { width: 35%; word-break: break-word; }
    .translation-value { width: 65%; word-break: break-word; user-select: none; -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .pager { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
    .muted { color: #94a3b8; }
    .link-list { margin: 0; padding-left: 18px; }
    .link-list li { margin: 4px 0; }
    a { color: #93c5fd; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main class="translations-wrap">
    <div class="translations-card">
      <h1 style="margin:0 0 8px 0;">${esc(title)}</h1>
      <p class="muted" style="margin:0;">${esc(subtitle)}</p>
    </div>
    ${body}
  </main>
  <script>
    document.addEventListener('copy', function(event) {
      const sel = window.getSelection && window.getSelection();
      const anchorNode = sel && sel.anchorNode ? sel.anchorNode.parentElement : null;
      const target = (event.target && event.target.closest) ? event.target.closest('.translation-value') : null;
      const selectedValueCell = anchorNode && anchorNode.closest ? anchorNode.closest('.translation-value') : null;
      if (target || selectedValueCell) {
        if (event.clipboardData) {
          event.clipboardData.setData('text/plain', '');
        }
        event.preventDefault();
      }
    });
  </script>
</body>
</html>`;
}

function renderLanguagesPage(languages) {
  const body = `<div class="translations-card">
    <h2 style="margin-top:0;">Languages</h2>
    <ul class="link-list">
      ${languages.map((lang) => `<li><a href="/translations/${encodeURIComponent(lang)}">${esc(lang)}</a></li>`).join('')}
    </ul>
  </div>`;
  return baseShell({
    title: 'Public Translations Viewer',
    subtitle: 'Approved translations served from Crowdin (OTA or API fallback), server-rendered with daily cache.',
    body,
  });
}

function renderFilesPage(languageCode, files) {
  const body = `<div class="translations-card">
    <p class="muted"><a href="/translations">All languages</a> / <strong>${esc(languageCode)}</strong></p>
    <h2 style="margin-top:0;">Files</h2>
    <ul class="link-list">
      ${files.map((filePath) => `<li><a href="/translations/${encodeURIComponent(languageCode)}/${encodeURIComponent(filePath)}">${esc(filePath)}</a></li>`).join('')}
    </ul>
  </div>`;
  return baseShell({
    title: `Translations • ${languageCode}`,
    subtitle: 'Select a file to view paginated translation entries.',
    body,
  });
}

function renderRawFilePage(languageCode, filePath, content) {
  const body = `<div class="translations-card">
    <p class="muted"><a href="/translations">All languages</a> / <a href="/translations/${encodeURIComponent(languageCode)}">${esc(languageCode)}</a> / <strong>${esc(filePath)}</strong></p>
    <h2 style="margin-top:0;">Raw content</h2>
    <pre class="mono" style="white-space: pre-wrap; word-break: break-word;">${esc(content)}</pre>
  </div>`;
  return baseShell({
    title: `Translations • ${languageCode} • ${filePath}`,
    subtitle: 'Non-JSON file rendered as raw text.',
    body,
  });
}

function renderObjectFilePage(languageCode, filePath, entries, page) {
  const totalRows = entries.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  const pageEntries = entries.slice(start, start + PAGE_SIZE);
  const prevHref = safePage > 1
    ? `/translations/${encodeURIComponent(languageCode)}/${encodeURIComponent(filePath)}?page=${safePage - 1}`
    : '';
  const nextHref = safePage < totalPages
    ? `/translations/${encodeURIComponent(languageCode)}/${encodeURIComponent(filePath)}?page=${safePage + 1}`
    : '';

  const rowsHtml = pageEntries.map(([key, value]) => {
    const renderedValue = (value && typeof value === 'object') ? JSON.stringify(value) : String(value ?? '');
    return `<tr>
      <td class="translation-key mono">${esc(key)}</td>
      <td class="translation-value mono">${esc(renderedValue)}</td>
    </tr>`;
  }).join('');

  const body = `<div class="translations-card">
    <p class="muted"><a href="/translations">All languages</a> / <a href="/translations/${encodeURIComponent(languageCode)}">${esc(languageCode)}</a> / <strong>${esc(filePath)}</strong></p>
    <p class="muted">Showing ${pageEntries.length} of ${totalRows} rows • Page ${safePage}/${totalPages}</p>
    <table class="translations-table">
      <thead><tr><th>Key</th><th>Value</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="2" class="muted">No entries</td></tr>'}</tbody>
    </table>
    <div class="pager">
      ${prevHref ? `<a href="${prevHref}">← Previous</a>` : '<span class="muted">← Previous</span>'}
      ${nextHref ? `<a href="${nextHref}">Next →</a>` : '<span class="muted">Next →</span>'}
    </div>
  </div>`;

  return baseShell({
    title: `Translations • ${languageCode} • ${filePath}`,
    subtitle: 'Paginated server-rendered translation rows.',
    body,
  });
}

function sendHtml(res, statusCode, html) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400');
  res.end(html);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (isRateLimited(req)) {
    res.statusCode = 429;
    res.setHeader('Retry-After', '60');
    sendHtml(res, 429, baseShell({
      title: 'Rate limit reached',
      subtitle: 'Too many requests. Please wait a minute and try again.',
      body: '<div class="translations-card"><p class="muted">Rate limit hit for /translations routes.</p></div>',
    }));
    return;
  }

  try {
    const languageCode = firstQueryValue(req.query.lang, '').trim();
    const filePath = decodeURIComponent(firstQueryValue(req.query.file, '').trim());
    const page = normalizePage(firstQueryValue(req.query.page, '1'));

    if (!languageCode) {
      const languages = await listLanguages();
      sendHtml(res, 200, renderLanguagesPage(languages));
      return;
    }

    if (!filePath) {
      const files = await listFiles();
      sendHtml(res, 200, renderFilesPage(languageCode, files));
      return;
    }

    const content = await getTranslations(languageCode, filePath);
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      const entries = Object.entries(content);
      sendHtml(res, 200, renderObjectFilePage(languageCode, filePath, entries, page));
      return;
    }

    if (Array.isArray(content)) {
      const entries = content.map((value, index) => [String(index), value]);
      sendHtml(res, 200, renderObjectFilePage(languageCode, filePath, entries, page));
      return;
    }

    sendHtml(res, 200, renderRawFilePage(languageCode, filePath, String(content || '')));
  } catch (error) {
    sendHtml(res, 500, baseShell({
      title: 'Translations viewer error',
      subtitle: 'Could not load translations.',
      body: `<div class="translations-card"><p class="mono">${esc(error?.message || error)}</p></div>`,
    }));
  }
}
