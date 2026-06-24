/**
 * Map dashboard task display labels to canonical itembank folder slugs.
 * Keys are normalized: lowercased, "&" → "and", non-alphanumerics collapsed to spaces.
 */
export const TASK_SLUG_ALIASES = Object.freeze({
  memory: 'memory-game',
  'memory game': 'memory-game',
  'pattern matching': 'matrix-reasoning',
  matrix: 'matrix-reasoning',
  'matrix reasoning': 'matrix-reasoning',
  math: 'egma-math',
  'egma math': 'egma-math',
  'shape rotation': 'mental-rotation',
  'mental rotation': 'mental-rotation',
  'same and different': 'same-different-selection',
  'same different': 'same-different-selection',
  'same different selection': 'same-different-selection',
  'sentence understanding': 'trog',
  trog: 'trog',
  stories: 'theory-of-mind',
  'theory of mind': 'theory-of-mind',
  vocabulary: 'vocab',
  vocab: 'vocab',
  'hearts and flowers': 'hearts-and-flowers',
  'hostile attribution': 'hostile-attribution',
  'thoughts and feelings': 'child-survey',
  'child survey': 'child-survey',
});

export function normalizeTaskCandidates(taskName) {
  const raw = String(taskName || '').trim().toLowerCase();
  if (!raw) return [];
  const slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const underscored = slug.replace(/-/g, '_');
  return Array.from(new Set([raw, slug, underscored].filter(Boolean)));
}

/** Resolve a task label (display name or slug) to folder slugs under translations/itembank/. */
export function getTaskSlugCandidates(taskName) {
  const raw = String(taskName || '').trim().toLowerCase();
  if (!raw) return [];
  const normalizedKey = raw.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
  const candidates = new Set();
  if (normalizedKey && TASK_SLUG_ALIASES[normalizedKey]) {
    candidates.add(TASK_SLUG_ALIASES[normalizedKey]);
  }
  const slug = normalizedKey.replace(/\s+/g, '-');
  if (slug) candidates.add(slug);
  return Array.from(candidates);
}

export function resolveCanonicalTaskSlug(taskName) {
  const candidates = getTaskSlugCandidates(taskName);
  if (candidates.length) return candidates[0];
  const raw = String(taskName || '').trim().toLowerCase();
  if (!raw) return '';
  return raw
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
