import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { getMatrixPriceValidationError } from '../src/lib/number-input.js';

test('matrix price validation rejects zero but permits clearing and positive values', () => {
  assert.equal(getMatrixPriceValidationError(''), '');
  assert.equal(getMatrixPriceValidationError('125.50'), '');
  assert.match(getMatrixPriceValidationError('0'), /більшою за 0/);
  assert.match(getMatrixPriceValidationError('-1'), /більшою за 0/);
});

test('SKU manager exposes correction manual-price state to the confirmation dialog', () => {
  const source = fs.readFileSync(
    new URL('../src/hooks/useSkuManager.js', import.meta.url),
    'utf8'
  );
  const occurrences = source.match(/recountManualPriceUah/g) || [];
  const setterOccurrences = source.match(/setRecountManualPriceUah/g) || [];
  assert.ok(occurrences.length >= 2, 'manual price must be destructured and returned');
  assert.ok(setterOccurrences.length >= 2, 'manual price setter must be destructured and returned');
});

test('matrix and correction request errors have visible alert regions', () => {
  const matrixSource = fs.readFileSync(
    new URL('../src/components/admin/AdminPricingEditor.jsx', import.meta.url),
    'utf8'
  );
  const dialogSource = fs.readFileSync(
    new URL('../src/components/app/RecountConfirmDialog.jsx', import.meta.url),
    'utf8'
  );
  assert.match(matrixSource, /matrixValidationError/);
  assert.match(matrixSource, /role="alert"/);
  assert.match(dialogSource, /role="alert"/);
});

test('correction dialog only applies initial focus when it opens', () => {
  const dialogSource = fs.readFileSync(
    new URL('../src/components/app/RecountConfirmDialog.jsx', import.meta.url),
    'utf8'
  );
  const focusCalls = dialogSource.match(/confirmButtonRef\.current\?\.focus\(\)/g) || [];

  assert.equal(focusCalls.length, 1, 'the dialog must not refocus after input state changes');
  assert.match(
    dialogSource,
    /if \(isOpen\) confirmButtonRef\.current\?\.focus\(\);\s*}, \[isOpen\]\);/,
    'initial focus must depend only on the dialog opening'
  );
});

test('repricing renders the same manual resolution control on later manual-price cycles', () => {
  const source = fs.readFileSync(
    new URL('../src/pages/RepricingPage.jsx', import.meta.url),
    'utf8'
  );

  assert.match(source, /\['price_missing', 'manual_price'\]\.includes/);
  assert.match(source, /Залишити поточну ціну/);
  assert.match(source, /setManualPrice\(item\.productId, String\(item\.oldPriceUah\)\)/);
  assert.match(source, /disabled=\{!canApply\}/);
});
