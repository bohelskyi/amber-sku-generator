const { hashPayload } = require('../pricing/pricing-context-fingerprint');
const access = require('../access-admin-transaction');
const failure = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });

function normalizeCreationAttempt(payload) {
  if (payload.idempotencyKey === undefined) return null;
  if (typeof payload.idempotencyKey !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.idempotencyKey)) {
    throw failure(422, 'CREATION_IDEMPOTENCY_KEY_INVALID', 'Потрібен UUID початкової спроби збереження.');
  }
  return { key: payload.idempotencyKey.toLowerCase(), requestHash: hashPayload(payload) };
}

async function lockAuthority(client) {
  await client.query('SELECT pg_advisory_lock_shared(hashtext($1))', [access.APPLICATION_USER_ADMIN_LOCK_KEY]);
}
async function releaseAuthority(client) {
  await client.query('SELECT pg_advisory_unlock_shared(hashtext($1))', [access.APPLICATION_USER_ADMIN_LOCK_KEY]);
}
async function recover(client, attempt, actorUserId) {
  await access.assertActorStillAuthorized(client, actorUserId, 'products.create', failure);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`product-creation:${actorUserId}:${attempt.key}`]);
  const row = (await client.query(`SELECT request_hash,result FROM product_creation_receipts
    WHERE actor_user_id=$1 AND idempotency_key=$2`, [actorUserId, attempt.key])).rows[0];
  if (!row) return null;
  if (row.request_hash !== attempt.requestHash) {
    throw failure(409, 'CREATION_ATTEMPT_CONFLICT', 'Ця спроба збереження вже має інші незмінні параметри.');
  }
  return row.result;
}
async function record(client, attempt, actorUserId, result) {
  await client.query(`INSERT INTO product_creation_receipts(actor_user_id,idempotency_key,request_hash,product_id,result)
    VALUES($1,$2,$3,$4,$5::jsonb)`, [actorUserId, attempt.key, attempt.requestHash, result.id, JSON.stringify(result)]);
}
module.exports = { normalizeCreationAttempt, lockAuthority, releaseAuthority, recover, record };
