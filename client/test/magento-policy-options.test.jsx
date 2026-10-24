import { expect, it } from 'vitest';
import { policyReviewConstraint, policyReviewChoice, canConfirmPolicy } from '../src/lib/magento-policy-options.js';

const entry = { kind: 'policy', row: 'english', label: 'en', target: 'meta_title', identity: 'magento_managed', reviewState: 'review_required' };

it('restricts only EN policy values and never infers an approval from a saved unsupported content rule', () => {
  expect(policyReviewConstraint(entry)).toEqual({ kind: 'content', choices: ['authoritative_create_update'] });
  for (const value of ['', 'magento_managed', 'initialize_create_only', 'future_policy', 'constructor', undefined]) {
    expect(policyReviewChoice(entry, value)).toBe(''); expect(canConfirmPolicy(entry, value)).toBe(false);
  }
  expect(policyReviewChoice(entry, 'authoritative_create_update')).toBe('authoritative_create_update');
  expect(canConfirmPolicy(entry, 'authoritative_create_update')).toBe(true);
  for (const label of ['all', 'custom_store', 'en']) {
    const base = { ...entry, row: 'base', label };
    expect(policyReviewConstraint(base)).toBeNull();
    expect(policyReviewChoice(base, 'initialize_create_only')).toBe('initialize_create_only');
    expect(canConfirmPolicy(base, 'initialize_create_only')).toBe(true);
  }
  const attribute = { ...entry, kind: 'attribute', target: 'sku' };
  expect(policyReviewConstraint(attribute)).toBeNull();
  expect(policyReviewChoice(attribute, 'sku')).toBe('sku'); expect(canConfirmPolicy(attribute, 'sku')).toBe(true);
});

it('requires exact EN scope and an unresolved saved managed identity for the four controls', () => {
  for (const target of ['sku', 'product_type', 'attribute_set_code', 'store_view_code']) {
    const control = { ...entry, target };
    expect(policyReviewConstraint(control)).toEqual({ kind: 'control', choices: [] });
    expect(policyReviewChoice(control, '')).toBe('magento_managed');
    expect(canConfirmPolicy(control, 'magento_managed')).toBe(true);
    expect(canConfirmPolicy({ ...control, reviewState: 'proposed' }, 'magento_managed')).toBe(true);
    for (const reviewState of ['approved', 'blocked', 'not_applicable', undefined]) expect(canConfirmPolicy({ ...control, reviewState }, 'magento_managed')).toBe(false);
    for (const identity of ['authoritative_create_update', 'initialize_create_only', 'blocked', null]) {
      expect(policyReviewChoice({ ...control, identity }, 'magento_managed')).toBe('');
      expect(canConfirmPolicy({ ...control, identity }, 'magento_managed')).toBe(false);
    }
    for (const label of ['all', 'EN', undefined]) {
      expect(policyReviewConstraint({ ...control, label }).kind).toBe('scope');
      expect(canConfirmPolicy({ ...control, label }, 'magento_managed')).toBe(false);
    }
  }
  for (const target of ['qty', 'product_online', 'product_websites']) expect(policyReviewConstraint({ ...entry, target }).kind).toBe('content');
  for (const row of [undefined, 'unrecognized']) expect(canConfirmPolicy({ ...entry, row }, 'authoritative_create_update')).toBe(false);
});
