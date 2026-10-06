// Explicit synthetic inserts only. Runtime services never use this helper: their
// missing state must fail the deferred constraint. Keep old checkpoint SQL raw.
function insertProductFixture(queryable, sql, values = []) {
  const returning = /\bRETURNING\s+([\s\S]*?)\s*;?\s*$/i.exec(sql);
  const insert = returning ? sql.slice(0, returning.index) : sql.trim().replace(/;$/, '');
  return queryable.query(`WITH fixture AS (${insert} RETURNING *), lifecycle AS (
    INSERT INTO product_full_export_state(product_id, route, evidence)
    SELECT id, CASE WHEN status IN ('archived','corrected') THEN 'retired' ELSE 'normal' END,
      '{"origin":"ordinary_save","fixture":true}'::jsonb FROM fixture
  ) SELECT ${returning ? returning[1].replace(/;$/, '') : '*'} FROM fixture`, values);
}

async function insertNativeProductFixture(queryable, { category, totalPriceUah = 100, details = {}, weight = 0, correctedFromProductId = null, isTestProduct = false, actorUserId = null }) {
  if (typeof queryable.release !== 'function') {
    const client = await queryable.connect();
    const gate = require('../src/services/full-product-cutover-gate');
    try {
      await gate.begin(client,'BEGIN');
      const result = await insertNativeProductFixture(client,{category,totalPriceUah,details,weight,correctedFromProductId,isTestProduct,actorUserId});
      await gate.commit(client); return result;
    } catch (error) { await gate.rollback(client); throw error; }
    finally { await gate.release(client); client.release(); }
  }
  const characteristics = require('../src/services/product/characteristic-config');
  if (isTestProduct) await queryable.query("SELECT set_config('amber.create_test_product','on',TRUE),set_config('amber.create_test_product_actor',$1,TRUE)", [String(actorUserId)]);
  const version = await characteristics.persistCharacteristicConfiguration(queryable,
    await characteristics.readCharacteristicConfiguration(queryable, category));
  const result = await queryable.query(`INSERT INTO products(category,total_price_uah,weight,details,characteristic_version_id,corrected_from_product_id,created_by_user_id)
    VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *`, [category,totalPriceUah,weight,JSON.stringify(details),version.id,correctedFromProductId,actorUserId]);
  await require('../src/services/full-product-export.service').initializeNewProduct(queryable,result.rows[0].id);
  return result;
}

module.exports = { insertProductFixture, insertNativeProductFixture };
