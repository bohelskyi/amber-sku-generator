import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRecountPayload,
  getDecodedAnswerMap,
  haveAnswersChanged,
  updateRecountOptionAnswer,
  updateRecountTextAnswer,
} from '../src/lib/product-recount.js';

test('recount starts from decoded answers enriched with stored product data', () => {
  assert.deepEqual(getDecodedAnswerMap({
    decodedAnswers: [
      { key: 'quality', value_id: 1 },
      { key: 'extra', value_id: null },
    ],
    product: {
      details: {
        answers: { quality: 2, processing: 1 },
        isCalibrated: 0,
      },
    },
  }), {
    quality: 2,
    extra: 0,
    processing: 1,
    is_calibrated: 0,
  });
});

test('recount detects changed, added, and cleared answers', () => {
  assert.equal(haveAnswersChanged({ quality: 1 }, { quality: 1 }), false);
  assert.equal(haveAnswersChanged({ quality: 1 }, { quality: 2 }), true);
  assert.equal(haveAnswersChanged({ quality: 1 }, { quality: 1, extra: 2 }), true);
  assert.equal(haveAnswersChanged({ quality: 1, extra: 2 }, { quality: 1 }), true);
});

test('correction payload forwards a valid manual UAH price', () => {
  assert.deepEqual(buildRecountPayload({
    sourceSku: 'ZZ1-1',
    answers: { kind: 2 },
    isCalibrated: 0,
    reason: 'No matrix cell',
    manualPriceUah: '725',
  }), {
    sourceSku: 'ZZ1-1',
    answers: { kind: 2 },
    isCalibrated: 0,
    reason: 'No matrix cell',
    manualPriceUah: 725,
  });
});

test('optional recount option selection clears to an explicit missing answer', () => {
  const question = { id: 'discount', required: 0 };
  const selected = updateRecountOptionAnswer({}, question, 2);
  const cleared = updateRecountOptionAnswer(selected, question, 2);

  assert.deepEqual(selected, { discount: 2 });
  assert.deepEqual(cleared, { discount: null });
  assert.equal(buildRecountPayload({ answers: cleared }).answers.discount, null);
});

test('required recount answers and genuine zero values are not cleared as optional sentinels', () => {
  assert.deepEqual(
    updateRecountOptionAnswer({ kind: 1 }, { id: 'kind', required: 1 }, 1),
    { kind: 1 }
  );
  assert.deepEqual(
    updateRecountOptionAnswer({}, { id: 'zero_option', required: 0 }, 0),
    { zero_option: 0 }
  );
  assert.deepEqual(
    updateRecountOptionAnswer({}, { id: 'is_calibrated', required: 1 }, 0),
    { is_calibrated: 0 }
  );
  assert.deepEqual(
    updateRecountTextAnswer({ note: 'old' }, { id: 'note', required: 1 }, ''),
    { note: null }
  );
});
