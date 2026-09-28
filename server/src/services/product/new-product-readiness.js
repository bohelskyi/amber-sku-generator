const { normalizeSubject } = require('../product-magento-name.service');
const { mapProduct, loadMagentoCatalog } = require('../magento-products-v1');

// Creation-only presentation of the existing Magento v1 input contract.
// Recount and legacy metadata completion deliberately do not use this gate.
const requirements = { SV: { requiredAnswers: ['size', 'weight'],
  automaticName: { question: 'souvenir', values: ['6'] } } };
function subjects(category, payload) {
  if (category !== 'SV') return null;
  const ua = payload.magento_name_subject_ua, en = payload.magento_name_subject_en;
  const automatic = requirements.SV.automaticName.values.includes(String(payload.answers?.souvenir));
  if (automatic && (ua == null || ua === '') && (en == null || en === '')) return { ua: null, en: null };
  return { ua: normalizeSubject(ua, 'українську'), en: normalizeSubject(en, 'англійську') };
}
async function validate(product, client, { allowMissingPrice = false } = {}) {
  if (product.category !== 'SV') return;
  const mapped = mapProduct(product, await loadMagentoCatalog(client));
  const issues = mapped.errors.filter(e => !allowMissingPrice || e.field !== 'price');
  if (issues.length) throw Object.assign(new Error(issues.map(e => e.message).join(' ')),
    { statusCode: 422, code: 'NEW_PRODUCT_NOT_READY', issues });
}
module.exports = { requirements, subjects, validate };
