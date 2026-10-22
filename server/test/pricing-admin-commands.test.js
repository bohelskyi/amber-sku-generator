const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/db/pool');
const gate = require('../src/services/full-product-cutover-gate');
const audit = require('../src/audit/audit-events');
test.before(() => test.mock.method(require('node:net').Socket.prototype, 'connect',
  () => assert.fail('Pricing unit tests must not open network connections')));

// Keep one loaded copy so Node's coverage includes every command exercised here.
let recordAudit = () => assert.fail('Audit outside a test fixture');
const auditMock = test.mock.method(audit, 'writeAuditEvent', (...args) => recordAudit(...args));
const commands = require('../src/services/pricing/pricing-admin-commands');
test.after(() => auditMock.mock.restore());
const options = { mutationContext: { actorUserId: 7, requestId: 'pricing-unit' } };
const scenario = { id: 4, category_code: 'NM', name: 'Matrix', group_name: 'Matrix',
  match_json: {}, axis_x_key: 'kind', axis_y_key: null, priority: 0, status: 'active',
  price_mode: 'fixed_uah', apply_modifiers: true };

function fixture(t, respond = () => assert.fail('Unexpected database query'), auditError) {
  const calls = [], events = [], lifecycle = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return respond(sql, values);
  }, release: () => lifecycle.push('client.release') };
  const connect = t.mock.method(pool, 'connect', async () => { lifecycle.push('connect'); return client; });
  t.mock.method(pool, 'query', () => assert.fail('Commands must use their transaction client'));
  for (const method of ['begin', 'commit', 'rollback', 'release']) {
    t.mock.method(gate, method, async (actual, statement) => {
      assert.equal(actual, client);
      if (method === 'begin') assert.equal(statement, 'BEGIN');
      lifecycle.push(method);
    });
  }
  recordAudit = async (actual, event) => {
    assert.equal(actual, client); assert.deepEqual(event.mutationContext, options.mutationContext);
    events.push(event);
    if (auditError) throw auditError;
    return { id: 99 };
  };
  t.after(() => { recordAudit = () => assert.fail('Audit outside a test fixture'); });
  return { commands, calls, events, lifecycle, connect };
}

for (const price of [0, -1, Infinity, NaN, 'invalid']) {
  test(`matrix rejects nonpositive/nonfinite price ${String(price)} before leasing a client`, async (t) => {
    const f = fixture(t);
    await assert.rejects(f.commands.upsertPriceCell({ scenario_id: 4, x_val: 2, price }, options));
    assert.equal(f.connect.mock.callCount(), 0);
    assert.deepEqual(f.events, []);
  });
}

for (const [label, price, current] of [['blank absent', ' ', null], ['equal numeric', '12.5', '12.5000']]) {
  test(`matrix ${label} is a no-op without mutation or audit`, async (t) => {
    const f = fixture(t, (sql, values) => {
      if (sql.includes('FROM price_scenarios')) return { rows: [scenario] };
      assert.match(sql, /FROM price_matrix/); assert.deepEqual(values, [4, 2, 0]);
      return { rows: current === null ? [] : [{ price: current }] };
    });
    await f.commands.upsertPriceCell({ scenario_id: '4', x_val: '2', price }, options);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.lifecycle, ['connect', 'begin', 'commit', 'release', 'client.release']);
  });
}

for (const [label, price, oldPrice, mutation, eventKey, newPrice] of [
  ['delete', null, '12.50', /DELETE FROM price_matrix/, 'pricing.matrix_cell.deleted', null],
  ['set', '15,25', null, /INSERT INTO price_matrix/, 'pricing.matrix_cell.set', 15.25],
]) {
  test(`matrix ${label} records old/new prices in its transaction audit`, async (t) => {
    const f = fixture(t, (sql, values) => {
      if (sql.includes('FROM price_scenarios')) return { rows: [scenario] };
      if (sql.startsWith('SELECT price')) return { rows: oldPrice === null ? [] : [{ price: oldPrice }] };
      assert.match(sql, mutation);
      assert.deepEqual(values, newPrice === null ? [4, 2, 3] : [4, 2, 3, newPrice]);
      return { rowCount: 1 };
    });
    await f.commands.upsertPriceCell({ scenario_id: 4, x_val: 2, y_val: 3, price }, options);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].eventKey, eventKey);
    assert.equal(f.events[0].subjectId, '4:2:3');
    assert.deepEqual(f.events[0].details, { scenarioId: 4, scenarioName: 'Matrix', categoryCode: 'NM',
      xValue: 2, yValue: 3, oldPrice: oldPrice === null ? null : 12.5, newPrice });
    assert.deepEqual(f.lifecycle.slice(-3), ['commit', 'release', 'client.release']);
  });
}

