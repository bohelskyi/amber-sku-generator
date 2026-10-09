const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('guaranteed creation SKU: migration, real-role ownership and atomic lifecycle', async (t) => {
  const source = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = `amber_warehouse_hotfix_${process.pid}_test`, control = new Client({ connectionString: source.toString() });
  await control.connect(); let db, appPool, created = false;
  try {
    assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0);
    await control.query(`CREATE DATABASE ${name}`); created = true;
    const target = new URL(source); target.pathname = `/${name}`;
    process.env.DATABASE_URL = target.toString(); process.env.MAGENTO_BASE_URL = 'https://effective-names.invalid';
    for (const key of ['MAGENTO_CONSUMER_KEY','MAGENTO_CONSUMER_SECRET','MAGENTO_ACCESS_TOKEN','MAGENTO_ACCESS_TOKEN_SECRET']) process.env[key] = 'warehouse-hotfix-test-credential-' + key; process.env.NBU_RATE_OVERRIDE = '40';
    require('../test/setup-env'); appPool = require('../src/db/pool');
    db = new Client({ connectionString: target.toString() }); await db.connect();
    const migrations = require('../src/db/run-migrations');
    const migrationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-hotfix-migrations-'));
    const sourceDirectory = path.resolve(__dirname, '../migrations');
    try {
      for (const file of (await fs.readdir(sourceDirectory)).filter(file => file.endsWith('.sql') && file < '074')) {
        await fs.copyFile(path.join(sourceDirectory,file),path.join(migrationDirectory,file));
      }
      await migrations.runMigrations({directory:migrationDirectory});
      await t.test('074 upgrade rollback and repeated startup preserve old checksums and allocate nothing', async () => {
        const oldFunction = (await db.query("SELECT pg_get_functiondef('assign_product_public_identity()'::regprocedure) AS value")).rows[0].value;
        const oldMigrations = (await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
        const migrationFile = '074_creation_sku_reservations.sql';
        await fs.copyFile(path.join(sourceDirectory,migrationFile),path.join(migrationDirectory,migrationFile));
        await fs.appendFile(path.join(migrationDirectory,migrationFile),'\nSELECT 1/0;\n');
        await assert.rejects(migrations.runMigrations({directory:migrationDirectory}), /division by zero/);
        assert.equal((await db.query("SELECT to_regclass('product_creation_sku_reservations') AS name")).rows[0].name,null);
        assert.equal((await db.query("SELECT pg_get_functiondef('assign_product_public_identity()'::regprocedure) AS value")).rows[0].value,oldFunction);
        assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,oldMigrations);
        await fs.copyFile(path.join(sourceDirectory,migrationFile),path.join(migrationDirectory,migrationFile));
        await migrations.runMigrations({directory:migrationDirectory}); await migrations.runMigrations({directory:migrationDirectory});
        assert.deepEqual((await db.query("SELECT name,checksum FROM schema_migrations WHERE name<'074' ORDER BY name")).rows,oldMigrations);
        assert.equal((await db.query('SELECT count(*)::int n FROM public_product_identities')).rows[0].n,0);
        assert.equal((await db.query('SELECT count(*)::int n FROM products')).rows[0].n,0);
      });
    } finally {
      const relative = path.relative(path.resolve(os.tmpdir()),path.resolve(migrationDirectory));
      assert.ok(relative.startsWith('amber-hotfix-migrations-') && !relative.includes(path.sep));
      await fs.rm(migrationDirectory,{recursive:true,force:true});
    }
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Effective names fixture') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const config = { configured: true, baseUrl: 'https://effective-names.invalid', consumerKey: 'fixture', consumerSecret: 'fixture', accessToken: 'fixture', accessTokenSecret: 'fixture' };
    const options = { databasePool: appPool, mutationContext: { actorUserId: actor }, config, creationDeliveryConfig: config };
    await db.query("INSERT INTO categories(code,name,requires_weight,sku_publication_mode) VALUES('AR','Art',1,'explicit')");
    const question = (await db.query("INSERT INTO questions(category_code,key,label,sku_index,include_in_sku,required,input_type) VALUES('AR','type','Type',1,1,1,'options') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,1,'1','One')", [question]);
    const schema = await require('../src/services/sku-schema.service').publishSkuSchema('AR', options);
    await db.query('BEGIN');
    const legacyId = (await db.query(`INSERT INTO products(full_sku,base_sku,sequence_number,category,weight,total_price_uah,details,sku_schema_version_id,created_by_user_id)
      VALUES('AR1-000001','AR1',1,'AR',2,100,'{"answers":{"type":1}}',$1,$2) RETURNING id`, [schema.id, actor])).rows[0].id;
    await require('../src/services/full-product-export.service').initializeNewProduct(db, legacyId);
    await db.query('COMMIT');
    const fixture = require('../test/fixtures/magento-v4');
    const definition = fixture.definition(['AR']); delete definition.sources.color; delete definition.sources.note;
    definition.questionContracts = {}; definition.tables = {};
    definition.sources.weight = { kind: 'product', field: 'weight', type: 'scalar' };
    definition.groups[0].rows.forEach(row => { row.cells.name = { op: 'when', if: { op: 'in', input: { op: 'source', id: 'weight' }, values: [1, '1', '1.000'] },
      then: { op: 'join', delimiter: '', omitEmpty: false, items: [{ op: 'literal', value: row.id === 'base' ? 'Автоматична назва ' : 'Generated name ' }, { op: 'text', input: { op: 'source', id: 'sku' }, trim: false, format: 'scalar-v1', onAbsent: 'empty' }] }, else: { op: 'literal', value: '' } }; });
    const templates = require('../src/services/export-templates/template.service');
    const family = await templates.createTemplate({ key: 'effective-names', displayName: 'Effective names', definition }, options);
    const old = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    const oldRow = (await db.query('SELECT * FROM export_template_versions WHERE id=$1', [old.id])).rows[0];
    const loaded = await templates.getTemplate(family.id, options);
    const upgraded = await templates.upgradeDraft(family.id, { expectedRevision: loaded.draft.revision, expectedDefinitionHash: loaded.draft.definitionHash,
      targetContract: 'effective-product-names-v1' }, options);
    const version = await templates.publishTemplate(family.id, { expectedRevision: upgraded.revision, expectedDefinitionHash: upgraded.definitionHash }, options);
    const bindings = require('../src/services/magento/binding.service'), observation = fixture.observation();
    let binding = await bindings.createDraft({ installationKey: 'effective-names', origin: config.baseUrl, templateVersionId: version.id, observedAt: new Date().toISOString(), schema: observation }, options);
    binding = await bindings.updateDraft(binding.id, { expectedRevision: binding.revision, bindings: fixture.approvedBindings(version.definition, observation) }, options);
    binding = await bindings.publishDraft(binding.id, { expectedRevision: binding.revision, expectedCurrentId: null }, options);
    const event = (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('public_sku.activated',$1,'{"displayName":"Effective names fixture","preferredUsername":null}','public_sku_activation','singleton',$2) RETURNING id`, [actor, crypto.randomUUID()])).rows[0].id;
    await db.query('BEGIN'); await db.query("SET LOCAL amber.public_sku_activation='on'");
    await db.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton', [actor, event]);
    const cutoverEvent = (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('magento_delivery.cutover',$1,'{"displayName":"Effective names fixture","preferredUsername":null}','public_sku_activation','singleton',$2) RETURNING id`, [actor, crypto.randomUUID()])).rows[0].id;
    await db.query("SET LOCAL amber.magento_delivery_cutover='on'");
    await db.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='effective-names',actor_user_id=$1,
      legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`, [actor, cutoverEvent]);
    await db.query('UPDATE magento_auto_sync_activation SET enabled=FALSE WHERE singleton'); await db.query('COMMIT');
    const products = require('../src/services/product.service');
    const reservations = require('../src/services/product/creation-sku-reservation');
    const nativePayload = { categoryCode: 'AR', answers: { type: 1 }, weight: 2,
      pricingDecision: { mode: 'manual_uah', manualPriceUah: 100 } };
    const actors = {};
    const servers = [];
    const localFetch = global.fetch;
    let externalFetches = 0;
    global.fetch = (url, ...args) => {
      if (new URL(url).hostname !== '127.0.0.1') { externalFetches++; throw Error('EXTERNAL_FETCH_FORBIDDEN'); }
      return localFetch(url, ...args);
    };
    const { createApp } = require('../src/app');
    async function login(role) {
      const calls = [];
      const issuer = 'https://auth.example.invalid/realms/amber';
      const adapter = { issuer, redirectUri: 'http://localhost:5000/api/auth/callback',
        async buildAuthorizationRedirect(transaction) { calls.push(transaction); return new URL('https://auth.example.invalid/authorize'); },
        async exchangeAuthorizationCode() { return { iss: issuer, sub: 'hotfix-' + role, name: 'Hotfix ' + role }; },
        async buildLogoutRedirect() { return null; } };
      const app = createApp({ oidcAdapter: adapter });
      const server = await new Promise(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
      servers.push(server);
      const root = `http://127.0.0.1:${server.address().port}/api`;
      const start = await fetch(root + '/auth/login', { redirect: 'manual' }); assert.equal(start.status, 302);
      const callback = await fetch(root + '/auth/callback?code=fixture&state=' + calls[0].state,
        { redirect: 'manual', headers: { Cookie: start.headers.get('set-cookie').split(';')[0] } });
      assert.equal(callback.status, 303);
      const cookie = callback.headers.get('set-cookie').split(';')[0];
      const initial = await (await fetch(root + '/auth/me', { headers: { Cookie: cookie } })).json();
      const id = initial.applicationUser.id;
      await db.query("UPDATE application_users SET status='active',activated_at=CURRENT_TIMESTAMP WHERE id=$1", [id]);
      await db.query('INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key=$2', [id, role]);
      const command = async (route, body, { csrf = true } = {}) => {
        const response = await fetch(root + route, { method: body === undefined ? 'GET' : 'POST',
          headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': initial.csrfToken } : {}) }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
      };
      return { id, command, options: { ...options, mutationContext: { actorUserId: id } } };
    }
    const savedPayload = (input, preview) => ({ ...input, category: input.categoryCode,
      characteristicConfigHash: preview.characteristicConfigHash, previewToken: preview.previewToken,
      ...(preview.skuReservation ? { skuReservation: preview.skuReservation } : {}) });
    const count = async () => (await db.query(`SELECT (SELECT count(*) FROM products)::int products,
      (SELECT count(*) FROM public_product_identities)::int identities,
      (SELECT count(*) FROM product_creation_receipts)::int receipts,
      (SELECT count(*) FROM audit_events WHERE event_key='product.created')::int audits`)).rows[0];
    const reservation = async (id, key) => (await db.query('SELECT * FROM product_creation_sku_reservations WHERE actor_user_id=$1 AND idempotency_key=$2', [id, key])).rows[0];
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function blockedRace(actorId, key, operations) {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`product-creation:${actorId}:${key}`]);
      const running = operations.map(operation => operation());
      try {
        let waiting = 0;
        for (let i = 0; i < 100; i++) {
          waiting = (await control.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1
            AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%'`, [name])).rows[0].n;
          if (waiting >= operations.length) break;
          await pause(20);
        }
        assert.ok(waiting >= operations.length, 'independent connections overlap on the exact attempt lock');
      } finally { await db.query('COMMIT'); }
      return Promise.all(running);
    }
    try {
      actors.storekeeper = await login('storekeeper'); actors.manager = await login('manager');
      const warehouse = actors.storekeeper;
      let input, reviewed, saveInput, created;
      await t.test('racing previews reserve one real article; names include it before save', async () => {
        input = { ...nativePayload, idempotencyKey: crypto.randomUUID() };
        const before = await count();
        const raced = await blockedRace(warehouse.id, input.idempotencyKey,
          [() => warehouse.command('/preview', input), () => warehouse.command('/preview', input)]);
        for (const result of raced) assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.deepEqual(raced[0].body.skuReservation, raced[1].body.skuReservation);
        reviewed = raced[0].body;
        assert.match(reviewed.publicSku, /^AG-\d{6,}$/); assert.equal(reviewed.creationNames.ready, false);
        assert.equal((await count()).identities, before.identities + 1); assert.equal((await count()).products, before.products);
        input.magentoNames = { all: 'Фігура ' + reviewed.publicSku, en: 'Figurine ' + reviewed.publicSku };
        const repeated = await warehouse.command('/preview', input); assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
        assert.equal(repeated.body.publicSku, reviewed.publicSku); assert.equal(repeated.body.creationNames.ready, true);
        reviewed = repeated.body; saveInput = savedPayload(input, reviewed);
      });
      await t.test('same UUID cannot bypass reservation, owner/category/namespace or tamper article', async () => {
        const unreserved = await products.buildNewProductPreview({ ...nativePayload, magentoNames: input.magentoNames }, warehouse.options);
        await assert.rejects(products.saveProduct({ ...savedPayload({ ...nativePayload, magentoNames: input.magentoNames }, unreserved),
          idempotencyKey: input.idempotencyKey }, warehouse.options), { code: 'CREATION_RESERVATION_REQUIRED' });
        await assert.rejects(products.saveProduct({ ...saveInput, skuReservation: { ...saveInput.skuReservation, publicSku: 'AG-999999' } }, warehouse.options), { code: 'CREATION_RESERVATION_STALE' });
        await assert.rejects(products.saveProduct(saveInput, options), { code: 'CREATION_RESERVATION_REQUIRED' });
        await assert.rejects(products.buildNewProductPreview({ ...input, categoryCode: 'ZZ' }, warehouse.options), /Категорію|не знайдено/);
        assert.equal((await warehouse.command('/preview', { ...input, isTestProduct: true })).status, 403);
        await assert.rejects(db.query(`UPDATE product_creation_sku_reservations SET public_product_identity_id=public_product_identity_id
          WHERE actor_user_id=$1 AND idempotency_key=$2`, [warehouse.id, input.idempotencyKey]), /immutable/);
      });
      await t.test('receipt/audit failure rolls back consumption, then real save race and replay return exact reserved SKU', async () => {
        const before = await count();
        await db.query(`CREATE FUNCTION hotfix_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'HOTFIX_RECEIPT_FAILURE'; END $$;
          CREATE TRIGGER hotfix_fail_receipt BEFORE INSERT ON product_creation_receipts FOR EACH ROW EXECUTE FUNCTION hotfix_fail_receipt()`);
        try { await assert.rejects(products.saveProduct(saveInput, warehouse.options), /HOTFIX_RECEIPT_FAILURE/); }
        finally { await db.query('DROP TRIGGER hotfix_fail_receipt ON product_creation_receipts; DROP FUNCTION hotfix_fail_receipt()'); }
        assert.deepEqual(await count(), before); assert.equal((await reservation(warehouse.id, input.idempotencyKey)).state, 'reserved');
        await db.query(`CREATE FUNCTION hotfix_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.event_key='product.created' THEN RAISE EXCEPTION 'HOTFIX_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER hotfix_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION hotfix_fail_audit()`);
        try { await assert.rejects(products.saveProduct(saveInput, warehouse.options), /HOTFIX_AUDIT_FAILURE/); }
        finally { await db.query('DROP TRIGGER hotfix_fail_audit ON audit_events; DROP FUNCTION hotfix_fail_audit()'); }
        assert.deepEqual(await count(), before); assert.equal((await reservation(warehouse.id, input.idempotencyKey)).state,'reserved');
        const raced = await blockedRace(warehouse.id, input.idempotencyKey,
          [() => warehouse.command('/save', saveInput), () => warehouse.command('/save', saveInput)]);
        for (const result of raced) assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.deepEqual(raced[0].body, raced[1].body); created = raced[0].body;
        assert.equal(created.publicSku, reviewed.publicSku);
        assert.deepEqual((await warehouse.command('/product-names/' + created.id)).body.names, input.magentoNames);
        const after = await count(); assert.equal(after.products, before.products + 1); assert.equal(after.identities, before.identities);
        assert.equal(after.receipts, before.receipts + 1); assert.equal(after.audits, before.audits + 1);
        assert.equal((await reservation(warehouse.id, input.idempotencyKey)).state, 'consumed');
        assert.deepEqual((await warehouse.command('/save', saveInput)).body, created);
        assert.equal((await warehouse.command('/products/creation/cancel', input)).body.state, 'consumed');
        assert.equal((await warehouse.command('/preview', input)).status, 409); assert.deepEqual(await count(), after);
      });
      await t.test('cancellation before reserve and after preview is permanent, creates no product and never reuses article', async () => {
        const cancelFirst = { ...nativePayload, idempotencyKey: crypto.randomUUID() };
        const before = await count();
        assert.equal((await warehouse.command('/products/creation/cancel', cancelFirst)).body.state, 'cancelled');
        assert.equal((await warehouse.command('/preview', cancelFirst)).status, 409);
        assert.deepEqual(await count(), before);
        const abandoned = { ...nativePayload, idempotencyKey: crypto.randomUUID() };
        const preview = await warehouse.command('/preview', abandoned); assert.equal(preview.status, 200);
        abandoned.magentoNames = { all: 'Cancel UA ' + preview.body.publicSku, en: 'Cancel EN ' + preview.body.publicSku };
        const named = await warehouse.command('/preview', abandoned); assert.equal(named.status, 200);
        const beforeCancel = await count();
        assert.equal((await warehouse.command('/products/creation/cancel', abandoned)).body.state, 'cancelled');
        assert.equal((await warehouse.command('/save', savedPayload(abandoned, named.body))).status, 409);
        assert.equal((await warehouse.command('/preview', abandoned)).status, 409); assert.deepEqual(await count(), beforeCancel);
        assert.equal((await reservation(warehouse.id, abandoned.idempotencyKey)).state, 'cancelled');
        const unreserved = await products.buildNewProductPreview({ ...nativePayload, magentoNames: abandoned.magentoNames }, warehouse.options);
        await assert.rejects(products.saveProduct({ ...savedPayload({ ...nativePayload, magentoNames: abandoned.magentoNames }, unreserved),
          idempotencyKey: abandoned.idempotencyKey }, warehouse.options), { code: 'CREATION_RESERVATION_REQUIRED' });
        const fresh = await warehouse.command('/preview', { ...nativePayload, idempotencyKey: crypto.randomUUID() });
        assert.equal(fresh.status, 200); assert.notEqual(fresh.body.publicSku, preview.body.publicSku);
      });
      await t.test('legacy completed UUID cannot reserve another article; current creator revocation denies preview and recovery', async () => {
        const legacy = { ...nativePayload, idempotencyKey: crypto.randomUUID(), magentoNames: { all: 'Legacy UA', en: 'Legacy EN' } };
        const plain = { ...legacy }; delete plain.idempotencyKey;
        const preview = await products.buildNewProductPreview(plain, warehouse.options);
        const saved = await products.saveProduct(savedPayload(legacy, preview), warehouse.options);
        const before = await count();
        assert.equal((await warehouse.command('/preview', legacy)).status, 409); assert.deepEqual(await count(), before);
        assert.equal(await reservation(warehouse.id, legacy.idempotencyKey), undefined);
        await db.query("UPDATE application_users SET status='disabled' WHERE id=$1", [warehouse.id]);
        try {
          assert.equal((await warehouse.command('/preview', { ...nativePayload, idempotencyKey: crypto.randomUUID() })).status, 403);
          await assert.rejects(products.saveProduct(saveInput, warehouse.options), { statusCode: 403 });
        } finally { await db.query("UPDATE application_users SET status='active' WHERE id=$1", [warehouse.id]); }
        assert.deepEqual((await warehouse.command('/save', savedPayload(legacy, preview))).body, saved);
      });
      await t.test('generated UA/EN use the same reserved article and TEST remains Administrator-only', async () => {
        const automatic = {...nativePayload, weight:1,idempotencyKey:crypto.randomUUID()};
        const preview = await warehouse.command('/preview',automatic); assert.equal(preview.status,200,JSON.stringify(preview.body));
        assert.equal(preview.body.creationNames.names.all,'Автоматична назва '+preview.body.publicSku);
        const saved = await warehouse.command('/save',savedPayload(automatic,preview.body)); assert.equal(saved.status,200,JSON.stringify(saved.body));
        assert.equal(saved.body.publicSku,preview.body.publicSku);
        assert.deepEqual((await warehouse.command('/product-names/'+saved.body.id)).body.names,preview.body.creationNames.names);
        const testInput = {...nativePayload,isTestProduct:true,idempotencyKey:crypto.randomUUID()};
        const testPreview = await products.buildNewProductPreview(testInput,options);
        assert.match(testPreview.publicSku,/^TEST-\d{6,}$/);
        testInput.magentoNames={all:'Тест '+testPreview.publicSku,en:'Test '+testPreview.publicSku};
        const namedPreview=await products.buildNewProductPreview(testInput,options);
        const testSave=await products.saveProduct(savedPayload(testInput,namedPreview),options);
        assert.equal(testSave.publicSku,testPreview.publicSku);assert.equal(testSave.isTestProduct,true);assert.equal(testSave.testTargetStatus,2);
      });
      await t.test('racing save and cancellation commit one final state, never a second article', async () => {
        for (const cancelWins of [true,false]) {
          const raceInput={...nativePayload,idempotencyKey:crypto.randomUUID()};
          const preview=await products.buildNewProductPreview(raceInput,warehouse.options);
          raceInput.magentoNames={all:'Гонка '+preview.publicSku,en:'Race '+preview.publicSku};
          const namedPreview=await products.buildNewProductPreview(raceInput,warehouse.options);
          const payload=savedPayload(raceInput,namedPreview); const before=await count();
          const first=cancelWins?()=>reservations.cancel(raceInput,warehouse.options):()=>products.saveProduct(payload,warehouse.options);
          const second=cancelWins?()=>products.saveProduct(payload,warehouse.options):()=>reservations.cancel(raceInput,warehouse.options);
          await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`product-creation:${warehouse.id}:${raceInput.idempotencyKey}`]);
          const settled=promise=>promise.then(value=>({value}),error=>({error}));
          const one=settled(first());
          const waitForCount=async expected=>{let waiting=0;for(let i=0;i<100;i++){
            waiting=(await control.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND wait_event='advisory'
              AND query LIKE '%pg_advisory_xact_lock%'`,[name])).rows[0].n;if(waiting>=expected)return;await pause(20);
          }assert.fail('race did not overlap on independent connections');};
          let two;
          try {await waitForCount(1);two=settled(second());await waitForCount(2);}finally{await db.query('COMMIT');}
          const [a,b]=await Promise.all([one,two]);assert.ifError(a.error);
          const final=await reservation(warehouse.id,raceInput.idempotencyKey);
          const after=await count();assert.equal(after.identities,before.identities);
          if(cancelWins){assert.equal(a.value.state,'cancelled');assert.equal(b.error.statusCode,409);assert.equal(final.state,'cancelled');assert.equal(after.products,before.products);assert.equal(after.receipts,before.receipts);}
          else {assert.ifError(b.error);assert.equal(a.value.publicSku,preview.publicSku);assert.equal(b.value.state,'consumed');assert.equal(final.state,'consumed');assert.equal(after.products,before.products+1);assert.equal(after.receipts,before.receipts+1);}
        }
      });
      await t.test('database rejects detached consumed reservation without its exact product and receipt', async () => {
        const detached={...nativePayload,idempotencyKey:crypto.randomUUID()};
        await products.buildNewProductPreview(detached,warehouse.options);
        const unrelated=(await db.query('SELECT p.id FROM products p LEFT JOIN product_creation_sku_reservations r ON r.product_id=p.id WHERE r.product_id IS NULL ORDER BY p.id LIMIT 1')).rows[0].id;
        await db.query('BEGIN');
        await db.query("UPDATE product_creation_sku_reservations SET state='consumed',product_id=$3,closed_at=CURRENT_TIMESTAMP WHERE actor_user_id=$1 AND idempotency_key=$2",
          [warehouse.id,detached.idempotencyKey,unrelated]);
        await assert.rejects(db.query('COMMIT'),/exact atomic product and receipt/);
        await db.query('ROLLBACK');assert.equal((await reservation(warehouse.id,detached.idempotencyKey)).state,'reserved');
      });
      assert.equal(externalFetches, 0);
    } finally {
      global.fetch = localFetch;
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    }
  } finally {
    if (db) await db.end(); if (appPool) await appPool.end();
    if (created) { await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name]); await control.query(`DROP DATABASE ${name}`); }
    await control.end();
  }
});
