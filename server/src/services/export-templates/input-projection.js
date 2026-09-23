// Closed access to supplied data only. Validation is lazy: hidden answers are not read.
const PRODUCT_FIELDS = Object.freeze(['id', 'full_sku', 'category', 'weight',
  'total_price_uah', 'magento_name_subject_ua', 'magento_name_subject_en', 'sku_schema_version_id']);
function own(object, key) {
  if (object == null || !Object.hasOwn(object, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!Object.hasOwn(descriptor, 'value')) fail('INPUT_INVALID', `Accessor source: ${key}`);
  return descriptor.value;
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function scalar(value, source) {
  if (value !== null && value !== undefined && !['string', 'number', 'boolean'].includes(typeof value)) {
    fail('INPUT_INVALID', `Non-scalar source: ${source}`);
  }
  return value;
}

function identityText(value, source) {
  if (value != null && typeof value !== 'string') fail('INPUT_INVALID', `Text identity source: ${source}`);
  return value;
}

function readSource(descriptor, product) {
  if (descriptor.kind === 'product') {
    const value = scalar(own(product, descriptor.field), descriptor.field);
    return descriptor.type === 'text' ? identityText(value, descriptor.field) : value;
  }
  if (own(product, 'category') !== descriptor.category) return undefined;
  const answers = own(own(product, 'details'), 'answers');
  const keys = [descriptor.key];
  for (const alias of descriptor.aliases) {
    if (String(own(product, 'sku_schema_version_id')) === alias.schemaId) keys.push(alias.key);
  }
  let found = false;
  let value;
  for (const key of keys) {
    if (!answers || !Object.hasOwn(answers, key)) continue;
    const next = scalar(own(answers, key), `${descriptor.category}.${key}`);
    if (found && !Object.is(next, value)) {
      fail('SOURCE_REFERENCE_AMBIGUOUS', `Conflicting source aliases: ${descriptor.category}.${descriptor.key}`);
    }
    value = next;
    found = true;
  }
  return value;
}

module.exports = { PRODUCT_FIELDS, own, fail, scalar, identityText, readSource };