test('a matrix audit failure rolls back and releases instead of committing a price write', async (t) => {
  const failure = new Error('audit unavailable');
  const f = fixture(t, (sql) => {
    if (sql.includes('FROM price_scenarios')) return { rows: [scenario] };
    if (sql.startsWith('SELECT price')) return { rows: [] };
    assert.match(sql, /INSERT INTO price_matrix/); return { rowCount: 1 };
  }, failure);
  await assert.rejects(f.commands.upsertPriceCell({ scenario_id: 4, x_val: 2, price: 20 }, options), failure);
  assert.deepEqual(f.lifecycle, ['connect', 'begin', 'rollback', 'release', 'client.release']);
});

test('scenario axis and overlapping weight bands fail before transaction acquisition', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.commands.createScenario({ axis_y_key: 'weight_band' }, options), { statusCode: 400 });
  await assert.rejects(f.commands.createScenario({ axis_x_key: 'weight_band', weight_bands: [
    { label: 'A', min_weight: 0, max_weight: 5 }, { label: 'B', min_weight: 4, max_weight: 8 },
  ] }, options), /без пропусків і перетинів/);
  assert.equal(f.connect.mock.callCount(), 0);
});

test('new scenario is a draft and records its explicit category/group and empty bands', async (t) => {
  const f = fixture(t, (sql, values) => {
    if (sql.includes('INSERT INTO price_scenarios')) {
      assert.deepEqual(values, ['NM', 'Jewelry - A', 'Jewelry', '{"kind":2}', 'kind', null, 0, 'draft', 'fixed_uah', false]);
      return { rows: [{ id: '14' }] };
    }
    assert.match(sql, /FROM price_weight_bands/); assert.deepEqual(values, [14]); return { rows: [] };
  });
  assert.deepEqual(await f.commands.createScenario({ category_code: 'NM', name: 'Jewelry - A',
    match_json: '{"kind":2}', axis_x_key: 'kind', price_mode: 'fixed_uah', apply_modifiers: false }, options), { id: 14 });
  assert.equal(f.events[0].eventKey, 'pricing.scenario.created');
  assert.equal(f.events[0].details.status, 'draft');
  assert.equal(f.events[0].details.weightBandCount, 0);
});

test('missing scenario update returns404 and always rolls back and releases', async (t) => {
  const f = fixture(t, (sql, values) => {
    assert.match(sql, /FROM price_scenarios/); assert.deepEqual(values, [4]); return { rows: [] };
  });
  await assert.rejects(f.commands.updateScenario(scenario, options), { statusCode: 404 });
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.lifecycle, ['connect', 'begin', 'rollback', 'release', 'client.release']);
});

test('unchanged scenario preserves matrix and emits no audit', async (t) => {
  const f = fixture(t, (sql) => {
    if (sql.includes('FROM price_scenarios')) return { rows: [scenario] };
    assert.match(sql, /FROM price_weight_bands/); return { rows: [] };
  });
  await f.commands.updateScenario(scenario, options);
  assert.deepEqual(f.events, []); assert.equal(f.calls.length, 2);
  assert.ok(f.lifecycle.includes('commit'));
});

test('removing weight-band axis deletes obsolete cells and bands in the same audited update', async (t) => {
  const f = fixture(t, (sql, values) => {
    if (sql.includes('FROM price_scenarios')) return { rows: [{ ...scenario, axis_x_key: 'weight_band' }] };
    if (sql.startsWith('UPDATE price_scenarios')) return { rowCount: 1 };
    if (sql.startsWith('SELECT id, label')) return { rows: [{ id: 8 }] };
    assert.match(sql, /^DELETE FROM price_(matrix|weight_bands)/); assert.deepEqual(values, [4]);
    return { rowCount: sql.includes('price_matrix') ? 3 : 1 };
  });
  await f.commands.updateScenario(scenario, options);
  assert.equal(f.events[0].eventKey, 'pricing.scenario.updated');
  assert.deepEqual(f.events[0].details.weightBandChanges, { created: 0, updated: 0, deleted: 1, matrixCellsDeleted: 3 });
});

