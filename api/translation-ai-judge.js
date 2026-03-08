import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const GEMINI_MODEL_PRIMARY = 'gemini-2.5-pro-preview-03-25';
const GEMINI_MODEL_FALLBACK = 'gemini-2.5-pro';
const DEFAULT_EXPLANATION = 'No significant meaning loss detected.';
const SYSTEM_PROMPT = 'You are a translation quality evaluator. Your job is to assess how well a back-translation preserves the meaning of the original text. Be sensitive to subtle shifts in meaning, tone, emphasis, and any concepts that were lost or distorted.';

function toNumberInRange(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function buildUserPrompt(originalText, backTranslatedText) {
  return [
    'Compare the following two English texts for semantic equivalence. The first is',
    'the original. The second is a back-translation (translated to another language',
    'and then back to English).',
    '',
    `Original: ${String(originalText)}`,
    '',
    `Back-translated: ${String(backTranslatedText)}`,
    '',
    'Respond in JSON with two fields:',
    '',
    'score: a number from 0 to 100 (100 = perfectly equivalent meaning)',
    '',
    "explanation: a concise plain-English explanation of any meaning that was lost",
    "or distorted, or 'No significant meaning loss detected.' if the score is high",
  ].join('\n');
}

function stripCodeFences(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('```')) return text;
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function parseJudgeResponse(rawText) {
  const cleaned = stripCodeFences(rawText);
  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (_) {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Gemini response was not valid JSON');
  }
  const score = toNumberInRange(parsed.score, 0, 100, null);
  if (score == null) {
    throw new Error('Gemini JSON missing numeric score (0-100)');
  }
  const explanation = String(parsed.explanation || '').trim() || DEFAULT_EXPLANATION;
  return { score, explanation };
}

async function compareBackTranslation(originalText, backTranslatedText) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const modelNames = [GEMINI_MODEL_PRIMARY, GEMINI_MODEL_FALLBACK];
  let lastError = null;

  for (const modelName of modelNames) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: SYSTEM_PROMPT,
      });
      const userPrompt = buildUserPrompt(originalText, backTranslatedText);
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      });
      const raw = result?.response?.text?.() || '';
      const parsed = parseJudgeResponse(raw);
      return { ...parsed, modelUsed: modelName };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Gemini compare failed: ${lastError?.message || 'unknown error'}`);
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
    if (!GEMINI_API_KEY) {
      res.status(200).json({ ok: false, skipped: true, reason: 'GEMINI_API_KEY not configured', modelUsed: GEMINI_MODEL_PRIMARY });
      return;
    }
    const comparisonText = String(backTranslation || translatedText || '');
    const judged = await compareBackTranslation(originalText, comparisonText);

    res.status(200).json({
      ok: true,
      ai_score: judged.score,
      notes: judged.explanation,
      modelUsed: judged.modelUsed,
      langCode: langCode || 'unknown',
    });
  } catch (error) {
    res.status(200).json({
      ok: false,
      skipped: true,
      reason: 'Gemini judge failed',
      details: error.message || String(error),
      modelUsed: GEMINI_MODEL_PRIMARY,
    });
  }
}

