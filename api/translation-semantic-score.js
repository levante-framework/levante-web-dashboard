const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const CONFIGURED_EMBEDDING_MODEL = String(process.env.GEMINI_EMBEDDING_MODEL || '').trim();
const EMBEDDING_MODEL_CANDIDATES = [
  CONFIGURED_EMBEDDING_MODEL,
  'gemini-embedding-001',
  'embedding-001',
  'text-embedding-004',
].filter(Boolean);

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

async function embedText(text, modelName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:embedContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${modelName}`,
      content: {
        parts: [{ text: String(text || '') }]
      },
      taskType: 'SEMANTIC_SIMILARITY'
    })
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Embedding request failed for ${modelName}: ${resp.status} ${body}`);
  }
  const data = await resp.json();
  const values = data?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`Embedding response missing vector values for ${modelName}`);
  }
  return values;
}

async function embedPairWithFallback(originalText, backTranslation) {
  let lastError = null;
  for (const modelName of EMBEDDING_MODEL_CANDIDATES) {
    try {
      const [origVec, backVec] = await Promise.all([
        embedText(originalText, modelName),
        embedText(backTranslation, modelName),
      ]);
      return { origVec, backVec, modelUsed: modelName };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Embedding request failed for all model candidates');
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
      res.status(200).json({ ok: false, skipped: true, reason: 'GEMINI_API_KEY not configured', modelUsed: EMBEDDING_MODEL_CANDIDATES[0] || '' });
      return;
    }

    const { origVec, backVec, modelUsed } = await embedPairWithFallback(originalText, backTranslation);
    const cosine = cosineSimilarity(origVec, backVec);
    const semanticScore = Math.max(0, Math.min(100, cosine * 100));

    res.status(200).json({
      ok: true,
      semantic_score: semanticScore,
      cosine_similarity: cosine,
      modelUsed,
    });
  } catch (error) {
    res.status(200).json({
      ok: false,
      skipped: true,
      reason: 'Semantic scorer failed',
      details: error?.message || String(error),
      modelUsed: EMBEDDING_MODEL_CANDIDATES[0] || '',
    });
  }
}

