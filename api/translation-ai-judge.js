import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const GEMINI_MODEL_PRIMARY = 'gemini-2.5-pro-preview-03-25';
const GEMINI_MODEL_FALLBACK = 'gemini-2.5-pro';
const DEFAULT_EXPLANATION = 'No significant meaning loss detected.';
const CHILD_TEXT_AUDIO_CONTEXT = 'Audience context: elementary school children. Delivery context: this content is consumed in both written text and generated audio. Prioritize child comprehension, spoken naturalness, and preserving intended action/meaning.';

const SYSTEM_PROMPTS = {
  vocab: 'You are a strict translation evaluator for vocabulary terms used in child-facing learning content. Prioritize denotation accuracy, specificity, part of speech, number (singular/plural), and false-friend errors. Penalize semantic drift and broad synonym substitution when it changes the tested concept.',
  instruction_ui: 'You are a translation evaluator for child-facing task prompts and UI instructions delivered as both text and audio. Prioritize preserving user intent, actionability, imperative force, and simple age-appropriate wording. Penalize ambiguity, softened directives, or wording that could cause a child to take the wrong action.',
  proper_noun: 'You are a translation evaluator for names, brands, and entities in child-facing content. Prioritize exact preservation of entity identity. Penalize changes to names/brands unless transliteration is clearly valid and preserves identity.',
  survey_sentence: 'You are a translation evaluator for child survey prompts delivered as both text and audio for elementary school children. Assess semantic equivalence, tone, emotional framing, and clarity; penalize shifts that could confuse children or alter what they are being asked.',
};

function toNumberInRange(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeItemType(itemType) {
  const raw = String(itemType || '').trim().toLowerCase();
  if (raw === 'vocab') return 'vocab';
  if (raw === 'instruction_ui' || raw === 'instruction' || raw === 'ui') return 'instruction_ui';
  if (raw === 'proper_noun' || raw === 'propernoun') return 'proper_noun';
  return 'survey_sentence';
}

function getSystemPrompt(itemType) {
  const normalized = normalizeItemType(itemType);
  return SYSTEM_PROMPTS[normalized] || SYSTEM_PROMPTS.survey_sentence;
}

function buildUserPrompt(originalText, backTranslatedText, itemType) {
  const normalizedType = normalizeItemType(itemType);
  const typeGuidance = {
    vocab: 'Item type: vocabulary term. Be strict on exact meaning and tested concept fidelity. Small meaning shifts should reduce score meaningfully.',
    instruction_ui: 'Item type: task prompt/instruction/UI. Assume elementary children read and hear this. Judge whether a child would take the same action after text+audio delivery.',
    proper_noun: 'Item type: proper noun/entity. Check identity preservation and avoid substitutions.',
    survey_sentence: 'Item type: child survey sentence. Assume elementary children read and hear this. Evaluate semantic equivalence, emotional tone, and child-level clarity.',
  };

  return [
    'Compare the following two English texts for semantic equivalence. The first is',
    'the original. The second is a back-translation (translated to another language',
    'and then back to English).',
    '',
    CHILD_TEXT_AUDIO_CONTEXT,
    '',
    typeGuidance[normalizedType],
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

async function compareBackTranslation(originalText, backTranslatedText, itemType = 'survey_sentence') {
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
        systemInstruction: getSystemPrompt(itemType),
      });
      const userPrompt = buildUserPrompt(originalText, backTranslatedText, itemType);
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      });
      const raw = result?.response?.text?.() || '';
      const parsed = parseJudgeResponse(raw);
      return { ...parsed, modelUsed: modelName, itemTypeUsed: normalizeItemType(itemType) };
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
    const { originalText, translatedText, backTranslation, langCode, itemType } = req.body || {};
    if (!originalText || !translatedText) {
      res.status(400).json({ error: 'Missing required fields: originalText, translatedText' });
      return;
    }
    if (!GEMINI_API_KEY) {
      res.status(200).json({ ok: false, skipped: true, reason: 'GEMINI_API_KEY not configured', modelUsed: GEMINI_MODEL_PRIMARY });
      return;
    }
    const comparisonText = String(backTranslation || translatedText || '');
    const judged = await compareBackTranslation(originalText, comparisonText, itemType);

    res.status(200).json({
      ok: true,
      ai_score: judged.score,
      notes: judged.explanation,
      modelUsed: judged.modelUsed,
      itemTypeUsed: judged.itemTypeUsed,
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

