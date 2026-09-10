const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { getMigrationChecksum } = require('../src/db/run-migrations');

test('migration checksum is identical for LF and CRLF SQL', () => {
  const lfSql = 'CREATE TABLE example (\n  id INTEGER PRIMARY KEY\n);\n';
  const crlfSql = lfSql.replace(/\n/g, '\r\n');

  assert.equal(getMigrationChecksum(crlfSql), getMigrationChecksum(lfSql));
});

test('migration checksum changes when SQL content changes', () => {
  const originalSql = 'CREATE TABLE example (\n  id INTEGER PRIMARY KEY\n);\n';
  const changedSql = 'CREATE TABLE example (\n  id BIGINT PRIMARY KEY\n);\n';

  assert.notEqual(getMigrationChecksum(changedSql), getMigrationChecksum(originalSql));
});

test('applied migration 019 remains byte-for-byte checksum compatible', () => {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../migrations/019_postgres_session_store.sql'),
    'utf8'
  );
  assert.equal(
    getMigrationChecksum(sql),
    'ce82880d98bb4a90b0376be27e8e34fafd9aa9e917ce1b7787194799e8c83196'
  );
});
