import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRecountPayload,
  getDecodedAnswerMap,
  haveAnswersChanged,
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
