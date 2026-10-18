// Isolated disposable database: real recount + stable recount exposure through the batch CLI. Synthetic Magento GETs only.
const test = require('node:test'), assert = require('node:assert/strict');
const { Client } = require('pg'), { execFile } = require('node:child_process'), { promisify } = require('node:util');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const source = new URL(process.env.TEST_DATABASE_URL || '');
const name = `amber_legacy_answer_batch_${process.pid}_test`, target = new URL(source); target.pathname = '/' + name;
process.env.DATABASE_URL = target.toString(); process.env.NBU_RATE_OVERRIDE = '40';
require('../test/setup-env');
const fixture = require('../test/fixtures/legacy-sv-schema6');

test('legacy answer recount batch: read-only preview, reviewed apply, resume and idempotent rerun', async t => {
  assert.equal(source.hostname, '127.0.0.1'); assert.ok(source.pathname.endsWith('_test'));
  const control = new Client({ connectionString: source.toString() }); await control.connect(); let created = false, db;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-legacy-answer-batch-'));
  try {
    await control.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await control.query(`CREATE DATABASE ${name}`); created = true;
    await promisify(execFile)(process.execPath, ['-e', "require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});"],
      { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: target.toString() } });
    db = require('../src/db/pool');
    const gate = require('../src/services/full-product-cutover-gate'), c = require('../src/services/magento/binding-contract');
    const user = async (display, role) => {
      const id = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active',$1) RETURNING id", [display])).rows[0].id);
      await db.query('INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key=$2', [id, role]);
      return id;
    };
    const actor = await user('Batch administrator', 'administrator'), storekeeper = await user('Batch storekeeper', 'storekeeper');
    const f = fixture.data;
    await db.query('INSERT INTO categories(code,name,requires_weight,skip_hidden_sku_questions,marketing_rounding_enabled) VALUES($1,$2,$3,$4,$5)',
      [f.category.code, f.category.name, f.category.requires_weight, f.category.skip_hidden_sku_questions, f.category.marketing_rounding_enabled]);
    for (const q of f.currentQuestions) await db.query(`INSERT INTO questions(id,category_code,key,label,input_type,required,include_in_sku,sku_index,display_order,sku_separator,visible_if_json,archived,numeric_validation)
      VALUES($1,'SV',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb)`, [q.id, q.key, q.label, q.input_type, q.required, q.include_in_sku, q.sku_index, q.display_order, q.sku_separator,
      q.visible_if_json === null ? null : JSON.stringify(q.visible_if_json), q.archived, q.numeric_validation === null ? null : JSON.stringify(q.numeric_validation)]);
    for (const o of f.currentOptions) await db.query(`INSERT INTO options(id,question_id,value_id,sku_code,label,label_en,visible_if_json,hidden_if_json,archived)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`, [o.id, o.question_id, o.value_id, o.sku_code, o.label, o.label_en, JSON.stringify(o.visible_if_json), JSON.stringify(o.hidden_if_json), o.archived]);
    await db.query("INSERT INTO sku_schema_versions(id,category_code,version,marker,status,config_hash) VALUES(6,'SV',1,'','active',$1)", [f.schema.config_hash]);
    for (const q of f.questions) await db.query('INSERT INTO sku_schema_questions(id,schema_version_id,question_key,label,sku_index,display_order,required,sku_separator,visible_if_json) VALUES($1,6,$2,$3,$4,$5,$6,$7,$8::jsonb)',
      [q.id, q.question_key, q.label, q.sku_index, q.display_order, q.required, q.sku_separator, JSON.stringify(q.visible_if_json)]);
    for (const o of f.options) await db.query('INSERT INTO sku_schema_options(id,schema_question_id,value_id,sku_code,label,visible_if_json,hidden_if_json,archived) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)',
      [o.id, o.schema_question_id, o.value_id, o.sku_code, o.label, JSON.stringify(o.visible_if_json), JSON.stringify(o.hidden_if_json), o.archived]);
    const { scenario, config, installationKey } = await require('./stable-recount-exposure-fixture')(db, actor, { group: 'SV' });
    const legacy = fixture.product(1359), skus = ['SV5111001', 'SV5111002', 'SV5111003', 'SV5111004', 'SV5111005', 'SV5111006'], scenarios = {};
    // 004-006: truncated physical weight 37 with exact answer "37,6"; 005 is USD/gram priced, so its price depends on weight.
    // 006 also lacks stone_processing and needs one combined recount.
    const missing = { ...legacy.details, answers: { ...legacy.details.answers, weight: '37,6' } };
    const truncated = { ...missing, answers: { ...missing.answers, stone_processing: '1' } };
    const usd = { ...truncated, manualPriceUah: null, customUsdPerGramBasis: { usdPerGram: 2, marketingRoundingEnabled: false, source: 'product_price_change' } };
    for (const [index, sku] of skus.entries()) {
      const s = scenarios[sku] = await scenario({ sku, category: 'SV' });
      const [weight, uah, perGram, details] = index < 3 ? [46.3, legacy.total_price_uah, legacy.price_per_gram, legacy.details]
        : index === 3 ? [37, legacy.total_price_uah, legacy.price_per_gram, truncated]
          : index === 4 ? [37, 2960, 2, usd] : [37, legacy.total_price_uah, legacy.price_per_gram, missing];
      await db.query(`UPDATE products SET base_sku='SV5111',sequence_number=$2,weight=$8,sku_schema_version_id=6,total_price=$3,total_price_uah=$4,
        price_per_gram=$5,uah_rate=$6,details=$7::jsonb,magento_name_subject_ua='Тестовий камінь',magento_name_subject_en='Test stone' WHERE id=$1`,
      [s.product.id, index + 1, legacy.total_price, uah, perGram, legacy.uah_rate, JSON.stringify(details), weight]);
      await db.query(`UPDATE product_full_export_state SET route='hold',hold_reason='historical_ambiguity',business_exclusion_state='none',
        delivery_version=delivery_version+1,evidence='{"origin":"migration_039","coverage":"unresolved_historical"}' WHERE product_id=$1`, [s.product.id]);
      await db.query('INSERT INTO product_export_revisions(product_id,has_product_snapshot) VALUES($1,TRUE)', [s.product.id]);
    }
    const ids = skus.map(sku => scenarios[sku].product.id);
    await db.query('UPDATE export_state SET exported_to_product_id=$1', [Math.max(...ids)]);
    const cutover = require('../src/services/full-product-cutover.service');
    const maintenance = { databasePool: db, mutationContext: { actorUserId: actor }, expectedDatabase: name, deploymentEvidence: 'Disposable legacy answer batch fixture; no older writer' };
    await cutover.prepare(maintenance); const index = await cutover.generate('index', maintenance);
    await cutover.indexHistorical(index, index.contentSha256, maintenance);
    const manifest = await cutover.generate('cutover', maintenance);
    await cutover.approve(manifest, manifest.contentSha256, 'Explicit fixture legacy inventory baseline', maintenance);
    await cutover.applyBatch(manifest.contentSha256, 0, maintenance); await cutover.activate(manifest.contentSha256, maintenance);
    const event = async key => (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES($1,$2,'{"displayName":"Fixture","preferredUsername":null}','fixture','singleton',$3) RETURNING id`, [key, actor, randomUUID()])).rows[0].id;
    const activation = await event('public_sku.activated'), delivery = await event('magento_delivery.cutover');
    const client = await db.connect();
    try {
      await gate.begin(client, 'BEGIN');
      await client.query("SET LOCAL amber.public_sku_activation='on'; SET LOCAL amber.magento_delivery_cutover='on'");
      await client.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton', [actor, activation]);
      await client.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2,
        legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3 WHERE singleton`, [installationKey, actor, delivery]);
      await gate.commit(client);
    } catch (cause) { await gate.rollback(client); throw cause; } finally { await gate.release(client); client.release(); }
    // One synthetic GET-only Magento per SKU; any write is recorded by its scenario.
    const fetchImpl = async (url, init) => {
      const u = new URL(url), sku = u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');
      return (scenarios[sku] || scenarios.SV5111001).options.fetchImpl(url, init);
    };
    const recoveryOptions = { fetchImpl, preview: scenarios.SV5111001.options.preview };
    const writes = () => skus.reduce((n, sku) => n + scenarios[sku].writes.length, 0);
    const snapshot = async () => {
      const data = {};
      for (const { tablename } of (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
        assert.match(tablename, /^[a-z][a-z0-9_]*$/);
        data[tablename] = (await db.query(`SELECT to_jsonb(row) value FROM "${tablename}" row`)).rows.map(row => row.value)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      data.sequences = (await db.query("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows;
      return c.hash(data);
    };
    const runner = require('../scripts/legacy-answer-recount-batch');
    let counter = 0;
    const cli = async (items, mode, { actorId = actor, planHash, ownPool = false, kind = { answers: { stone_processing: 1 } } } = {}) => {
      const file = path.join(dir, `input-${++counter}.json`), output = path.join(dir, `journal-${counter}.jsonl`), printed = [], errors = [];
      await fs.writeFile(file, JSON.stringify({ category: 'SV', ...kind,
        reason: 'Catalog owner verified polished stone processing', items: items.map(sku => ({ sku })) }));
      const code = await runner.main(['--mode', mode, '--input', file, '--output', output, '--expected-database', name, '--actor-id', String(actorId),
        ...(planHash ? ['--plan-hash', planHash] : [])], { ...(ownPool ? { env: process.env } : { pool: db }), config, recovery: recoveryOptions,
        print: v => printed.push(JSON.parse(v)), printError: v => errors.push(JSON.parse(v)) });
      const journal = (await fs.readFile(output, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
      return { code, printed, errors, journal, summary: printed.at(-1) };
    };
    const active = async sku => (await db.query(`SELECT p.*,i.public_sku,f.route,f.hold_reason FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
      JOIN product_full_export_state f ON f.product_id=p.id WHERE i.public_sku=$1 AND p.status='active'`, [sku])).rows;
    const original = Object.fromEntries((await Promise.all(skus.map(active))).map((rows, i) => [skus[i], rows[0]]));
    let plan;

    await t.test('preview of absent answers is fully read-only and keeps price and public identity', async () => {
      const before = await snapshot(), result = await cli(skus.slice(0, 2), 'preview');
      assert.equal(await snapshot(), before);
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.equal(await snapshot(), before, 'preview writes nothing, including sequences');
      const items = result.journal.filter(row => row.type === 'item');
      assert.deepEqual(items.map(i => [i.sku, i.status]), [['SV5111001', 'ready'], ['SV5111002', 'ready']], JSON.stringify(items));
      for (const item of items) {
        assert.equal(item.publicSku, item.sku); assert.equal(item.internalSkuBefore, item.sku);
        assert.equal(item.priceBeforeUah, 5000); assert.equal(item.priceAfterUah, 5000);
        assert.deepEqual(item.pricingDecision, { mode: 'manual_uah', manualPriceUah: 5000 });
        assert.deepEqual(item.delivery, { route: 'hold', holdReason: 'historical_ambiguity' });
      }
      plan = result.summary; assert.match(plan.planHash, /^[a-f0-9]{64}$/); assert.equal(plan.summary.ready, 2);
      const readOnly = await cli(skus.slice(0, 2), 'preview', { ownPool: true });
      assert.equal(readOnly.code, 0, JSON.stringify(readOnly)); assert.equal(readOnly.summary.planHash, plan.planHash, 'read-only CLI pool');
      assert.equal(await snapshot(), before);
    });

    await t.test('non-administrator actor is refused for preview and apply without writes', async () => {
      const before = await snapshot();
      for (const result of [await cli(skus.slice(0, 2), 'preview', { actorId: storekeeper }),
        await cli(skus.slice(0, 2), 'apply', { actorId: storekeeper, planHash: plan.planHash })]) {
        assert.equal(result.code, 1); assert.deepEqual(result.errors, [{ ok: false, code: 'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED' }]);
      }
      assert.equal(await snapshot(), before); assert.equal(writes(), 0);
    });

    await t.test('a product changed after preview stops apply with PLAN_CHANGED before any recount', async () => {
      const id = original.SV5111002.id;
      const writer = await db.connect();
      try {
        await gate.begin(writer, 'BEGIN');
        await writer.query("UPDATE products SET magento_name_subject_ua='Змінена назва' WHERE id=$1", [id]);
        await gate.commit(writer);
      } catch (cause) { await gate.rollback(writer); throw cause; } finally { await gate.release(writer); writer.release(); }
      const before = await snapshot(), result = await cli(skus.slice(0, 2), 'apply', { planHash: plan.planHash });
      assert.equal(result.code, 1); assert.deepEqual(result.errors, [{ ok: false, code: 'PLAN_CHANGED' }]);
      assert.equal(await snapshot(), before); assert.equal(writes(), 0);
      assert.deepEqual(result.journal.map(row => row.type), ['start', 'fresh_preview']);
    });

    await t.test('reviewed apply recounts, keeps price/public identity and records the stable recount handoff', async () => {
      plan = (await cli(skus.slice(0, 2), 'preview')).summary;
      const result = await cli(skus.slice(0, 2), 'apply', { planHash: plan.planHash });
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.deepEqual(result.journal.map(row => row.type), ['start', 'fresh_preview', ...Array(2).fill(['recount_started', 'recount_applied',
        'recovery_previewed', 'recovery_applied']).flat(), 'complete']);
      for (const sku of skus.slice(0, 2)) {
        const rows = await active(sku), before = original[sku]; assert.equal(rows.length, 1); const next = rows[0];
        assert.notEqual(next.id, before.id); assert.equal(next.corrected_from_product_id, before.id);
        assert.equal(String(next.details.answers.stone_processing), '1');
        for (const key of Object.keys(before.details.answers)) assert.equal(String(next.details.answers[key]), String(before.details.answers[key]), key);
        assert.equal(next.public_sku, sku); assert.equal(next.public_product_identity_id, before.public_product_identity_id);
        assert.equal(Number(next.total_price_uah), Number(before.total_price_uah)); assert.equal(Number(next.weight), Number(before.weight));
        assert.equal(next.route, 'hold'); assert.equal(next.hold_reason, 'prior_exposure');
        const retired = (await db.query('SELECT status,corrected_to_product_id FROM products WHERE id=$1', [before.id])).rows[0];
        assert.deepEqual(retired, { status: 'corrected', corrected_to_product_id: next.id });
        const applied = result.journal.find(row => row.type === 'recovery_applied' && row.sku === sku);
        const handoff = (await db.query('SELECT * FROM magento_binding_handoffs WHERE id=$1', [applied.handoffId])).rows[0];
        assert.equal(handoff.kind, 'broader_resync'); assert.equal(handoff.evidence.source, 'stable_recount_exposure');
        assert.equal(Number(handoff.actor_user_id), actor);
        assert.deepEqual((await db.query('SELECT product_id,state FROM magento_binding_handoff_items WHERE handoff_id=$1', [handoff.id])).rows
          .map(row => [Number(row.product_id), row.state]), [[Number(next.id), 'pending']]);
        // Activated stable public SKU: the successor is native (no encoded SKU); the legacy SKU stays reserved by its source.
        assert.equal(next.full_sku, null); assert.ok(next.characteristic_version_id);
        assert.equal(result.journal.find(row => row.type === 'recount_applied' && row.sku === sku).internalSkuAfter, null);
        assert.equal(Number((await db.query('SELECT first_product_id FROM sku_registry WHERE full_sku=$1', [sku])).rows[0].first_product_id), Number(before.id));
        assert.equal(Number(next.created_by_user_id), actor);
        assert.equal((await db.query(`SELECT count(*)::int n FROM audit_events WHERE event_key='product.magento_stable_recount_exposure_reconciled'
          AND details->'result'->>'sku'=$1`, [sku])).rows[0].n, 1);
        assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.recounted' AND subject_id=$1", [String(before.id)])).rows[0].n, 1);
      }
      assert.equal(writes(), 0, 'the batch never writes Magento');
    });

    await t.test('rerun reports already_applied and changes nothing', async () => {
      const preview = await cli(skus.slice(0, 2), 'preview');
      assert.deepEqual(preview.journal.filter(row => row.type === 'item').map(i => i.status), ['already_applied', 'already_applied']);
      const before = await snapshot(), result = await cli(skus.slice(0, 2), 'apply', { planHash: preview.summary.planHash });
      assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(await snapshot(), before);
      assert.deepEqual(result.summary.items.map(i => i.status), ['already_applied', 'already_applied']);
    });

    await t.test('an item whose recount committed without recovery resumes at the recovery step', async () => {
      const first = (await cli(['SV5111003'], 'preview')).journal.find(row => row.type === 'item');
      assert.equal(first.status, 'ready', JSON.stringify(first));
      await require('../src/services/product.service').applyProductRecount({ sourceSku: 'SV5111003', answers: { stone_processing: 1 },
        reason: 'Catalog owner verified polished stone processing', pricingDecision: first.pricingDecision,
        previewToken: first.previewToken, sourceStateSignature: first.sourceStateSignature },
      { authorizedDirectDecision: true, authorizedNameChange: true, mutationContext: { actorUserId: actor }, databasePool: db });
      const preview = await cli(['SV5111003'], 'preview');
      assert.equal(preview.journal.find(row => row.type === 'item').status, 'recovery_pending');
      const result = await cli(['SV5111003'], 'apply', { planHash: preview.summary.planHash });
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.deepEqual(result.journal.map(row => row.type), ['start', 'fresh_preview', 'recovery_previewed', 'recovery_applied', 'complete']);
      assert.equal((await active('SV5111003'))[0].hold_reason, 'prior_exposure'); assert.equal(writes(), 0);
    });

    await t.test('weightFromAnswer: unchanged price is accepted; a weight-dependent price change is refused', async () => {
      const weightMode = { kind: { weightFromAnswer: true } }, before = await snapshot();
      const preview = await cli(['SV5111004', 'SV5111005'], 'preview', weightMode);
      assert.equal(await snapshot(), before, 'weight preview writes nothing');
      const [ready, refused] = preview.journal.filter(row => row.type === 'item');
      assert.equal(ready.status, 'ready', JSON.stringify(ready));
      assert.deepEqual([ready.weightBefore, ready.weightAfter, ready.recountWeight, ready.priceBeforeUah, ready.priceAfterUah, ready.internalSkuAfter],
        [37, 37.6, '37.6', 5000, 5000, null]);
      assert.deepEqual([refused.status, refused.code, refused.priceBeforeUah, refused.priceAfterUah], ['blocked', 'PRICE_CHANGED', 2960, 3008]);
      const blocked = await cli(['SV5111004', 'SV5111005'], 'apply', { ...weightMode, planHash: preview.summary.planHash });
      assert.deepEqual(blocked.errors, [{ ok: false, code: 'LEGACY_ANSWER_PLAN_BLOCKED' }]); assert.equal(await snapshot(), before);
      const plan = await cli(['SV5111004'], 'preview', weightMode), result = await cli(['SV5111004'], 'apply', { ...weightMode, planHash: plan.summary.planHash });
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.deepEqual(result.journal.map(row => row.type), ['start', 'fresh_preview', 'recount_started', 'recount_applied', 'recovery_previewed', 'recovery_applied', 'complete']);
      const [next] = await active('SV5111004'), old = original.SV5111004;
      assert.equal(Number(next.weight), 37.6); assert.equal(Number(next.total_price_uah), 5000); assert.equal(next.public_sku, 'SV5111004');
      assert.equal(next.public_product_identity_id, old.public_product_identity_id); assert.equal(next.hold_reason, 'prior_exposure');
      // Existing SV recount (product.service buildRecountPreview) writes the corrected weight into answers.weight.
      assert.equal(next.details.answers.weight, 37.6, 'not byte-identical: the comma string becomes a JSON number');
      for (const key of Object.keys(old.details.answers).filter(key => key !== 'weight')) assert.equal(String(next.details.answers[key]), String(old.details.answers[key]), key);
      const [untouched] = await active('SV5111005'); assert.equal(untouched.id, original.SV5111005.id); assert.equal(Number(untouched.weight), 37);
      assert.deepEqual((await cli(['SV5111004'], 'preview', weightMode)).journal.filter(row => row.type === 'item').map(i => i.status), ['already_applied']);
      assert.equal(writes(), 0);
    });

    await t.test('combined answers + weightFromAnswer: one recount fills the answer and the exact weight', async () => {
      const kind = { kind: { answers: { stone_processing: 1 }, weightFromAnswer: true } };
      const weightOnly = (await cli(['SV5111006'], 'preview', { kind: { weightFromAnswer: true } })).journal.find(row => row.type === 'item');
      assert.deepEqual([weightOnly.status, weightOnly.code], ['blocked', 'RECOUNT_PREVIEW_422'], 'a required absent answer blocks weight-only recount');
      const plan = await cli(['SV5111006'], 'preview', kind), item = plan.journal.find(row => row.type === 'item');
      assert.equal(item.status, 'ready', JSON.stringify(item));
      const result = await cli(['SV5111006'], 'apply', { ...kind, planHash: plan.summary.planHash });
      assert.equal(result.code, 0, JSON.stringify(result));
      const [next] = await active('SV5111006');
      assert.equal(String(next.details.answers.stone_processing), '1'); assert.equal(Number(next.weight), 37.6);
      assert.equal(Number(next.total_price_uah), 5000); assert.equal(next.hold_reason, 'prior_exposure');
      assert.deepEqual((await cli(['SV5111006'], 'preview', kind)).journal.filter(row => row.type === 'item').map(i => i.status), ['already_applied']);
      assert.equal(writes(), 0);
    });
    await t.test('an already exposed product (prior_exposure) is recounted without a recovery step', async () => {
      const [current] = await active('SV5111004');
      // A later truncation on the already exposed successor: answer 37.6, physical 37.
      const writer = await db.connect();
      try {
        await gate.begin(writer, 'BEGIN');
        await writer.query("UPDATE products SET weight=37,details=jsonb_set(details,'{answers,weight}','\"37,6\"') WHERE id=$1", [current.id]);
        // The legacy version was in a retained export file: exact exposure, as for the production 2026-09-11 file.
        await writer.query(`INSERT INTO export_snapshots(id,idempotency_key,from_sku,to_sku,resolved_to_sku,exported_to_product_id,row_count,file_name,csv_content,status)
          VALUES($1,$1,'SV5111004','SV5111004','SV5111004',$2,1,'exposed.csv',$3,'generated')`, [randomUUID(), original.SV5111004.id, 'sku,price_uah\r\nSV5111004,5000\r\n']);
        await gate.commit(writer);
      } catch (cause) { await gate.rollback(writer); throw cause; } finally { await gate.release(writer); writer.release(); }
      const kind = { kind: { weightFromAnswer: true } };
      const plan = await cli(['SV5111004'], 'preview', kind), item = plan.journal.find(row => row.type === 'item');
      assert.equal(item.status, 'ready', JSON.stringify(item));
      assert.deepEqual(item.delivery, { route: 'hold', holdReason: 'prior_exposure' });
      const result = await cli(['SV5111004'], 'apply', { ...kind, planHash: plan.summary.planHash });
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.deepEqual(result.journal.map(row => row.type), ['start', 'fresh_preview', 'recount_started', 'recount_applied', 'complete']);
      const [next] = await active('SV5111004');
      assert.notEqual(next.id, current.id); assert.equal(Number(next.weight), 37.6); assert.equal(Number(next.total_price_uah), 5000);
      assert.equal(next.public_product_identity_id, current.public_product_identity_id); assert.equal(next.hold_reason, 'prior_exposure');
      assert.deepEqual((await cli(['SV5111004'], 'preview', kind)).journal.filter(row => row.type === 'item').map(i => i.status), ['already_applied']);
      assert.equal(writes(), 0);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    if (db) await db.end();
    if (created) await control.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await control.end();
  }
});
