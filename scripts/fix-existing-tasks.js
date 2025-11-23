#!/usr/bin/env node

// Fixer/validator for public/data/existing-tasks.json
// - Normalizes ToM* translationKeys to kebab-case (tom-*)
// - Sorts tasks by taskName alphabetically for the UI dropdown

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'data', 'existing-tasks.json');

function toKebabPreserveToM(key) {
  if (typeof key !== 'string') return key;
  // Guard ToM acronym so we don't split it
  const guard = key.replace(/^ToM(?=[A-Z0-9-])/, 'TOM_ACRO');
  let kebab = guard
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
  kebab = kebab.replace(/^tom[_-]?acro/, 'tom');
  return kebab;
}

function normalize(data) {
  if (!data || !Array.isArray(data.tasks)) return data;

  data.tasks.forEach(task => {
    if (Array.isArray(task.translationKeys)) {
      task.translationKeys = task.translationKeys.map(k => {
        if (typeof k === 'string' && /^ToM/.test(k)) {
          return toKebabPreserveToM(k);
        }
        return k;
      });
    }
  });

  // Sort tasks alphabetically by taskName for a stable dropdown order
  data.tasks.sort((a, b) => (a.taskName || '').localeCompare(b.taskName || ''));

  return data;
}

function main() {
  if (!fs.existsSync(FILE)) {
    console.warn('existing-tasks.json not found, skipping fix');
    return;
  }
  const raw = fs.readFileSync(FILE, 'utf8');
  let json;
  try { json = JSON.parse(raw); } catch (e) {
    console.error('Failed to parse existing-tasks.json:', e.message);
    process.exit(2);
  }
  const fixed = normalize(json);
  const out = JSON.stringify(fixed, null, 2) + '\n';
  fs.writeFileSync(FILE, out, 'utf8');
  console.log('✔ existing-tasks.json normalized (ToM→tom-*, tasks sorted)');
}

main();


