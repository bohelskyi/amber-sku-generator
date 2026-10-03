import test from 'node:test';
import assert from 'node:assert/strict';
import { getPresentableRecountChanges, getPresentedAnswerLabel, shouldPresentDecodedAnswer } from '../src/lib/answer-presentation.js';
import { polishConfig, polishDecoded, polishPreview } from './fixtures/characteristic-polish.js';

test('absence requires semantic evidence and never translated labels or zero truthiness', () => {
  for (const value of [0, '0', 90, 'Невідомо', 'Не обрано']) {
    assert.equal(shouldPresentDecodedAnswer({ value_id: value, is_placeholder: false }), true);
  }
  assert.equal(shouldPresentDecodedAnswer({ value_id: null, is_placeholder: true }), false);
  assert.equal(shouldPresentDecodedAnswer({ value_id: null }), false);
  assert.equal(shouldPresentDecodedAnswer({ value_id: null, is_placeholder: false, value_label: 'Невідомо' }), true);
});

test('recount separates genuine zero, missing values and placeholder evidence', () => {
  const changes = [{ key: 'historic_zero', from: 0, to: null },
    { key: 'numeric_zero', from: '0', to: null }, { key: 'is_calibrated', from: 0, to: 2 },
    { key: 'visible_clear', from: '', to: null }, { key: 'souvenir', from: 1, to: '1' },
    { key: 'statue', from: 0, to: null }];
  const options = { config: polishConfig, categoryCode: 'SV', source: polishDecoded,
    target: { answers: { souvenir: 3 } } };
  assert.deepEqual(getPresentableRecountChanges(changes, options), changes.slice(0, 3));
  assert.equal(getPresentedAnswerLabel(polishConfig, 'SV', 'historic_zero', 0, polishDecoded), '0');
  assert.equal(getPresentedAnswerLabel(polishConfig, 'SV', 'numeric_zero', 0), '0');
  assert.equal(getPresentedAnswerLabel(polishConfig, 'SV', 'unknown', 0), '0');
});

test('hidden cleanup uses target answers, retains clears without visibility evidence, and does not mutate evidence', () => {
  const before = structuredClone(polishPreview);
  const options = { config: polishConfig, categoryCode: 'SV', source: polishPreview.source,
    target: polishPreview.corrected };
  assert.deepEqual(getPresentableRecountChanges(polishPreview.changes, options), [polishPreview.changes[0]]);
  assert.deepEqual(getPresentableRecountChanges([polishPreview.changes[1]], { source: polishPreview.source }), [polishPreview.changes[1]]);
  assert.deepEqual(getPresentableRecountChanges([polishPreview.changes[1]], { ...options,
    target: { answers: { souvenir: 2, kit_part: 7 } } }), [polishPreview.changes[1]]);
  assert.deepEqual(polishPreview, before);
});
