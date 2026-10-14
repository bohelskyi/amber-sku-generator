'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { csvUndelivered } = require('../src/services/magento/first-sync-cutover-admission');

const client = (enabled) => ({ queries: 0, async query(sql) {
  this.queries++;
  assert.match(sql, /legacy_product_csv_enabled/);
  return { rows: enabled === undefined ? [] : [{ legacy_product_csv_enabled: enabled }] };
} });
const row = (revision, csvRetired, baseline = '1') => ({ revision, csv_retired_revision: csvRetired, cutover_baseline_revision: baseline });

test('an untouched baseline remains admissible without reading the CSV gate', async () => {
  const db = client(true);
  assert.equal(await csvUndelivered(db, row('1', '0')), true);
  assert.equal(db.queries, 0);
});

test('a later revision retired at birth is admissible only while legacy CSV is disabled', async () => {
  assert.equal(await csvUndelivered(client(false), row('2', '2')), true);
  assert.equal(await csvUndelivered(client(true), row('2', '2')), false, 'CSV enabled could have exported it');
  assert.equal(await csvUndelivered(client(undefined), row('2', '2')), false, 'missing gate fails closed');
});

test('any CSV-retired counter that does not cover the latest post-baseline revision still blocks', async () => {
  assert.equal(await csvUndelivered(client(false), row('3', '2')), false, 'a later revision was not retired at birth');
  assert.equal(await csvUndelivered(client(false), row('1', '1')), false, 'retirement at the baseline revision itself');
  assert.equal(await csvUndelivered(client(false), row('2', '3')), false, 'inconsistent counters');
});
