const https = require('https');

function getHeader(req, name) {
  const key = String(name || '').toLowerCase();
  const h = req?.headers || {};
  for (const k of Object.keys(h)) {
    if (String(k).toLowerCase() === key) return h[k];
  }
  return null;
}

function firstForwardedIp(req) {
  const xff = getHeader(req, 'x-forwarded-for');
  if (xff) {
    const first = String(xff).split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = getHeader(req, 'x-real-ip');
  if (realIp) return String(realIp).trim();
  const cf = getHeader(req, 'cf-connecting-ip');
  if (cf) return String(cf).trim();
  const socketIp = req?.socket?.remoteAddress || null;
  return socketIp ? String(socketIp) : null;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': 'levante-web-dashboard/1.0',
            Accept: 'application/json'
          }
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode !== 200) {
              return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            }
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        }
      )
      .on('error', reject);
  });
}

function normalizeOrg(s) {
  return (s || '').toString().trim();
}

function isStarlinkOrg(org, asnName) {
  const hay = `${org || ''} ${asnName || ''}`.toLowerCase();
  return hay.includes('starlink') || hay.includes('spacex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  try {
    const ip = firstForwardedIp(req);
    if (!ip) {
      res.status(200).json({ ok: false, isp: null, isStarlinkLikely: false, reason: 'no_ip' });
      return;
    }

    // ipwho.is returns connection.isp and as.* fields without an API key.
    // Docs: https://ipwho.is/
    const url = `https://ipwho.is/${encodeURIComponent(ip)}`;
    const json = await fetchJson(url);
    if (json?.success === false) {
      res.status(200).json({ ok: false, isp: null, isStarlinkLikely: false, reason: json?.message || 'lookup_failed' });
      return;
    }

    const isp = normalizeOrg(json?.connection?.isp) || normalizeOrg(json?.isp) || null;
    const org = normalizeOrg(json?.connection?.org) || normalizeOrg(json?.org) || null;
    const asn = normalizeOrg(json?.asn) || null;
    const asName = normalizeOrg(json?.connection?.asn) || normalizeOrg(json?.as) || null;
    const isStarlinkLikely = isStarlinkOrg(isp || org, asName);

    res.status(200).json({
      ok: true,
      isp,
      org,
      asn,
      asName,
      isStarlinkLikely
    });
  } catch (err) {
    console.error('network-isp error:', err);
    res.status(200).json({ ok: false, isp: null, isStarlinkLikely: false, reason: 'exception' });
  }
};


