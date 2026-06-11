import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeValidationEntry,
  mergeValidationResultsWithExisting,
} from '../api/validation-storage.js';

test('manual approval survives an AI re-validation that sends manualApproved:false with empty timestamp', () => {
  const existing = {
    manualApproved: true,
    manualApprovalUpdatedAt: '2026-05-01T00:00:00.000Z',
    score: 1,
    scoreSource: 'manual',
    notes: 'Manually approved',
  };
  // Simulates a stale client / AI pass: re-scored with AI, manualApproved cleared, no real toggle timestamp.
  const incoming = {
    manualApproved: false,
    manualApprovalUpdatedAt: '',
    score: 0.82,
    scoreSource: 'ai',
  };
  const merged = mergeValidationEntry(existing, incoming);
  assert.equal(merged.manualApproved, true, 'approval must be preserved');
  assert.equal(merged.scoreSource, 'manual');
  assert.equal(merged.score, 1);
  assert.equal(merged.manualApprovalUpdatedAt, '2026-05-01T00:00:00.000Z');
});

test('manual approval survives a re-validation that omits manualApproved entirely', () => {
  const existing = { manualApproved: true, manualApprovalUpdatedAt: '2026-05-01T00:00:00.000Z' };
  const incoming = { score: 0.5, scoreSource: 'ai' };
  const merged = mergeValidationEntry(existing, incoming);
  assert.equal(merged.manualApproved, true);
});

test('a genuine un-approval (explicit newer timestamp) DOES clear the approval', () => {
  const existing = { manualApproved: true, manualApprovalUpdatedAt: '2026-05-01T00:00:00.000Z' };
  const incoming = { manualApproved: false, manualApprovalUpdatedAt: '2026-06-01T00:00:00.000Z' };
  const merged = mergeValidationEntry(existing, incoming);
  assert.equal(merged.manualApproved, false, 'reviewer toggle with newer timestamp should clear approval');
});

test('a stale un-approval (older timestamp) does NOT clear a newer approval', () => {
  const existing = { manualApproved: true, manualApprovalUpdatedAt: '2026-06-10T00:00:00.000Z' };
  const incoming = { manualApproved: false, manualApprovalUpdatedAt: '2026-05-01T00:00:00.000Z' };
  const merged = mergeValidationEntry(existing, incoming);
  assert.equal(merged.manualApproved, true, 'older toggle must not override newer approval');
});

test('needsReview flag is preserved when incoming omits it', () => {
  const existing = { needsReview: true, reason: 'check pronoun', reviewUpdatedAt: '2026-05-01T00:00:00.000Z' };
  const incoming = { score: 0.9, scoreSource: 'ai' };
  const merged = mergeValidationEntry(existing, incoming);
  assert.equal(merged.needsReview, true);
  assert.equal(merged.reason, 'check pronoun');
});

test('mergeValidationResultsWithExisting preserves approvals across the full map (regression for nl trog wipe)', () => {
  const existing = {
    'main/itembank_by_task/sentence-understanding.xliff::trog-item-1': {
      nl: { manualApproved: true, manualApprovalUpdatedAt: '2026-05-01T00:00:00.000Z', score: 1, scoreSource: 'manual' },
    },
  };
  // A full AI re-validation pass for nl that does not know about the human approval.
  const incoming = {
    'main/itembank_by_task/sentence-understanding.xliff::trog-item-1': {
      nl: { manualApproved: false, manualApprovalUpdatedAt: '', score: 0.77, scoreSource: 'ai' },
    },
  };
  const merged = mergeValidationResultsWithExisting(existing, incoming);
  const entry = merged['main/itembank_by_task/sentence-understanding.xliff::trog-item-1'].nl;
  assert.equal(entry.manualApproved, true, 'nl trog approval must survive an AI re-validation pass');
  assert.equal(entry.scoreSource, 'manual');
});
