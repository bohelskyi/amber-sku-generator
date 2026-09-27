const { test, assert, pool } = require('./suite-context');
const { readAmberEvidence } = require('../src/services/magento/binding-evidence-db');
const { PLANS } = require('../src/services/magento/compatibility-evidence-plans');
const { insertProductFixture } = require('./product-fixture');

test('binding evidence reads real catalog/schema/product SQL inside a read-only snapshot', async () => {
  const counts = async () => (await pool.query(`SELECT (SELECT count(*) FROM products) AS products,
    (SELECT count(*) FROM sku_schema_versions) AS schemas, (SELECT count(*) FROM audit_events) AS audit`)).rows[0];
  const before = await counts();
  const commands = [];
  const evidence = await readAmberEvidence({ connect: async () => {
    const client = await pool.connect();
    return { query: async (sql, parameters) => {
      assert.match(sql.trim(), /^(SELECT|BEGIN|COMMIT|ROLLBACK)\b/);
      commands.push(sql);
      const result = await client.query(sql, parameters);
      if (sql.startsWith('BEGIN')) {
        assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
        assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read');
      }
      return result;
    }, release: () => client.release() };
  } });
  assert.equal(commands[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(commands.at(-1), 'COMMIT');
  assert.ok(evidence.current.length > 0);
  assert.ok(evidence.historical.length > 0);
  assert.equal(evidence.plans.length, 7);
  assert.equal(evidence.usage.length, 3);
  assert.equal(evidence.template.kind, 'system');
  for (const q of evidence.current) for (const option of q.options) {
    assert.equal(typeof option.value_id, 'string');
    assert.equal(typeof option.sku_code, 'string');
  }
  assert.deepEqual(await counts(), before);
});

test('compatibility evidence uses bounded ascending candidates and real read-only PostgreSQL usage queries', async () => {
  const inserted = [];
  for (let i = 0; i < 5; i++) {
    const sku = `AR-COMPATIBILITY-SYNTH-${i}`;
    const result = await insertProductFixture(pool, `INSERT INTO products
      (full_sku, base_sku, sequence_number, category, weight, total_price, total_price_uah,
       price_per_gram, uah_rate, details)
      VALUES ($1, $1, 0, 'AR', 10, 50, 2000, 5, 40, $2::jsonb) RETURNING id`,
    [sku, JSON.stringify({ answers: { type: 1, size: 29 } })]);
    inserted.push(result.rows[0].id);
  }
  const fingerprint = async () => (await pool.query(`SELECT
    (SELECT md5(string_agg(row_to_json(p)::text, ',' ORDER BY id)) FROM products p) AS products,
    (SELECT count(*) FROM audit_events) AS audit,
    (SELECT count(*) FROM sku_schema_versions) AS schemas`)).rows[0];
  const before = await fingerprint();
  const evidence = await readAmberEvidence({ connect: async () => {
    const client = await pool.connect();
    return { query: async (sql, params) => {
      assert.match(sql.trim(), /^(SELECT|BEGIN|COMMIT|ROLLBACK)\b/);
      const result = await client.query(sql, params);
      if (sql.startsWith('BEGIN')) assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
      return result;
    }, release: () => client.release() };
  } }, { mode: 'compatibility' });
  assert.deepEqual(await fingerprint(), before);
  for (const plan of PLANS) {
    const rows = evidence.candidates.filter((c) => c.route_id === plan.id);
    assert.ok(rows.length <= plan.scan);
    assert.deepEqual(rows.map((r) => r.product_id), rows.map((r) => r.product_id).sort((a, b) => a - b));
    assert.ok(rows.every((r) => r.local_status === 'active' && r.eligible_count >= rows.length));
  }
  const expected = (await pool.query(`SELECT id FROM products WHERE category='AR' AND status='active'
    AND corrected_to_product_id IS NULL AND full_sku IS NOT NULL AND btrim(full_sku)<>''
    AND details->'answers'->>'size'=$1 ORDER BY id`, ['29'])).rows;
  const witnesses = evidence.candidates.filter((c) => c.route_id === 'ar_29');
  assert.deepEqual(witnesses.map((c) => c.product_id), expected.slice(0, 3).map((r) => r.id));
  assert.equal(witnesses[0].eligible_count, expected.length);
  assert.ok(expected.some((r) => inserted.includes(r.id)));
  const usage = evidence.usage.find((u) => u.valueId === '29');
  assert.equal(usage.current, expected.length);
  assert.equal(evidence.usage.length, 4);
});
