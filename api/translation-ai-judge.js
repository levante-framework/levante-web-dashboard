const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function toNumberInRange(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { originalText, translatedText, backTranslation, langCode } = req.body || {};
    if (!originalText || !translatedText) {
      res.status(400).json({ error: 'Missing required fields: originalText, translatedText' });
      return;
    }
    if (!OPENAI_API_KEY) {
      res.status(200).json({ ok: false, skipped: true, reason: 'OPENAI_API_KEY not configured' });
      return;
    }

    const prompt = [
      'You are a translation quality judge.',
      'Return STRICT JSON only:',
      '{"ai_score": number(0-100), "notes": string}',
      '',
      `Language code: ${langCode || 'unknown'}`,
      `Source (English): ${String(originalText)}`,
      `Translation (${langCode || 'target'}): ${String(translatedText)}`,
      `Back-translation (to English): ${String(backTranslation || '')}`,
      '',
      'Scoring rubric (0-100): semantic fidelity and meaning preservation are primary.',
      'Penalize omissions, additions, mistranslations, and critical meaning shifts.',
      'Minor wording/style differences are acceptable if meaning is preserved.'
    ].join('\n');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      res.status(200).json({ ok: false, skipped: true, reason: `OpenAI error: ${response.status}`, details: errorText });
      return;
    }

    const body = await response.json();
    const raw = body?.choices?.[0]?.message?.content || '';
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      // Try to extract first JSON object if model wrapped content
      const m = String(raw).match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch (_) { parsed = null; }
      }
    }

    const aiScore = toNumberInRange(parsed?.ai_score, 0, 100, null);
    if (aiScore == null) {
      res.status(200).json({ ok: false, skipped: true, reason: 'Could not parse ai_score', raw });
      return;
    }

    res.status(200).json({
      ok: true,
      ai_score: aiScore,
      notes: typeof parsed?.notes === 'string' ? parsed.notes : ''
    });
  } catch (error) {
    res.status(500).json({ error: 'AI judge failed', details: error.message || String(error) });
  }
}

