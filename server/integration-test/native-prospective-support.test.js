const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { readCharacteristicConfiguration } = require('../src/services/product/characteristic-config');
const { loadProspectiveSupportInput } = require('../src/services/export-templates/support-inputs');
const { sourceSupportChecker } = require('../src/services/export-templates/source-support');

test('prospective evidence shares the read-only RR snapshot and rejects a later changed catalog without writes', async () => {
  const source = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = `amber_native_prospective_${process.pid}_test`, control = new Client({ connectionString: source.toString() });
  await control.connect(); let db, other, created = false;
  try {
    await control.query(`CREATE DATABASE ${name}`); created = true;
    const target = new URL(source); target.pathname = `/${name}`;
    db = new Client({ connectionString: target.toString() }); other = new Client({ connectionString: target.toString() });
    await db.connect(); await other.connect();
    await db.query('CREATE TABLE categories(code text PRIMARY KEY, requires_weight integer); CREATE TABLE questions(id integer,category_code text,key text,label text,input_type text,required integer,display_order integer,sku_index integer,include_in_sku integer,visible_if_json jsonb,archived boolean,numeric_validation jsonb); CREATE TABLE options(id integer,question_id integer,value_id integer,label text,label_en text,visible_if_json jsonb,hidden_if_json jsonb,archived boolean)');
    await db.query("INSERT INTO categories VALUES('NM',0); INSERT INTO questions VALUES(1,'NM','extra','Extra','options',1,1,1,0,NULL,false,NULL); INSERT INTO options VALUES(1,1,1,'One',NULL,NULL,NULL,false)");
    const d = { evaluatorVersion: 'magento-declarative-5', sourceContractVersion: 'public-product-characteristics-v1', sourceSupport: { sources: { 'NM.extra': { semanticValues: ['1'] } } } };
    const p = { id: null, category: 'NM', public_sku: 'AG-PREVIEW', full_sku: null, sku_schema_version_id: null };
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const hash = (await readCharacteristicConfiguration(db, 'NM')).config_hash;
    await other.query("UPDATE options SET label='Changed' WHERE id=1");
    const projected = await loadProspectiveSupportInput(db, d, p, hash);
    sourceSupportChecker(d, projected)({ kind: 'semantic', category: 'NM', key: 'extra' }, 1);
    await db.query('COMMIT');
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await assert.rejects(loadProspectiveSupportInput(db, d, p, hash), { code: 'PRODUCT_CHARACTERISTICS_CHANGED' });
    await db.query('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int n FROM categories')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int n FROM options')).rows[0].n, 1);
  } finally {
    if (db) await db.end(); if (other) await other.end();
    if (created) await control.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await control.end();
  }
});
