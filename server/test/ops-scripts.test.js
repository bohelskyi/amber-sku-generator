const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('restore is explicit and atomic', () => {
  const script = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/postgres-restore.sh'),
    'utf8'
  );
  assert.match(script, /--confirm/);
  assert.match(script, /--single-transaction/);
  assert.match(script, /--exit-on-error/);
  assert.match(script, /pg_restore --list/);
  assert.match(script, /docker compose stop client server/);
  assert.match(script, /docker compose ps --status running --services/);
  assert.match(script, /restart_previously_running_services/);
  assert.doesNotMatch(script, /docker compose start server client/);
});

test('backup verifies a non-empty readable custom archive', () => {
  const script = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/postgres-backup.sh'),
    'utf8'
  );
  assert.match(script, /--format=custom/);
  assert.match(script, /test -s/);
  assert.match(script, /pg_restore --list/);
  assert.match(script, /trap .*rm -f/);
});
