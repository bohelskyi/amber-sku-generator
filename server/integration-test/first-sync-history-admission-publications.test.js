'use strict';
require('../test/setup-env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const c = require('../src/services/magento/binding-contract');
const helper = require('../src/services/magento/first-sync-history-admission');

// Real PostgreSQL: the recount admission receipt lookup reads the receipt binding
// and the current publication version in one statement. Without a receipt it
// still denies with the original reason and performs no write.
test('recount admission lookup runs on PostgreSQL with the current publication version parameter', async t => {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname, '127.0.0.1'); assert.ok(source.pathname.endsWith('_test'));
  const name = 'amber_history_publications_' + process.pid + '_test';
  const control = new Client({ connectionString: source.toString() }); await control.connect();
  let created = false, db;
  t.after(async () => { if (db) await db.end(); if (created) await control.query('DROP DATABASE ' + name); await control.end(); });
  await require('./harness').createTestDatabase(name); created = true;
  const target = new URL(source); target.pathname = '/' + name;

  db = new Pool({ connectionString: target.toString(), max: 2 });
  const config = { baseUrl: 'https://publications.invalid' };
  const observation = { amber: { product: { id: 424242, public_product_identity_id: '424242', public_sku: 'AG-424242' },
    revision: { id: '55555555-5555-4555-8555-555555555555', originHash: c.originHash(config.baseUrl), installationKey: 'publications' } },
  raw: { id: 9001, sku: 'AG-424242' } };
  const client = await db.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await helper.readOnClient(client, config, observation);
    assert.deepEqual(result, { admission: null, reason: 'FIRST_SYNC_HISTORY_ADMISSION_RECEIPT_REQUIRED', evidenceHash: null });
    await client.query('COMMIT');
  } finally { client.release(); }
});
