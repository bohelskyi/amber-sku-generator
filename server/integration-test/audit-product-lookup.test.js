const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');

function planNodes(node) {
  return [node, ...(node.Plans || []).flatMap(planNodes)];
}

test('audit product lookup preserves exact identities and uses indexed PostgreSQL reads', async t => {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname));
  assert.ok(source.pathname.endsWith('_test'));
  const name = `amber_audit_lookup_${randomBytes(6).toString('hex')}_test`;
  assert.match(name, /^amber_audit_lookup_[a-f0-9]{12}_test$/);
  const control = new Client({ connectionString: source.toString(), connectionTimeoutMillis: 3000 });
  await control.connect();
  let created = false, db;
  t.after(async () => {
    if (db) await db.end();
    if (created) await control.query(`DROP DATABASE "${name}"`);
    await control.end();
  });
  assert.equal((await control.query('SELECT current_database() AS name')).rows[0].name,
    decodeURIComponent(source.pathname.slice(1)));
  const version = Number((await control.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 160000 && version < 170000, 'This query-plan regression targets PostgreSQL 16');
  await control.query(`CREATE DATABASE "${name}"`); created = true;
  const target = new URL(source); target.pathname = `/${name}`;
  process.env.DATABASE_URL = target.toString();
  require('../test/setup-env');
  const { getAuditEvents } = require('../src/services/audit-viewer.service');
  t.mock.method(globalThis, 'fetch', () => assert.fail('Audit reads must not perform external I/O'));
  db = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 3000 });
  await db.connect();

  // A query-contract fixture, not a replacement for the migrated HTTP/RBAC suite.
  // Match the real integer/bigint keys and relevant indexes without allocating
  // business identities or bypassing any production-table triggers.
  await db.query(`CREATE TABLE public_product_identities (id bigint PRIMARY KEY, public_sku text UNIQUE NOT NULL);
    CREATE TABLE products (id integer PRIMARY KEY, public_product_identity_id bigint NOT NULL REFERENCES public_product_identities(id));
    CREATE INDEX products_public_product_identity_idx ON products(public_product_identity_id, id);
    CREATE TABLE audit_events (id bigint PRIMARY KEY, event_key text NOT NULL, actor_user_id bigint,
      actor_snapshot jsonb, subject_type text NOT NULL, subject_id text NOT NULL,
      details jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL);
    CREATE INDEX audit_events_occurred_idx ON audit_events(occurred_at DESC, id DESC);
    CREATE INDEX audit_events_subject_idx ON audit_events(subject_type, subject_id, occurred_at DESC, id DESC)`);
  await db.query(`INSERT INTO public_product_identities SELECT n, 'AG-' || lpad(n::text, 6, '0') FROM generate_series(1,20000) n;
    INSERT INTO products SELECT n,n FROM generate_series(1,20000) n;
    INSERT INTO public_product_identities VALUES (20001,'AG-ZERO'),(20002,'AG-NEGATIVE'),(20003,'AG-INT4-MIN'),(20004,'AG-INT4-MAX');
    INSERT INTO products VALUES (0,20001),(-1,20002),(-2147483648,20003),(2147483647,20004);
    INSERT INTO audit_events SELECT n,'product.created',7,
      '{"displayName":"Recorded actor","preferredUsername":"recorded.actor"}',
      'product', n::text, '{}', '2026-10-22T00:00:00Z' FROM generate_series(1,200) n`);
  const literalArticle = "AG%_\\'LITERAL";
  await db.query('UPDATE public_product_identities SET public_sku=$1 WHERE id=100', [literalArticle]);
  const malformed = ['x', '01', '+1', '-0', '1e2', '1.0', ' 1', '1 ', '1\n',
    '2147483648', '-2147483649', '9999999999', '-9999999999', '9223372036854775808',
    '9'.repeat(256), '00000000-0000-0000-0000-000000000001'];
  const fixtures = [
    ...[['42', 'AG-000042'], ['0', 'AG-ZERO'], ['-1', 'AG-NEGATIVE'],
      ['-2147483648', 'AG-INT4-MIN'], ['2147483647', 'AG-INT4-MAX']]
      .map(([subjectId, article]) => ({ type: 'product', subjectId, article })),
    ...malformed.map(subjectId => ({ type: 'product', subjectId })),
    { type: 'role', subjectId: '42' },
    { type: 'export_template', subjectId: '00000000-0000-0000-0000-000000000001' },
    { type: 'product', subjectId: '777777', article: 'RECORDED-ONLY', recorded: true },
  ];
  for (const [index, item] of fixtures.entries()) {
    await db.query(`INSERT INTO audit_events VALUES ($1,$2,7,$3::jsonb,$4,$5,$6::jsonb,'2026-10-23T00:00:00Z')`,
      [301 + index, `${item.type}.created`, JSON.stringify({ displayName: 'Recorded actor', preferredUsername: 'recorded.actor' }),
        item.type, item.subjectId, JSON.stringify(item.recorded ? { publicSku: item.article } : {})]);
  }
  await db.query('ANALYZE');
  await db.query('BEGIN READ ONLY');
  const read = async query => {
    let statement;
    const result = await getAuditEvents(query, { databasePool: {
      query(sql, values) { statement = { sql, values }; return db.query(sql, values); },
    } });
    return { result, statement };
  };

  await t.test('mixed, noncanonical and overflowing subjects retain safe exact labels', async () => {
    const { result } = await read({ from: '2026-10-23T00:00:00Z', limit: 100 });
    assert.equal(result.items.length, fixtures.length);
    for (const fixture of fixtures) {
      const event = result.items.find(item => item.subject.type === fixture.type && item.subject.id === fixture.subjectId);
      assert.ok(event, `Retained audit event for ${fixture.type}:${fixture.subjectId}`);
      assert.equal(event.subject.productArticle, fixture.article, fixture.subjectId);
      assert.equal(event.subject.labelSource, fixture.article ? fixture.recorded ? 'recorded' : 'stable_identity' : undefined);
      assert.equal(event.actor.displayName, 'Recorded actor');
    }
  });

  await t.test('article search stays literal, case-insensitive and bound to exact cursor filters', async () => {
    const query = { article: 'ag-000042', limit: 1 };
    const first = (await read(query)).result;
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].subject.id, '42');
    assert.equal(first.items[0].occurredAt, '2026-10-23T00:00:00.000Z');
    assert.equal(first.page.hasMore, true);
    const second = (await read({ ...query, cursor: first.page.nextCursor })).result;
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0].subject.id, '42');
    assert.equal(second.items[0].occurredAt, '2026-10-22T00:00:00.000Z');
    assert.equal(second.page.hasMore, false);
    await assert.rejects(read({ ...query, article: 'AG-000043', cursor: first.page.nextCursor }), { code: 'INVALID_CURSOR' });
    assert.equal((await read({ article: literalArticle.toLowerCase() })).result.items[0].subject.productArticle, literalArticle);
    assert.equal((await read({ article: 'RECORDED-ONLY' })).result.items.length, 0, 'Recorded fallback text is not a live identity');
    for (const subjectId of malformed) {
      // Request filters trim whitespace; restrict this check to the edge events
      // so a normalized filter cannot select an earlier canonical product event.
      assert.equal((await read({ article: 'AG-', subjectType: 'product', subjectId,
        from: '2026-10-23T00:00:00Z' })).result.items.length, 0, subjectId);
    }
  });

  await t.test('bounded list and selective search avoid repeated full product scans', async () => {
    for (const query of [{ limit: 100 }, { article: 'AG-000042', limit: 100 }]) {
      const { statement } = await read(query);
      const explained = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.values);
      const nodes = planNodes(explained.rows[0]['QUERY PLAN'][0].Plan);
      const products = nodes.filter(node => node['Relation Name'] === 'products');
      assert.ok(products.length, 'The real service query must resolve product identities');
      assert.ok(products.some(node => /Index/.test(node['Node Type']) && node['Index Cond']),
        'The natural PostgreSQL plan must use an indexed product lookup');
      assert.equal(products.some(node => node['Node Type'] === 'Seq Scan' && (!query.article || node['Actual Loops'] > 1)), false,
        'A bounded audit page must not rescan all products for each event');
    }
  });
  await db.query('ROLLBACK');
});
