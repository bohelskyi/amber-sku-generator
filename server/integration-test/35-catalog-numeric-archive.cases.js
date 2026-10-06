const suite = require('./suite-context');
const { test, assert, pool, request, authenticateApplicationSession } = suite;
const { insertProductFixture, insertNativeProductFixture } = require('./product-fixture');
const gate = require('../src/services/full-product-cutover-gate');

// Synthetic writes use the same transaction contract as runtime writers.
// Never disable active lifecycle or public identity constraints for this fixture.
async function catalogFixtureWrite(work) {
  const client = await pool.connect();
  try {
    await gate.begin(client);
    const result = await work(client);
    await gate.commit(client);
    return result;
  } catch (error) {
    await gate.rollback(client);
    throw error;
  } finally { await gate.release(client); client.release(); }
}


test('catalog archives restore original IDs and leave stored assignments and synchronization requests unchanged', async () => {
  if (!suite.authenticatedSession) suite.authenticatedSession = await authenticateApplicationSession('/admin');
  const code = `NA${Date.now().toString().slice(-8)}`;
  await catalogFixtureWrite((client) => client.query('INSERT INTO categories(code,name,requires_weight) VALUES($1,$2,0)', [code, 'Numeric archive']));
  const q = (await catalogFixtureWrite((client) => client.query("INSERT INTO questions(category_code,key,label,include_in_sku,input_type) VALUES($1,'choice','Choice',0,'options') RETURNING id", [code]))).rows[0].id;
  const o = (await catalogFixtureWrite((client) => client.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,0,'0','Zero') RETURNING id", [q]))).rows[0].id;
  const active = (await pool.query('SELECT enabled FROM public_sku_activation WHERE singleton')).rows[0].enabled;
  const product = (await catalogFixtureWrite((client) => active
    ? insertNativeProductFixture(client, { category: code, weight: 5, totalPriceUah: 42,
      details: { answers: { choice: 0, note: '0012' }, isCalibrated: 2 } })
    : insertProductFixture(client,
      "INSERT INTO products(full_sku,category,weight,total_price_uah,details) VALUES($1,$2,5,42,'{\"answers\":{\"choice\":0,\"note\":\"0012\"},\"isCalibrated\":2}') RETURNING *", [`${code}001`, code]))).rows[0];
  if (active) assert.ok(product.characteristic_version_id, 'native fixture must retain an immutable characteristic version');
  await catalogFixtureWrite((client) => client.query("INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id,state) VALUES($1,$2,'pending') ON CONFLICT (public_product_identity_id) DO NOTHING", [product.public_product_identity_id, product.id]));
  const jobs = (await pool.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1', [product.id])).rows;
  assert.equal(jobs.length, 1, 'archive comparison must retain an existing Magento obligation');
  const characteristic = active ? (await pool.query('SELECT * FROM product_characteristic_versions WHERE id=$1', [product.characteristic_version_id])).rows[0] : null;
  for (const archived of [true, false]) {
    for (const [type, id] of [['question', q], ['option', o]]) {
      const changed = await request(`/api/admin/${type}/${id}/archive`, { method: 'PATCH', body: { archived } });
      assert.equal(changed.response.status, 200, changed.text);
    }
    assert.deepEqual((await pool.query('SELECT * FROM products WHERE id=$1', [product.id])).rows[0], product);
    if (active) assert.deepEqual((await pool.query('SELECT * FROM product_characteristic_versions WHERE id=$1', [product.characteristic_version_id])).rows[0], characteristic);
    assert.deepEqual((await pool.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1', [product.id])).rows, jobs);
    const config = await request('/api/admin/config');
    const question = config.data.questions[code].find((item) => item.q_db_id === q);
    assert.equal(Boolean(question.archived), archived);
    assert.equal(question.options.find((item) => item.db_id === o).id, 0);
  }
  const impact = await request('/api/admin/catalog-impact', { method: 'POST', body: { type: 'question', id: q } });
  assert.equal(impact.response.status, 200, impact.text);
  assert.equal(impact.data.canDeleteLocal, false);
  assert.equal(impact.data.affectedCounts.products, 1);
  const deletion = await request('/api/admin/delete-item', { method: 'POST', body: { type: 'question', id: q,
    impactHash: impact.data.impactHash, confirmation: impact.data.confirmation } });
  assert.equal(deletion.response.status, 409, deletion.text);
  assert.equal((await pool.query('SELECT id FROM questions WHERE id=$1', [q])).rows[0].id, q);
});

test('numeric question rules and semantic allocation persist without generating a legacy code', async () => {
  if (!suite.authenticatedSession) suite.authenticatedSession = await authenticateApplicationSession('/admin');
  const code = `NV${Date.now().toString().slice(-8)}`;
  await catalogFixtureWrite((client) => client.query('INSERT INTO categories(code,name,requires_weight) VALUES($1,$2,0)', [code, 'Numeric rules']));
  const created = await request('/api/admin/question', { method: 'POST', body: { category_code: code, key: 'length', label: 'Length', input_type: 'text',
    display_order: 1, numeric_validation: { kind: 'decimal', unit: 'мм', min: '0', minInclusive: false, max: '99,9', maxInclusive: true, maxFractionDigits: 1 } } });
  assert.equal(created.response.status, 200, created.text);
  const config = await request('/api/admin/config');
  assert.deepEqual(config.data.questions[code][0].numeric_validation,
    { kind: 'decimal', unit: 'мм', min: 0, minInclusive: false, max: 99.9, maxInclusive: true, maxFractionDigits: 1 });
  const q = (await catalogFixtureWrite((client) => client.query("INSERT INTO questions(category_code,key,label,include_in_sku,input_type) VALUES($1,'shape','Shape',0,'options') RETURNING id", [code]))).rows[0].id;
  const options = await Promise.all(['First', 'Second'].map((label) => request('/api/admin/option', { method: 'POST', body: { question_id: q, label } })));
  for (const option of options) assert.equal(option.response.status, 200, option.text);
  assert.notEqual(options[0].data.value_id, options[1].data.value_id);
  const saved = await pool.query('SELECT value_id,sku_code FROM options WHERE question_id=$1', [q]);
  assert.equal(saved.rows.length, 2);
  assert.equal(saved.rows.every((item) => Number.isInteger(item.value_id) && item.sku_code === null), true);
  const impact = await request('/api/admin/catalog-impact', { method: 'POST', body: { type: 'option', id: options[0].data.id } });
  assert.equal(impact.data.canDeleteLocal, true);
  const deleted = await request('/api/admin/delete-item', { method: 'POST', body: { type: 'option', id: options[0].data.id,
    impactHash: impact.data.impactHash, confirmation: impact.data.confirmation } });
  assert.equal(deleted.response.status, 200, deleted.text);
  const reuse = await request('/api/admin/option', { method: 'POST', body: { question_id: q, label: 'Reinterpreted', value_id: options[0].data.value_id } });
  assert.equal(reuse.response.status, 409, reuse.text);
});

test('native snapshot row locks serialize question and option inserts on independent connections', async () => {
  const code = `NR${Date.now().toString().slice(-8)}`;
  await catalogFixtureWrite((client) => client.query('INSERT INTO categories(code,name,requires_weight) VALUES($1,$2,0)', [code, 'Catalog fence']));
  const q = (await catalogFixtureWrite((client) => client.query("INSERT INTO questions(category_code,key,label,include_in_sku,input_type) VALUES($1,'existing','Existing',0,'options') RETURNING id", [code]))).rows[0].id;
  const saving = await pool.connect(), editing = await pool.connect();
  try {
    const savePid = Number((await saving.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const editPid = Number((await editing.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    for (const type of ['question', 'option']) {
      await gate.begin(saving);
      await gate.begin(editing);
      await saving.query('SELECT code FROM categories WHERE code=$1 FOR SHARE', [code]);
      await saving.query('SELECT id FROM questions WHERE category_code=$1 ORDER BY id FOR SHARE', [code]);
      const pending = editing.query(type === 'question'
        ? "INSERT INTO questions(category_code,key,label,include_in_sku,input_type) VALUES($1,'later','Later',0,'text') RETURNING id"
        : "INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,300000,NULL,'Later option') RETURNING id", [type === 'question' ? code : q]);
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const state = await saving.query('SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked', [savePid, editPid]);
        if (state.rows[0].blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!blocked) { await gate.rollback(saving); await pending; await gate.rollback(editing); assert.fail(`${type} insert was not blocked by the native snapshot lock`); }
      const before = await saving.query(type === 'question'
        ? "SELECT COUNT(*)::int AS count FROM questions WHERE category_code=$1 AND key='later'"
        : 'SELECT COUNT(*)::int AS count FROM options WHERE question_id=$1 AND value_id=300000', [type === 'question' ? code : q]);
      assert.equal(before.rows[0].count, 0);
      await gate.commit(saving);
      const completed = await pending;
      await gate.commit(editing);
      assert.equal(completed.rows.length, 1);
      const after = await pool.query(type === 'question' ? 'SELECT id FROM questions WHERE id=$1' : 'SELECT id FROM options WHERE id=$1', [completed.rows[0].id]);
      assert.equal(after.rows.length, 1);
    }
  } finally {
    await gate.rollback(saving); await gate.rollback(editing);
    await gate.release(saving); await gate.release(editing);
    saving.release(); editing.release();
  }
});
