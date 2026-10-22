const assert = require('node:assert/strict');
const pool = require('../../src/db/pool');

// Exercise the real lifecycle gate and audit writer; only PostgreSQL is replaced.
// Domain queries must be explicitly supplied by each scenario.
function catalogDb(t, { respond = () => undefined, auditError, phase = 'active' } = {}) {
  const queries = [];
  const events = [];
  let connections = 0;
  let releases = 0;
  const client = {
    async query(text, values) {
      const sql = text.replace(/\s+/g, ' ').trim();
      queries.push({ sql, values });
      if (/^SELECT pg_advisory_(lock|unlock)_shared\(/.test(sql)) {
        assert.deepEqual(values, ['amber_full_product_cutover']);
        return { rows: [] };
      }
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.startsWith('SET LOCAL amber.')) return { rows: [] };
      if (sql.startsWith('SELECT to_regclass(')) return { rows: [{ present: true }] };
      if (sql === 'SELECT * FROM full_product_export_activation WHERE singleton=TRUE') {
        return { rows: [{ phase, required_writer_version: 1 }] };
      }
      if (sql.startsWith('SELECT display_name, preferred_username FROM application_users')) {
        assert.deepEqual(values, [42]);
        return { rows: [{ display_name: 'Unit operator', preferred_username: 'unit-operator' }] };
      }
      if (sql.startsWith('INSERT INTO audit_events ')) {
        if (auditError) throw auditError;
        events.push({ key: values[0], actor: values[1], subjectType: values[3], subjectId: values[4],
          requestId: values[5], details: JSON.parse(values[6]) });
        return { rows: [{ id: String(events.length), occurred_at: '2026-10-01T00:00:00Z' }] };
      }
      const result = await respond(sql, values);
      assert.notEqual(result, undefined, `Unexpected domain query: ${sql}`);
      return result;
    },
    release() { releases++; },
  };
  t.mock.method(pool, 'connect', async () => { connections++; return client; });
  t.mock.method(pool, 'query', async () => assert.fail('Commands must use their transaction client'));
  return { queries, events, client,
    get connections() { return connections; },
    assertFinished(outcome = 'COMMIT') {
      assert.equal(connections, 1);
      assert.equal(releases, 1);
      assert.equal(queries.filter(q => q.sql === outcome).length, 1);
      assert.equal(queries.some(q => q.sql === (outcome === 'COMMIT' ? 'ROLLBACK' : 'COMMIT')), false);
      assert.equal(queries.filter(q => q.sql.startsWith('SELECT pg_advisory_unlock_shared(')).length, 1);
      assert.ok(queries.findIndex(q => q.sql === outcome) < queries.findIndex(q => q.sql.startsWith('SELECT pg_advisory_unlock_shared(')));
    },
    writes() { return queries.filter(q => /^(INSERT|UPDATE|DELETE)\b/.test(q.sql) && !q.sql.startsWith('INSERT INTO audit_events ')); },
  };
}

const mutationOptions = Object.freeze({ mutationContext: { actorUserId: 42, requestId: 'catalog-unit-request' } });
module.exports = { catalogDb, mutationOptions };
