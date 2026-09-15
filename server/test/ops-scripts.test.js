const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('restore explicitly replaces only the configured application database', () => {
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
  assert.match(script, /report_destructive_restore_failure/);
  assert.match(script, /intentionally left stopped/);
  assert.match(script, /dropdb .*--maintenance-db=postgres .*--force .*\$POSTGRES_DB/);
  assert.match(script, /createdb .*--maintenance-db=postgres .*--owner="\$POSTGRES_USER" .*--template=template0 .*\$POSTGRES_DB/);
  assert.match(script, /postgres\|template0\|template1/);
  assert.match(script, /\$POSTGRES_USER/);
  assert.match(script, /\$POSTGRES_DB/);
  assert.doesNotMatch(script, /pg_restore [^\n]*--clean/);
  assert.doesNotMatch(script, /docker compose start server client/);
  assert.doesNotMatch(script, /trap '[^']*restart_previously_running_services/);
  assert.doesNotMatch(script, /--username=amber/);
  assert.ok(script.indexOf('pg_restore --list') < script.indexOf('exec dropdb'));
  assert.ok(script.indexOf('docker compose stop client server') < script.indexOf('exec dropdb'));
  assert.ok(script.indexOf('exec dropdb') < script.indexOf('exec createdb'));
  assert.ok(script.indexOf('exec createdb') < script.lastIndexOf('exec pg_restore'));
  assert.ok(script.indexOf('SELECT COUNT(*) AS products') < script.indexOf('trap - EXIT'));
  assert.ok(
    script.indexOf('trap - EXIT') < script.lastIndexOf('\nrestart_previously_running_services\n')
  );
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
  assert.match(script, /\$POSTGRES_USER/);
  assert.match(script, /\$POSTGRES_DB/);
  assert.doesNotMatch(script, /--username=amber/);
});
