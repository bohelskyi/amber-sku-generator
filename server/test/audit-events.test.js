const assert = require('node:assert/strict');
const test = require('node:test');

const { writeAuditEvent } = require('../src/audit/audit-events');
const {
  createMutationContext,
  getRequestMutationContext,
} = require('../src/audit/mutation-context');

test('mutation context accepts only a local application-user ID and normalizes request IDs', () => {
  assert.deepEqual(createMutationContext({
    actorUserId: '17',
    requestId: '  request-17  ',
  }), {
    actorUserId: 17,
    requestId: 'request-17',
  });
  assert.deepEqual(getRequestMutationContext({
    applicationUser: { id: 23 },
    requestId: 'request-23',
    user: { sub: 'must-not-be-used' },
  }), {
    actorUserId: 23,
    requestId: 'request-23',
  });
  for (const actorUserId of [undefined, null, '', 0, -1, 'oidc-subject']) {
    assert.throws(
      () => createMutationContext({ actorUserId, requestId: 'request' }),
      /positive integer/
    );
  }
});

test('transaction-scoped audit writer snapshots only event-time actor display fields', async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/SELECT display_name/.test(sql)) {
        return {
          rows: [{
            display_name: 'Event Time Name',
            preferred_username: 'event.time',
            issuer: 'must-not-be-snapshotted',
            subject: 'must-not-be-snapshotted',
          }],
        };
      }
      return { rows: [{ id: '81', occurred_at: new Date('2026-09-10T12:00:00Z') }] };
    },
  };

  await writeAuditEvent(client, {
    mutationContext: createMutationContext({
      actorUserId: 7,
      requestId: 'audit-request-7',
    }),
    eventKey: 'application_user.disabled',
    subjectType: 'application_user',
    subjectId: 19,
    details: { previousStatus: 'active', newStatus: 'disabled' },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, [7]);
  assert.deepEqual(JSON.parse(calls[1].values[2]), {
    displayName: 'Event Time Name',
    preferredUsername: 'event.time',
  });
  assert.equal(calls[1].values[5], 'audit-request-7');
  assert.deepEqual(JSON.parse(calls[1].values[6]), {
    previousStatus: 'active',
    newStatus: 'disabled',
  });
  assert.doesNotMatch(JSON.stringify(calls[1].values), /issuer|subject|must-not-be/);
});

test('audit writer fails closed when the local actor row does not exist', async () => {
  let inserts = 0;
  const client = {
    async query(sql) {
      if (/SELECT display_name/.test(sql)) return { rows: [] };
      inserts += 1;
      return { rows: [] };
    },
  };

  await assert.rejects(
    writeAuditEvent(client, {
      mutationContext: createMutationContext({ actorUserId: 999, requestId: 'missing-actor' }),
      eventKey: 'application_user.enabled',
      subjectType: 'application_user',
      subjectId: 1,
    }),
    /actor application user was not found/
  );
  assert.equal(inserts, 0);
});
