const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004';

function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecB.length === 0) return 0;
  const n = Math.min(vecA.length, vecB.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const a = Number(vecA[i]) || 0;
    const b = Number(vecB[i]) || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedText(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(EMBEDDING_MODEL)}:embedContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: {
        parts: [{ text: String(text || '') }]
      },
      taskType: 'SEMANTIC_SIMILARITY'
    })
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Embedding request failed: ${resp.status} ${body}`);
  }
  const data = await resp.json();
  const values = data?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Embedding response missing vector values');
  }
  return values;
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
    const { originalText, backTranslation } = req.body || {};
    if (!originalText || !backTranslation) {
      res.status(400).json({ ok: false, error: 'Missing required fields: originalText, backTranslation' });
      return;
    }
    if (!GEMINI_API_KEY) {
      res.status(200).json({ ok: false, skipped: true, reason: 'GEMINI_API_KEY not configured', modelUsed: EMBEDDING_MODEL });
      return;
    }

    const [origVec, backVec] = await Promise.all([
      embedText(originalText),
      embedText(backTranslation),
    ]);
    const cosine = cosineSimilarity(origVec, backVec);
    const semanticScore = Math.max(0, Math.min(100, cosine * 100));

    res.status(200).json({
      ok: true,
      semantic_score: semanticScore,
      cosine_similarity: cosine,
      modelUsed: EMBEDDING_MODEL,
    });
  } catch (error) {
    res.status(200).json({
      ok: false,
      skipped: true,
      reason: 'Semantic scorer failed',
      details: error?.message || String(error),
      modelUsed: EMBEDDING_MODEL,
    });
  }
}

