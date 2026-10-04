const test = require('node:test');
const assert = require('node:assert/strict');
const { previewView } = require('../src/services/magento/integration-readiness');

function report() {
  return { mode: 'update', generatedAt: '2026-10-04T10:00:00Z', sendable: false,
    amberProduct: { id: 42, publicSku: 'AG-000042', group: 'SV' },
    attributeSet: { routeKey: 'SV:stone', selected: { id: 4, name: 'Камінь' }, currentMagentoSet: { id: 3, name: 'Сувеніри' } },
    candidatePayload: { product: {} }, transport: null,
    attributes: [
      { target: 'kamin_obrobka', source: [{ kind: 'semantic', questionKey: 'finish', storedValue: 0, privateData: 'do-not-copy' }], evaluatedValue: 'Необроблений',
        currentRawValue: '12', currentResolvedOptions: [{ optionId: '12', label: 'Полірований' }], diagnostics: ['OPTION_UNRESOLVED'] },
      { target: 'description', source: [], evaluatedValue: 'Amber description', currentRawValue: 'Magento description', diagnostics: [] },
      { target: 'attribute_set_code', source: [], evaluatedValue: 'Камінь', currentRawValue: 3, diagnostics: [] },
    ],
    diff: [{ target: 'kamin_obrobka', action: 'unresolved', candidate: null, includedInPayload: false },
      { target: 'description', action: 'preserve', candidate: 'Amber description', includedInPayload: false },
      { target: 'attribute_set_code', action: 'would_update', candidate: 4, includedInPayload: true },
      { target: 'categories', action: 'unresolved', includedInPayload: false }],
    fieldOwnership: [{ target: 'description', policy: 'magento_managed', action: 'preserve' },
      { target: 'kamin_obrobka', policy: 'authoritative_create_update', action: 'unresolved' }],
    categories: { currentKnown: false, current: [], requested: [{ requestedPath: 'Root/Сувеніри/Птахи' }] },
    blockers: [{ code: 'OPTION_UNRESOLVED', target: 'kamin_obrobka' }, { code: 'CATEGORY_PATH_MISSING', path: 'Root/Сувеніри/Птахи', operation: 'categories' }],
    warnings: [{ code: 'FIELD_INTENTIONALLY_PRESERVED', target: 'description' }, { code: 'PRODUCT_ATTRIBUTE_SET_MISMATCH', current: 3, candidate: 4 }],
  };
}

test('diagnostic projection names the exact source and category, preserving semantic zero and authority boundaries', () => {
  const source = report(); const before = structuredClone(source); const view = previewView(source);
  assert.equal(view.productId, 42);
  assert.deepEqual(view.blockers[0], { code: 'OPTION_UNRESOLVED', target: 'kamin_obrobka',
    message: 'У Magento немає підтвердженого відповідного значення характеристики.', resolution: 'integration_configuration',
    fieldLabel: 'Обробка каменю', question: 'finish', value: '0', expectedValue: 'Необроблений' });
  assert.equal(view.blockers[1].path, 'Root/Сувеніри/Птахи');
  assert.equal(view.comparisons.find((row) => row.target === 'categories').current.state, 'unavailable');
  assert.deepEqual(view.comparisons[0].current.value, ['Полірований']);
  assert.equal(view.comparisons[0].expected.value, 'Необроблений');
  assert.equal(JSON.stringify(view).includes('do-not-copy'), false);
  assert.deepEqual(source, before);
});

test('Magento-managed differences and attribute-set warnings remain distinct from blockers', () => {
  const source = report(); const view = previewView(source);
  const managed = view.comparisons.find((row) => row.target === 'description');
  assert.equal(managed.policy, 'magento_managed'); assert.equal(managed.action, 'preserve'); assert.equal(managed.includedInPayload, false);
  assert.equal(managed.severity, 'warning');
  const set = view.comparisons.find((row) => row.target === 'attribute_set_code');
  assert.equal(set.current.value, 'Сувеніри'); assert.equal(set.expected.value, 'Камінь'); assert.equal(set.severity, 'warning');
  assert.equal(view.blockers.some((item) => item.code === 'PRODUCT_ATTRIBUTE_SET_MISMATCH'), false);
  source.mode = 'create';
  assert.equal(previewView(source).comparisons[0].current.state, 'product_absent');
});

test('new attributes use observed Magento labels in both comparisons and exact diagnostics', () => {
  const source = report();
  source.attributes[0].target = 'country_of_origin'; source.attributes[0].magentoAttributeLabel = 'Країна походження';
  source.blockers[0].target = 'country_of_origin'; source.diff[0].target = 'country_of_origin';
  const view = previewView(source);
  assert.equal(view.comparisons[0].label, 'Країна походження');
  assert.equal(view.blockers[0].fieldLabel, 'Країна походження');
});
