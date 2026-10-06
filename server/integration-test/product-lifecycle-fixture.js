const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const lifecycle = require('../src/services/product-lifecycle.service');
const state = require('../src/services/product-lifecycle-state');
const visibility = require('../src/services/magento/product-visibility-worker');
const { runAccessAdminMutation } = require('../src/services/access-admin-transaction');
const c = require('../src/services/magento/binding-contract');
const { insertProductFixture } = require('./product-fixture');

const config = { configured: true, baseUrl: 'https://archive-fixture.invalid', consumerKey: 'fixture',
  consumerSecret: 'fixture', accessToken: 'fixture', accessTokenSecret: 'fixture' };
async function migrationWithoutEnrollment(db, migrate) {
  assert.equal((await db.query("SELECT to_regclass('product_visibility_intents') AS present")).rows[0].present, null);
  await db.query("INSERT INTO categories(code,name) VALUES('KL','Archive migration fixture') ON CONFLICT DO NOTHING");
  await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah,status,exclude_from_export,details)
    VALUES($1,'KL',240,'archived',1,'{"answers":{"weight":12.7},"logMessage":"pre064 archive"}') RETURNING *`, [`KL3/UPGRADE-${randomUUID()}`]);
  const snapshot = async () => (await db.query(`SELECT
    (SELECT jsonb_agg(p ORDER BY id) FROM products p) AS products,
    (SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) AS lifecycle,
    (SELECT jsonb_agg(r ORDER BY public_product_identity_id) FROM magento_product_sync_requests r) AS requests,
    (SELECT jsonb_agg(j ORDER BY id) FROM magento_sync_jobs j) AS jobs,
    (SELECT count(*)::int FROM audit_events) AS audits`)).rows[0];
  const before = await snapshot(); assert.equal(before.products.length, 1); assert.equal(before.products[0].status, 'archived');
  await migrate();
  assert.deepEqual(await snapshot(), before, '064 must preserve every existing archived product, lifecycle, native request, job and audit');
  for (const table of ['product_visibility_intents', 'product_restore_batches', 'product_restore_items']) {
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0, `${table} must have no historical enrollment`);
  }
}
async function run(db, t) {
  assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name.endsWith('_test'), true);
  const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Archive fixture') RETURNING id")).rows[0].id);
  await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
  for (const category of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']) await db.query('INSERT INTO categories(code,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [category]);
  const options = { config, databasePool: db, mutationContext: { actorUserId: actor, requestId: 'archive-restore-fixture' } };
  const origin = c.originHash(config.baseUrl);
  const fixture = require('../test/fixtures/magento-bindings');
  const templates = require('../src/services/export-templates/template.service');
  const bindings = require('../src/services/magento/binding.service');
  const definition = structuredClone(fixture.definition());
  definition.sources = { sku: definition.sources.sku }; definition.tables = {};
  for (const group of definition.groups) for (const row of group.rows) row.cells = Object.fromEntries(
    Object.entries(row.cells).filter(([key]) => ['sku', 'store_view_code', 'name', 'attribute_set_code', 'product_type', 'price'].includes(key)));
  const template = await templates.createTemplate({ key: `archive-${randomUUID()}`, displayName: 'Archive fixture', definition }, options);
  const version = await templates.publishTemplate(template.id, { expectedRevision: template.draft.revision,
    expectedDefinitionHash: template.draft.definitionHash }, options);
  let draft = await bindings.createDraft({ installationKey: 'archive-fixture', origin: config.baseUrl,
    templateVersionId: version.id, observedAt: new Date().toISOString(), schema: fixture.schema() }, options);
  draft = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: fixture.approvedBindings(definition) }, options);
  const publication = await bindings.publishDraft(draft.id, { expectedRevision: draft.revision, expectedCurrentId: null }, options);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL amber.lifecycle_maintenance='on'");
    await client.query("SET LOCAL amber.magento_delivery_cutover='on'");
    const event = (await client.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('product.fixture',$1,'{"displayName":"Archive fixture","preferredUsername":null}','fixture','archive','fixture') RETURNING id`, [actor])).rows[0].id;
    await client.query(`UPDATE full_product_export_activation SET phase='preparing',generation=generation+1,
      manifest_hash=$1,approval_event_id=$2 WHERE singleton`, [c.hash('fixture'), event]);
    await client.query(`UPDATE full_product_export_activation SET phase='active',selector_version=1,generation=generation+1,
      activation_event_id=$1 WHERE singleton`, [event]);
    await client.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='archive-fixture',actor_user_id=$1,
      legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`, [actor, event]);
    await client.query('COMMIT');
  } finally { await client.query('ROLLBACK'); client.release(); }
  assert.equal((await db.query('SELECT count(*)::int n FROM product_visibility_intents')).rows[0].n, 0,
    'Migration/startup must not enroll historical archived rows');
  async function make({ known = true, sku = `KL3/${randomUUID()}` } = {}) {
    const product = await runAccessAdminMutation({ databasePool: db, actorUserId: actor, requiredPermission: 'products.archive', createError: c.error,
      operation: async (client) => {
        const inserted = (await insertProductFixture(client, `INSERT INTO products(full_sku,category,total_price_uah,weight,details)
          VALUES($1,'KL',240,12.7,'{"answers":{"is_calibrated":2,"weight":12.7},"logMessage":"keep me"}') RETURNING *`, [sku])).rows[0];
        await client.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1", [inserted.id]);
        return inserted;
      } });
    if (known) await nativeAck(product);
    return product;
  }
  async function nativeAck(product) {
    const request = (await db.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=$1', [product.public_product_identity_id])).rows[0];
    await db.query(`INSERT INTO magento_sync_jobs(id,product_id,sku,installation_key,origin_hash,binding_revision_id,binding_hash,
      amber_hash,plan_hash,intent,baseline,state,remote_product_id,created_by_user_id,acknowledged_at,automatic_generation,public_product_identity_id)
      VALUES($1,$2,$3,'archive-fixture',$4,$5,$6,$6,$6,'{}','{}','succeeded',$7,$8,CURRENT_TIMESTAMP,$9,$10)`,
    [randomUUID(), product.id, product.full_sku, origin, publication.id, c.hash(randomUUID()), product.id + 10000, actor,
      request.desired_generation, product.public_product_identity_id]);
    await db.query(`UPDATE magento_product_sync_requests SET state='synced',reason_code=NULL,synced_generation=desired_generation
      WHERE public_product_identity_id=$1`, [product.public_product_identity_id]);
  }
  async function archive(product) {
    return runAccessAdminMutation({ databasePool: db, actorUserId: actor, requiredPermission: 'products.archive', createError: c.error,
      operation: async (client) => {
        const previous = await state.readTarget(client, product.id, { origin, lock: true });
        await client.query("UPDATE products SET status='archived',exclude_from_export=1,archived_by_user_id=$2 WHERE id=$1", [product.id, actor]);
        await require('../src/services/full-product-export.service').retireFullProduct(client, product.id);
        return lifecycle.queueArchivedVisibility(client, { productId: product.id, actorUserId: actor, mutationContext: options.mutationContext,
          previousProduct: previous.product, previousLifecycle: previous.lifecycle }, options);
      } });
  }
  const command = (review) => ({ skus: review.skus, reviewNonce: review.reviewNonce, reviewHash: review.reviewHash, confirmRestoreAndSync: true });
  async function unfinishedNative(product, { automatic = true, step = null, jobState = 'queued' } = {}) {
    await db.query('UPDATE products SET total_price_uah=total_price_uah+1 WHERE id=$1', [product.id]);
    const request = (await db.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=$1', [product.public_product_identity_id])).rows[0];
    const id = randomUUID();
    await db.query(`INSERT INTO magento_sync_jobs(id,product_id,sku,installation_key,origin_hash,binding_revision_id,binding_hash,
      amber_hash,plan_hash,intent,baseline,state,created_by_user_id,automatic_generation,public_product_identity_id)
      VALUES($1,$2,$3,'archive-fixture',$4,$5,$6,$6,$6,'{}','{}',$7,$8,$9,$10)`,
    [id, product.id, product.full_sku, origin, publication.id, c.hash(randomUUID()), jobState, actor,
      automatic ? request.desired_generation : null, product.public_product_identity_id]);
    if (step) await db.query(`INSERT INTO magento_sync_steps(job_id,ordinal,state,dispatched_at,verified_at)
      VALUES($1,0,$2,CURRENT_TIMESTAMP,CASE WHEN $2='verified' THEN CURRENT_TIMESTAMP ELSE NULL END)`, [id, step]);
    if (automatic) await db.query(`UPDATE magento_product_sync_requests SET active_job_id=$2,active_generation=desired_generation,state='syncing'
      WHERE product_id=$1`, [product.id, id]);
    return id;
  }
  async function unfinishedMedia(product, mediaState, withStep = false) {
    const id = randomUUID();
    const request = (await db.query('SELECT desired_generation FROM magento_product_sync_requests WHERE product_id=$1', [product.id])).rows[0];
    await db.query(`INSERT INTO product_media_jobs(id,product_id,public_product_identity_id,version,photo_ids,
      enable_when_verified,actor_user_id,request_key,required_permission,intent_hash,state,origin_hash,
      binding_revision_id,remote_product_id,native_generation)
      VALUES($1,$2,$3,1,'{}',FALSE,$4,$5,'products.create',$6,$7,$8,$9,$10,$11)`,
    [id, product.id, product.public_product_identity_id, actor, randomUUID(), c.hash(randomUUID()), mediaState,
      mediaState === 'pending' ? null : origin, mediaState === 'pending' ? null : publication.id,
      mediaState === 'pending' ? null : product.id + 10000, mediaState === 'pending' ? null : request.desired_generation]);
    if (withStep) await db.query(`INSERT INTO product_media_steps(job_id,step_key,operation_hash)
      VALUES($1,'hide',$2)`, [id, c.hash(randomUUID())]);
    return id;
  }
  async function productEvidence(product) {
    return (await db.query(`SELECT
      (SELECT to_jsonb(p) FROM products p WHERE p.id=$1) AS product,
      (SELECT to_jsonb(f) FROM product_full_export_state f WHERE f.product_id=$1) AS lifecycle,
      (SELECT to_jsonb(r) FROM magento_product_sync_requests r WHERE r.product_id=$1) AS request,
      (SELECT jsonb_agg(j ORDER BY id) FROM product_media_jobs j WHERE j.product_id=$1) AS media_jobs,
      (SELECT jsonb_agg(s ORDER BY s.step_key) FROM product_media_steps s JOIN product_media_jobs j ON j.id=s.job_id
        WHERE j.product_id=$1) AS media_steps,
      (SELECT jsonb_agg(v ORDER BY id) FROM product_visibility_intents v WHERE v.product_id=$1) AS visibility,
      (SELECT count(*)::int FROM audit_events WHERE subject_id=$1::text AND event_key IN ('product.archived','product.restored','product.visibility_requested')) AS audits`,
    [product.id])).rows[0];
  }
  await t.test('archive proof, reviewed restore and concurrent same-review recovery preserve metadata and coalesce native delivery', async () => {
    const product = await make();
    const archived = await archive(product); assert.equal(archived.status, 'queued');
    const repeated = await archive(product); assert.equal(repeated.intentId, archived.intentId);
    assert.equal((await db.query('SELECT count(*)::int n FROM product_visibility_intents WHERE product_id=$1', [product.id])).rows[0].n, 1);
    let gets = 0;
    await visibility.runIntent(config, archived.intentId, { databasePool: db,
      fetchImpl: async () => { gets++; return new Response(JSON.stringify({ items: [{ id: product.id + 10000, sku: product.full_sku, status: 2 }], total_count: 1 }),
        { headers: { 'content-type': 'application/json' } }); }, setVisibility: () => assert.fail('Already hidden must not write') });
    assert.equal(gets, 1);
    const hidden = await lifecycle.status(product.id, options); assert.equal(hidden.localState, 'archived'); assert.ok(hidden.visibility.hiddenAt);
    const review = await lifecycle.preview({ skus: [product.full_sku.toLowerCase(), product.full_sku, 'does-not-exist'] }, options);
    assert.deepEqual(review.counts, { found: 1, skipped: 1, conflicts: 0 });
    const generation = (await db.query('SELECT desired_generation FROM magento_product_sync_requests WHERE product_id=$1', [product.id])).rows[0].desired_generation;
    const [first, second] = await Promise.all([lifecycle.apply(command(review), options), lifecycle.apply(command(review), options)]);
    assert.equal(first.batchId, second.batchId); assert.equal(first.items[0].state, 'queued');
    const restored = (await db.query('SELECT * FROM products WHERE id=$1', [product.id])).rows[0];
    assert.equal(restored.status, 'active'); assert.equal(restored.exclude_from_export, 0); assert.equal(restored.total_price_uah, product.total_price_uah);
    assert.deepEqual(restored.details, product.details); assert.equal(restored.full_sku, product.full_sku);
    const request = (await db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1', [product.id])).rows[0];
    assert.equal(BigInt(request.desired_generation) > BigInt(generation), true);
    assert.equal((await db.query('SELECT count(*)::int n FROM product_restore_items WHERE batch_id=$1', [first.batchId])).rows[0].n, 1);
    assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE subject_id=$1 AND event_key='product.restored'", [String(product.id)])).rows[0].n, 1);
    await nativeAck(product);
    const intent = (await db.query("SELECT * FROM product_visibility_intents WHERE product_id=$1 AND kind='restore'", [product.id])).rows[0];
    await visibility.runIntent(config, intent.id, { databasePool: db, fetchImpl: async () => new Response(JSON.stringify({ items: [{ id: product.id + 10000, sku: product.full_sku, status: 2 }], total_count: 1 }),
      { headers: { 'content-type': 'application/json' } }), setVisibility: () => assert.fail('Prior hidden status must stay hidden') });
    const receipt = await lifecycle.readBatch(first.batchId, options); assert.equal(receipt.items[0].state, 'synced'); assert.ok(receipt.items[0].confirmedAt);
    assert.ok(receipt.items[0].visibilityRestoredAt);
    await assert.rejects(db.query("UPDATE product_visibility_intents SET state='queued',verified_at=NULL WHERE id=$1", [intent.id]), /cannot be rewritten/);
    await assert.rejects(db.query('DELETE FROM product_visibility_intents WHERE id=$1', [intent.id]), /permanent/);
    await assert.rejects(db.query('UPDATE product_restore_batches SET review=review WHERE id=$1', [first.batchId]), /immutable/);
    await assert.rejects(db.query('DELETE FROM product_restore_items WHERE batch_id=$1', [first.batchId]), /immutable/);
    await assert.rejects(db.query('TRUNCATE product_visibility_intents CASCADE'), /permanent/);
  });
  await t.test('stale reviewed price, revoked capability and missing archive proof cannot restore', async () => {
    const product = await make(); await archive(product);
    const review = await lifecycle.preview({ skus: [product.full_sku] }, options); assert.equal(review.counts.found, 1);
    await db.query('UPDATE products SET total_price_uah=241 WHERE id=$1', [product.id]);
    await assert.rejects(lifecycle.apply(command(review), options), { code: 'PRODUCT_RESTORE_REVIEW_STALE' });
    assert.equal((await db.query('SELECT status FROM products WHERE id=$1', [product.id])).rows[0].status, 'archived');
    const unexposed = await make({ known: false }); await archive(unexposed);
    const fresh = await lifecycle.preview({ skus: [unexposed.full_sku] }, options); assert.equal(fresh.items[0].mode, 'create');
    await db.query("UPDATE application_users SET status='disabled',deactivated_at=CURRENT_TIMESTAMP WHERE id=$1", [actor]);
    await assert.rejects(lifecycle.apply(command(fresh), options), { code: 'ADMIN_PERMISSION_REVOKED' });
    await db.query("UPDATE application_users SET status='active',deactivated_at=NULL WHERE id=$1", [actor]);
    const historical = await make({ known: false });
    await runAccessAdminMutation({ databasePool: db, actorUserId: actor, requiredPermission: 'products.archive', createError: c.error, operation: async (client) => {
      await client.query("UPDATE products SET status='archived',exclude_from_export=1 WHERE id=$1", [historical.id]);
      await require('../src/services/full-product-export.service').retireFullProduct(client, historical.id);
    } });
    const unknown = await lifecycle.preview({ skus: [historical.full_sku] }, options);
    assert.equal(unknown.items[0].reasonCode, 'PRODUCT_ARCHIVE_PROOF_MISSING');
    assert.equal(unknown.counts.found, 0);
  });
  await t.test('hide cancels only same-identity automatic native jobs with zero step evidence and retains all other obligations', async () => {
    const product = await make(); const oldJob = await unfinishedNative(product); const archived = await archive(product);
    let reads = 0;
    await visibility.runIntent(config, archived.intentId, { databasePool: db, fetchImpl: async () => {
      reads++; return new Response(JSON.stringify({ total_count: 1, items: [{ id: product.id + 10000, sku: product.full_sku, status: 2 }] }),
        { headers: { 'content-type': 'application/json' } }); }, setVisibility: () => assert.fail('Already hidden must not PUT') });
    assert.equal(reads, 1);
    assert.equal((await db.query('SELECT state FROM magento_sync_jobs WHERE id=$1', [oldJob])).rows[0].state, 'superseded');
    const request = (await db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1', [product.id])).rows[0];
    assert.equal(request.active_job_id, null); assert.equal(request.reason_code, 'product_retired');
    assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='magento_sync.superseded' AND subject_id=$1", [oldJob])).rows[0].n, 1);
    for (const type of [{ automatic: false }, { step: 'verified', jobState: 'blocked' }, { step: 'dispatched', jobState: 'uncertain' }]) {
      const guarded = await make(); const job = await unfinishedNative(guarded, type); const archiveIntent = await archive(guarded);
      await visibility.runIntent(config, archiveIntent.intentId, { databasePool: db,
        fetchImpl: () => assert.fail('Native dispatch/manual obligation must prevent visibility HTTP'),
        setVisibility: () => assert.fail('Native obligation must prevent visibility PUT') });
      assert.equal((await db.query('SELECT state FROM magento_sync_jobs WHERE id=$1', [job])).rows[0].state, type.jobState || 'queued');
      const blocked = (await db.query('SELECT * FROM product_visibility_intents WHERE id=$1', [archiveIntent.intentId])).rows[0];
      assert.equal(blocked.state, 'blocked'); assert.equal(blocked.reason_code, 'PRODUCT_SYNC_RECONCILIATION_REQUIRED');
      assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='magento_sync.superseded' AND subject_id=$1", [job])).rows[0].n, 0);
    }
  });
  await t.test('unfinished media blocks future archive atomically and restore preview without invalidating native or media evidence', async () => {
    const nativeFence = (await db.query("SELECT to_regprocedure('guard_product_media_native_input()') IS NOT NULL AS present")).rows[0].present;
    for (const mediaState of ['pending', 'running', 'uncertain', 'blocked']) {
      const active = await make(); await unfinishedMedia(active, mediaState, mediaState === 'uncertain');
      const beforeArchive = await productEvidence(active);
      await assert.rejects(archive(active), nativeFence && mediaState !== 'pending'
        ? { code: 'P0651', constraint: 'product_media_native_input_fence' }
        : { code: 'PRODUCT_MEDIA_RECONCILIATION_REQUIRED' });
      assert.deepEqual(await productEvidence(active), beforeArchive, `${mediaState}: archive must roll back local retirement, generation changes, intents and audits`);
      assert.equal((await db.query('SELECT status FROM products WHERE id=$1', [active.id])).rows[0].status, 'active');

      const archived = await make(); await archive(archived); await unfinishedMedia(archived, mediaState, mediaState === 'uncertain');
      const beforePreview = await productEvidence(archived);
      const review = await lifecycle.preview({ skus: [archived.full_sku] }, options);
      assert.equal(review.items[0].disposition, 'conflict');
      assert.equal(review.items[0].reasonCode, 'PRODUCT_MEDIA_RECONCILIATION_REQUIRED');
      assert.deepEqual(await productEvidence(archived), beforePreview, `${mediaState}: conflict preview must preserve every receipt`);
    }
  });
  await t.test('restore apply revalidates media conflict against a sealed earlier review and records an error without local restoration', async () => {
    const product = await make(); await archive(product);
    const review = await lifecycle.preview({ skus: [product.full_sku] }, options);
    assert.equal(review.counts.found, 1);
    const { reviewHash, counts: ignored, ...sealed } = review; void ignored;
    const batchId = c.hash({ actorUserId: actor, reviewHash });
    await db.query('INSERT INTO product_restore_batches(id,actor_user_id,review_hash,review) VALUES($1,$2,$3,$4::jsonb)',
      [batchId, actor, reviewHash, JSON.stringify(sealed)]);
    await unfinishedMedia(product, 'uncertain', true);
    const before = await productEvidence(product);
    const result = await lifecycle.apply(command(review), options);
    assert.equal(result.items[0].state, 'error');
    assert.equal(result.items[0].reasonCode, 'PRODUCT_MEDIA_RECONCILIATION_REQUIRED');
    assert.deepEqual(await productEvidence(product), before, 'Per-item conflict cannot restore a product, increment native generation or rewrite dispatched media evidence');
    assert.equal((await db.query('SELECT count(*)::int n FROM product_restore_items WHERE batch_id=$1', [batchId])).rows[0].n, 1);
    const repeated = await lifecycle.apply(command(review), options);
    assert.deepEqual(repeated, result);
    assert.deepEqual(await productEvidence(product), before);
  });
  await t.test('proven terminal media supersession cannot leave a historical obligation after its exact successor succeeds', async () => {
    const photos = require('../src/services/product-photos.service');
    await db.query("INSERT INTO categories(code,name) VALUES('ZZ','Terminal media fixture')");
    const version = (await db.query(`INSERT INTO product_characteristic_versions(category_code,version,config_hash,snapshot)
      VALUES('ZZ',1,$1,'{"contract":"product-characteristics-v1","category_code":"ZZ","questions":[]}'::jsonb) RETURNING id`,
    [c.hash('terminal-media-characteristics')])).rows[0].id;
    await runAccessAdminMutation({ databasePool: db, actorUserId: actor, requiredPermission: 'products.archive', createError: c.error,
      operation: async (client) => {
        const event = await require('../src/audit/audit-events').writeAuditEvent(client, { mutationContext: options.mutationContext,
          eventKey: 'product.terminal_media_fixture', subjectType: 'fixture', subjectId: 'terminal-media' });
        await client.query("SET LOCAL amber.public_sku_activation='on'");
        await client.query(`UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,
          activated_by_user_id=$1,activation_event_id=$2 WHERE singleton`, [actor, event.id]);
      } });
    const asset = await photos.stage({ idempotencyKey: randomUUID(), name: 'terminal.png', mimeType: 'image/png',
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE5sAAAAASUVORK5CYII=' }, options);
    const source = await runAccessAdminMutation({ databasePool: db, actorUserId: actor, requiredPermission: 'products.create', createError: c.error,
      operation: async (client) => {
        const product = (await client.query(`INSERT INTO products(category,weight,total_price_uah,details,characteristic_version_id)
          VALUES('ZZ',1,100,'{"answers":{}}',$1) RETURNING *`, [version])).rows[0];
        await require('../src/services/full-product-export.service').initializeNewProduct(client, product.id);
        const media = await photos.attachCreatedProduct(client, product.id, { photoIds: [asset.id], enableWhenVerified: true }, options.mutationContext);
        return { product, media };
      } });
    const successor = await runAccessAdminMutation({ databasePool: db, actorUserId: actor, requiredPermission: 'products.recount', createError: c.error,
      operation: async (client) => {
        await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [source.product.id]);
        const product = (await client.query(`INSERT INTO products(category,weight,total_price_uah,details,characteristic_version_id,corrected_from_product_id)
          VALUES('ZZ',1,101,'{"answers":{}}',$1,$2) RETURNING *`, [version, source.product.id])).rows[0];
        await require('../src/services/full-product-export.service').initializeNewProduct(client, product.id);
        await client.query("UPDATE products SET status='corrected',exclude_from_export=1,corrected_to_product_id=$2 WHERE id=$1", [source.product.id, product.id]);
        await require('../src/services/full-product-export.service').retireFullProduct(client, source.product.id);
        const media = await photos.inheritRecountPhotos(client, source.product.id, product.id, options.mutationContext);
        return { product, media };
      } });
    assert.equal(successor.product.public_product_identity_id, source.product.public_product_identity_id);
    const terminal = (await db.query('SELECT * FROM product_media_jobs WHERE id=$1', [source.media.jobId])).rows[0];
    assert.equal(terminal.state, 'superseded'); assert.equal(terminal.superseded_by_job_id, successor.media.jobId);
    assert.equal((await state.readTarget(db, successor.product.id, { origin })).facts.unfinishedMedia, true,
      'A superseded predecessor does not excuse the still-pending successor');
    await db.query("UPDATE product_media_jobs SET state='succeeded',verified_at=CURRENT_TIMESTAMP WHERE id=$1", [successor.media.jobId]);
    assert.equal((await state.readTarget(db, successor.product.id, { origin })).facts.unfinishedMedia, false,
      'Only terminal superseded/succeeded jobs remain for this identity');
    assert.deepEqual((await db.query('SELECT * FROM product_media_jobs WHERE id=$1', [source.media.jobId])).rows[0], terminal);
    assert.equal(Number((await db.query('SELECT product_id FROM product_photo_assets WHERE id=$1', [asset.id])).rows[0].product_id), source.product.id,
      'The immutable original remains owned by its predecessor');
    await assert.rejects(db.query("UPDATE product_media_jobs SET state='pending',superseded_by_job_id=NULL WHERE id=$1", [source.media.jobId]),
      /permanent/);
  });
}
module.exports = { run, migrationWithoutEnrollment };
