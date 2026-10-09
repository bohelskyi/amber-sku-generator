const { hashPayload } = require('../pricing/pricing-context-fingerprint');
const access = require('../access-admin-transaction');
const receipts = require('./product-creation-receipts');
const tests = require('./test-products');
const gate = require('../full-product-cutover-gate');
const pool = require('../../db/pool');
const failure = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });

async function transaction(payload, options, operation) {
  const attempt = receipts.normalizeCreationAttempt(payload);
  if (!attempt) throw failure(422, 'CREATION_RESERVATION_KEY_REQUIRED', 'Потрібна незмінна спроба створення товару.');
  const actor = Number(options.mutationContext?.actorUserId);
  const client = await (options.databasePool || pool).connect();
  let authorityHeld = false;
  try {
    await receipts.lockAuthority(client); authorityHeld = true;
    await gate.begin(client, 'BEGIN');
    await access.assertActorStillAuthorized(client, actor, 'products.create', failure);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`product-creation:${actor}:${attempt.key}`]);
    if (!(await client.query('SELECT enabled FROM public_sku_activation WHERE singleton FOR SHARE')).rows[0]?.enabled) {
      throw failure(409, 'CREATION_RESERVATION_NATIVE_REQUIRED', 'Резервація артикула потребує публічної ідентичності.');
    }
    const result = await operation(client, actor, attempt.key);
    await gate.commit(client);
    return result;
  } catch (error) { await gate.rollback(client); throw error; }
  finally {
    await gate.release(client);
    if (authorityHeld) await receipts.releaseAuthority(client);
    client.release();
  }
}

async function read(client, actor, key) {
  return (await client.query(`SELECT r.*,i.public_sku FROM product_creation_sku_reservations r
    LEFT JOIN public_product_identities i ON i.id=r.public_product_identity_id
    WHERE r.actor_user_id=$1 AND r.idempotency_key=$2 FOR UPDATE OF r`, [actor, key])).rows[0];
}
function metadata(row) {
  return { version: 1, idempotencyKey: row.idempotency_key, publicSku: row.public_sku,
    categoryCode: row.category_code, isTestProduct: row.is_test_product };
}
async function reserve(client, payload, actor, { allocate = false } = {}) {
  const key = receipts.normalizeCreationAttempt(payload)?.key;
  if (!key) throw failure(422, 'CREATION_RESERVATION_KEY_REQUIRED', 'Потрібна незмінна спроба створення товару.');
  const category = String(payload.categoryCode || payload.category || '').trim().toUpperCase();
  const isTest = tests.normalizeFlag(payload);
  if (isTest) { await tests.assertAdministrator(client, actor); await tests.assertNamespaceAvailable(client); }
  if ((await client.query('SELECT 1 FROM product_creation_receipts WHERE actor_user_id=$1 AND idempotency_key=$2', [actor, key])).rows.length) {
    throw failure(409, 'CREATION_RESERVATION_CLOSED', 'Цю спробу вже збережено. Відкрийте новий товар.');
  }
  let row = await read(client, actor, key);
  if (row && (row.category_code !== category || row.is_test_product !== isTest)) {
    throw failure(409, 'CREATION_RESERVATION_CONTEXT_CONFLICT', 'Артикул зарезервовано для іншої категорії або типу товару.');
  }
  if (row && row.state !== 'reserved') {
    throw failure(409, 'CREATION_RESERVATION_CLOSED', 'Цю спробу вже скасовано або збережено. Відкрийте новий товар.');
  }
  if (!row && allocate) {
    const identity = isTest
      ? (await client.query(`WITH allocation AS (SELECT nextval('test_product_sku_sequence') AS n)
          INSERT INTO public_product_identities(public_sku,test_allocation_number,origin,is_test_product)
          SELECT 'TEST-'||lpad(n::text,GREATEST(6,length(n::text)),'0'),n,'allocated',TRUE FROM allocation RETURNING id`)).rows[0]
      : (await client.query(`WITH allocation AS (SELECT nextval('public_product_sku_sequence') AS n)
          INSERT INTO public_product_identities(public_sku,allocation_number,origin)
          SELECT 'AG-'||lpad(n::text,GREATEST(6,length(n::text)),'0'),n,'allocated' FROM allocation RETURNING id`)).rows[0];
    await client.query(`INSERT INTO product_creation_sku_reservations
      (actor_user_id,idempotency_key,category_code,is_test_product,public_product_identity_id)
      VALUES($1,$2,$3,$4,$5)`, [actor, key, category, isTest, identity.id]);
    row = await read(client, actor, key);
  }
  if (!row) throw failure(409, 'CREATION_RESERVATION_REQUIRED', 'Оновіть перевірку, щоб зарезервувати артикул.');
  const result = metadata(row);
  if (payload.skuReservation !== undefined && hashPayload(payload.skuReservation) !== hashPayload(result)) {
    throw failure(409, 'CREATION_RESERVATION_STALE', 'Резервація артикула не відповідає перевіреній спробі.');
  }
  return result;
}

async function cancel(payload, options = {}) {
  return transaction(payload, options, async (client, actor, key) => {
    const receipt = (await client.query(`SELECT result FROM product_creation_receipts
      WHERE actor_user_id=$1 AND idempotency_key=$2`, [actor, key])).rows[0];
    if (receipt) return { state: 'consumed', result: receipt.result };
    const row = await read(client, actor, key);
    if (row?.state === 'consumed') throw failure(409, 'CREATION_RESERVATION_CLOSED', 'Товар уже збережено. Перевірте результат спроби.');
    if (row?.state === 'reserved') await client.query(`UPDATE product_creation_sku_reservations
      SET state='cancelled',closed_at=CURRENT_TIMESTAMP WHERE actor_user_id=$1 AND idempotency_key=$2`, [actor, key]);
    if (!row) {
      const category = String(payload.categoryCode || '').trim().toUpperCase();
      const isTest = tests.normalizeFlag(payload);
      if (isTest) await tests.assertAdministrator(client, actor);
      await client.query(`INSERT INTO product_creation_sku_reservations
        (actor_user_id,idempotency_key,category_code,is_test_product,state,closed_at)
        VALUES($1,$2,$3,$4,'cancelled',CURRENT_TIMESTAMP)`, [actor, key, category, isTest]);
    }
    return { state: 'cancelled' };
  });
}

module.exports = { transaction, reserve, cancel };