test('duplicating a weight-band scenario remaps cells, excludes orphan cells, and stays draft', async (t) => {
  const f = fixture(t, (sql, values) => {
    if (sql.startsWith('SELECT * FROM price_scenarios')) return { rows: [{ ...scenario, axis_x_key: 'weight_band' }] };
    if (sql.includes('INSERT INTO price_scenarios')) {
      assert.match(sql, /'draft'/); assert.equal(values[1], 'Matrix (копія)'); return { rows: [{ id: 20 }] };
    }
    if (sql.startsWith('SELECT id, label')) return { rows: [{ id: 8, label: 'A', min_weight: '0', max_weight: '5', sort_order: 0 }] };
    if (sql.includes('INSERT INTO price_weight_bands')) return { rows: [{ id: '80' }] };
    if (sql.startsWith('SELECT x_val')) return { rows: [{ x_val: 8, y_val: 2, price: '7.5' }, { x_val: 9, y_val: 2, price: '10' }] };
    assert.match(sql, /INSERT INTO price_matrix/); assert.deepEqual(values, [20, 80, 2, 7.5]); return { rowCount: 1 };
  });
  assert.deepEqual(await f.commands.duplicateScenario(4, options), { success: true, id: 20 });
  assert.equal(f.events[0].details.copiedWeightBandCount, 1);
  assert.equal(f.events[0].details.copiedMatrixCellCount, 1);
});

test('duplicating an absent scenario cannot create a draft or audit', async (t) => {
  const f = fixture(t, (sql) => { assert.match(sql, /^SELECT \* FROM price_scenarios/); return { rows: [] }; });
  await assert.rejects(f.commands.duplicateScenario(999, options), { statusCode: 404 });
  assert.deepEqual(f.events, []); assert.ok(f.lifecycle.includes('rollback'));
});

test('modifier creation retains complete nested rule and derives its legacy trigger', async (t) => {
  const rule = { $or: [{ $and: [{ quality: [2, 3] }] }, { processing: 4 }] };
  const f = fixture(t, (sql, values) => {
    assert.match(sql, /INSERT INTO price_modifiers/);
    assert.deepEqual(values, ['NM', 'quality', 2, JSON.stringify(rule), 1.25]); return { rows: [{ id: '6' }] };
  });
  assert.deepEqual(await f.commands.createModifier({ category_code: 'NM', match_json: rule, factor: '1.25' }, options), { id: 6 });
  assert.equal(f.events[0].eventKey, 'pricing.modifier.created');
  assert.equal(f.events[0].details.triggerValue, 2);
});

for (const [label, row] of [['missing', null], ['unchanged', { id: 6, category_code: 'NM', trigger_key: 'quality', trigger_val: 2, match_json: { quality: 2 }, factor: '1.25' }]]) {
  test(`modifier ${label} update emits no mutation or audit`, async (t) => {
    const f = fixture(t, (sql) => { assert.match(sql, /FROM price_modifiers/); return { rows: row ? [row] : [] }; });
    await f.commands.updateModifier({ id: 6, factor: 1.25 }, options);
    assert.deepEqual(f.events, []); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.lifecycle.slice(-3), ['commit', 'release', 'client.release']);
  });
}

test('factor-only modifier update preserves the rule and trigger fields', async (t) => {
  const f = fixture(t, (sql, values) => {
    if (sql.startsWith('SELECT')) return { rows: [{ id: 6, category_code: 'NM', trigger_key: 'quality', trigger_val: 2, match_json: { quality: [2, 3] }, factor: '1.25' }] };
    assert.equal(sql, 'UPDATE price_modifiers SET factor = $1 WHERE id = $2');
    assert.deepEqual(values, [1.5, 6]); return { rowCount: 1 };
  });
  await f.commands.updateModifier({ id: 6, factor: 1.5 }, options);
  assert.deepEqual(Object.keys(f.events[0].details.changes), ['factor']);
});

test('modifier rule update does not leave stale legacy trigger metadata', async (t) => {
  const f = fixture(t, (sql, values) => {
    if (sql.startsWith('SELECT')) return { rows: [{ id: 6, category_code: 'NM', trigger_key: 'quality', trigger_val: 2, match_json: { quality: 2 }, factor: 1.25 }] };
    assert.match(sql, /SET trigger_key = \$1, trigger_val = \$2/);
    assert.deepEqual(values, ['processing', 0, '{"processing":0}', 1.25, 6]); return { rowCount: 1 };
  });
  await f.commands.updateModifier({ id: 6, factor: 1.25, trigger_key: 'processing', trigger_val: 0 }, options);
  assert.equal(f.events[0].eventKey, 'pricing.modifier.updated');
  assert.ok(f.events[0].details.changes.matchRule);
});
