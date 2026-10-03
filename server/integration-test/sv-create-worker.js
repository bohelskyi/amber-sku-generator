const assert = require('node:assert/strict');
const pool = require('../src/db/pool');
const { runMigrations } = require('../src/db/run-migrations');
const { ensureLegacySkuSchemas } = require('../src/services/sku-schema.service');
const { buildProductPreview, buildNewProductPreview, saveProduct, buildProductRecountPreview, applyProductRecount } = require('../src/services/product.service');
const { catalog } = require('../test/fixtures/magento-v1/contract');
const { mapProduct, loadMagentoCatalog } = require('../src/services/magento-products-v1');

async function run() {
  try {
    assert.ok(new URL(process.env.DATABASE_URL).pathname.endsWith('_test'));
    await runMigrations();
    const actor = (await pool.query("INSERT INTO application_users(status,display_name) VALUES('active','SV creation tester') RETURNING id")).rows[0];
    const options = { mutationContext: { actorUserId: Number(actor.id) } };
    await pool.query("INSERT INTO categories(code,name,requires_weight,skip_hidden_sku_questions) VALUES('SV','SV creation fixture',0,1)");
    let index = 0;
    for (const [key, entry] of catalog().get('SV')) {
      const q = (await pool.query(`INSERT INTO questions(category_code,key,label,sku_index,display_order,required,include_in_sku,input_type)
        VALUES('SV',$1,$1,$2::integer,$2::integer,0,1,'options') RETURNING id`, [key, ++index])).rows[0];
      for (const o of entry.options) await pool.query('INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,$2,$3,$3)', [q.id, Number(o.value_id), String(o.value_id)]);
    }
    for (const key of ['size', 'weight']) await pool.query(`INSERT INTO questions(category_code,key,label,sku_index,display_order,required,include_in_sku,input_type)
      VALUES('SV',$1,$1,0,$2,0,0,'text')`, [key, ++index]);
    await pool.query(`UPDATE questions SET required=1, visible_if_json='{"souvenir":5}'::jsonb
      WHERE category_code='SV' AND key='stone_processing'`);
    for (const [key, rule] of Object.entries({ statuette: { souvenir: 1 }, '2': { statuette: 1 },
      bird: { '2': 2 }, plants: { statuette: 2 }, symbolic_stat: { statuette: 5 },
      table_games: { souvenir: 2 }, additional_stone: { souvenir: 5 } })) {
      await pool.query("UPDATE questions SET visible_if_json=$2::jsonb WHERE category_code='SV' AND key=$1", [key, JSON.stringify(rule)]);
    }
    await ensureLegacySkuSchemas();
    const protectedState = async () => {
      const out = {};
      for (const table of ['products','sku_registry','product_full_export_state','audit_events','export_state','export_snapshots']) {
        out[table] = (await pool.query(`SELECT to_jsonb(t) row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      }
      return out;
    };
    for (const souvenir of [1, 5, 6]) {
      const payload = { categoryCode: 'SV', answers: { souvenir, material: 1, color: 1, weight: '12.5', size: '3/2',
        ...(souvenir === 1 ? { statuette: 1, '2': 2, bird: 4 } : {}), ...(souvenir === 5 ? { stone_processing: 1, additional_stone: 1 } : {}) },
      ...(souvenir !== 6 ? { magento_name_subject_ua: 'Тестовий сувенір', magento_name_subject_en: 'test souvenir' } : {}) };
      const preview = await buildNewProductPreview(payload);
      const save = { ...payload, category: 'SV', skuSchemaVersionId: preview.skuSchemaVersionId, previewToken: preview.previewToken, manualPriceUah: 1000 };
      const before = await protectedState();
      for (const missing of ['size', 'weight', ...(souvenir === 6 ? [] : ['magento_name_subject_ua', 'magento_name_subject_en'])]) {
        const incomplete = structuredClone(save);
        if (missing.startsWith('magento_')) delete incomplete[missing]; else delete incomplete.answers[missing];
        await assert.rejects(buildNewProductPreview(incomplete), { statusCode: 422 });
        await assert.rejects(saveProduct(incomplete, options), { statusCode: 422 });
        assert.deepEqual(await protectedState(), before, `${souvenir}/${missing}: invalid save must have no side effects`);
      }
      if (souvenir !== 6) {
        await assert.rejects(saveProduct({ ...save, magento_name_subject_en: 'changed after preview' }, options), { statusCode: 409 });
        assert.deepEqual(await protectedState(), before);
      }
      // The internal/recount calculation is deliberately not the public creation gate.
      const legacy = { ...payload, answers: { ...payload.answers, size: undefined } };
      await buildProductPreview(legacy);
      const saved = await saveProduct(save, options);
      const product = (await pool.query('SELECT * FROM products WHERE id=$1', [saved.id])).rows[0];
      assert.equal(product.magento_name_subject_ua, payload.magento_name_subject_ua ?? null);
      assert.equal(product.magento_name_subject_en, payload.magento_name_subject_en ?? null);
      assert.equal(Number(product.total_price_uah), 1000);
      assert.equal(product.details.answers.size, '3/2');
      const mapped = mapProduct(product, await loadMagentoCatalog(pool));
      assert.deepEqual(mapped.errors, [], JSON.stringify(mapped.errors));
      const state = (await pool.query('SELECT * FROM product_full_export_state WHERE product_id=$1', [saved.id])).rows[0];
      assert.equal(state.route, 'normal');
      assert.equal(state.business_exclusion_state, 'none');
      assert.equal(state.recount_compatibility_excluded, false);
      if (souvenir === 5) {
        // Disposable reproduction of the supplied production absence. The
        // encoded SKU remains unchanged and must not manufacture an answer.
        await pool.query("UPDATE products SET details=jsonb_set(details,'{answers}',(details->'answers')-'stone_processing') WHERE id=$1", [saved.id]);
        const missing = (await pool.query('SELECT * FROM products WHERE id=$1', [saved.id])).rows[0];
        assert.deepEqual(mapProduct(missing, await loadMagentoCatalog(pool)).errors.map((e) => e.field), ['kamin_obrobka']);
        const beforeRepair = await protectedState();
        await assert.rejects(buildProductRecountPreview({ sourceSku: saved.fullSku, answers: {} }), { statusCode: 422 });
        const repair = { sourceSku: saved.fullSku, answers: { stone_processing: 0 }, manualPriceUah: 1000, reason: 'Explicit processing selection' };
        const reviewed = await buildProductRecountPreview(repair);
        assert.equal(Object.hasOwn(reviewed.source.answers, 'stone_processing'), false);
        assert.deepEqual(reviewed.changes, [{ key: 'stone_processing', from: null, to: 0 }]);
        assert.deepEqual(await protectedState(), beforeRepair, 'preview cannot repair or mutate product state');
        const applied = await applyProductRecount({ ...repair, sourceStateSignature: reviewed.source.stateSignature }, options);
        const successor = (await pool.query('SELECT * FROM products WHERE id=$1', [applied.correctedProductId])).rows[0];
        assert.equal(successor.details.answers.stone_processing, 0);
        assert.deepEqual(mapProduct(successor, await loadMagentoCatalog(pool)).errors, []);
        assert.equal(Number(successor.total_price_uah), 1000);
        const retired = (await pool.query('SELECT * FROM products WHERE id=$1', [saved.id])).rows[0];
        assert.equal(Object.hasOwn(retired.details.answers, 'stone_processing'), false);
        assert.equal(retired.corrected_to_product_id, successor.id);
        await assert.rejects(buildProductRecountPreview({ sourceSku: successor.full_sku, answers: { stone_processing: 0 } }), { statusCode: 422 });
      }
    }
  } finally { await pool.end(); }
}
module.exports = { run };
