const SOURCE_KEYS=['id','public_product_identity_id','full_sku','public_sku','category','status','exclude_from_export',
  'corrected_to_product_id','sku_schema_version_id','characteristic_version_id','weight_numeric','total_price_uah',
  'answers','magento_name_subject_ua','magento_name_subject_en','magento_name_override'];
function source(product) {
  return Object.fromEntries(SOURCE_KEYS.map(k=>[k,k==='answers'?product.details?.answers??null
    :k==='weight_numeric'?product.weight??null:product[k]??null]));
}
module.exports={SOURCE_KEYS,source};
