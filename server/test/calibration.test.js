const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveCalibrationState } = require('../src/utils/calibration');

const calibrationQuestion = {
  visible_if_json: { raw_type: 1 },
};

test('marks visible calibration as unknown when it is absent from the SKU and database', () => {
  assert.deepEqual(
    resolveCalibrationState({
      question: calibrationQuestion,
      answers: { raw_type: 1 },
    }),
    {
      status: 'unknown',
      value: null,
      source: null,
    }
  );
});

test('uses calibration stored with the product', () => {
  assert.deepEqual(
    resolveCalibrationState({
      question: calibrationQuestion,
      answers: { raw_type: 1 },
      storedValue: 2,
    }),
    {
      status: 'known',
      value: 2,
      source: 'stored',
    }
  );
});

test('keeps zero as a known calibration value', () => {
  assert.deepEqual(
    resolveCalibrationState({
      question: calibrationQuestion,
      answers: { raw_type: 1, is_calibrated: 0 },
    }),
    {
      status: 'known',
      value: 0,
      source: 'answers',
    }
  );
});

test('marks hidden calibration as not applicable', () => {
  assert.deepEqual(
    resolveCalibrationState({
      question: calibrationQuestion,
      answers: { raw_type: 2 },
    }),
    {
      status: 'not_applicable',
      value: null,
      source: null,
    }
  );
});
