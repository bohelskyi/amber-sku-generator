import test from 'node:test';
import assert from 'node:assert/strict';
import { copyCurrentOptionLabels, currentOptionLabel, optionDisplayLabel } from '../src/lib/export-template-option-labels.js';

test('label authoring copies exact current strings and never invents ambiguous, missing or historical labels', () => {
  const evidence = { current: [{ options: [
    { value_id: 0, label: 'Нуль' }, { value_id: 1, label: '  Світлий  ' },
    { value_id: 2, label: 'Темний' }, { value_id: 2, label: 'Інша назва' },
    { value_id: 3, label: '' }, { value_id: 4, label: null },
    { value_id: 5, label: '0' }, { value_id: 6, label: '   ' },
  ] }], historical: [{ options: [{ value_id: 29, label: 'Лише історична назва' }] }] };
  const before = JSON.stringify(evidence);
  const entries = { old: '', nil: null, num: 0, str: '0', spaces: '  ' };
  const copied = copyCurrentOptionLabels(evidence, entries);
  assert.deepEqual(copied, { ...entries, 0: 'Нуль', 1: '  Світлий  ', 5: '0' });
  for (const id of ['2', '3', '4', '6', '29']) {
    assert.equal(currentOptionLabel(evidence, id), null);
    assert.equal(optionDisplayLabel(evidence, id), `Значення №${id} — назву не підтверджено`);
    assert.equal(Object.hasOwn(copied, id), false);
  }
  assert.equal(JSON.stringify(evidence), before);
  assert.deepEqual(entries, { old: '', nil: null, num: 0, str: '0', spaces: '  ' });
  assert.deepEqual(copyCurrentOptionLabels({ current: [...evidence.current, ...evidence.current] }), {});
  evidence.current[0].options[1].label = 'Пізніше перейменовано';
  assert.equal(copied['1'], '  Світлий  ');
});
