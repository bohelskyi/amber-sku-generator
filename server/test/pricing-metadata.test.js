const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getPricingMetadata } = require('../src/services/pricing/pricing-read-model');

test('pricing metadata exposes only the labels and axes required by the pricing workspace', async () => {
  const queryable = {
    query(sql) {
      if (sql.includes('FROM categories')) {
        return Promise.resolve({ rows: [{
          code: 'BR',
          name: 'Браслети',
          requires_weight: 1,
          code_mutable: false,
          marketing_rounding_enabled: 1,
        }] });
      }
      return Promise.resolve({ rows: [
        {
          category_code: 'BR',
          key: 'raw_type',
          q_label: 'Тип сировини',
          input_type: 'options',
          option_id: 10,
          value_id: 1,
          option_label: 'Натуральний',
          visible_if_json: { kind: 1 },
          hidden_if_json: null,
          archived: false,
        },
      ] });
    },
  };

  const metadata = await getPricingMetadata(queryable);

  assert.deepEqual(metadata.categories, {
    BR: { code: 'BR', name: 'Браслети', requires_weight: 1 },
  });
  assert.deepEqual(metadata.questions.BR, [{
    id: 'raw_type',
    label: 'Тип сировини',
    input_type: 'options',
    options: [{
      id: 1,
      label: 'Натуральний',
      visible_if_json: { kind: 1 },
      hidden_if_json: null,
      archived: 0,
    }],
  }]);
  assert.ok(metadata.extraConfig.is_calibrated);
  assert.equal(metadata.categories.BR.code_mutable, undefined);
  assert.equal(metadata.categories.BR.marketing_rounding_enabled, undefined);
});

test('pricing metadata route is independently guarded by pricing.view', () => {
  const router = require('../src/routes/admin/pricing.routes');
  const route = router.stack.find((layer) => layer.route?.path === '/admin/pricing/config');
  assert.ok(route);
  assert.equal(route.route.stack[0].handle.permissionKey, 'pricing.view');
});
