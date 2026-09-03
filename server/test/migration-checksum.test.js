const assert = require('node:assert/strict');
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
