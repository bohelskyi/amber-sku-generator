const c = require('./binding-contract');

const CREATE_FIELDS = ['bindingRevisionId','expectedRevision','attributeCode','label','englishLabel',
  'frontendInput','scope','required','visibleOnFront','searchable','filterable','filterableInSearch'];
const FLAG_FIELDS = ['required','visibleOnFront','searchable','filterable','filterableInSearch'];
const FIXED_FLAGS = { is_unique: false, is_visible: true, is_wysiwyg_enabled: false,
  is_html_allowed_on_front: false, used_for_sort_by: false, is_comparable: false,
  is_visible_in_advanced_search: false, is_used_for_promo_rules: false,
  used_in_product_listing: false, is_used_in_grid: false, is_visible_in_grid: false, is_filterable_in_grid: false };
const fail = (code, message) => { throw c.error(409, code, message); };
function label(value, optional = false) {
  if (optional && value === '') return value;
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 255 || /[\u0000-\u001f\u007f<>]/.test(value)) c.invalid();
  return value;
}
function bool(value) {
  if ([true, 1, '1'].includes(value)) return true;
  if ([false, 0, '0'].includes(value)) return false;
  c.invalid();
}
function creation(input, englishStoreId) {
  c.command(input, CREATE_FIELDS);
  if (typeof input.attributeCode !== 'string' || !/^[a-z][a-z0-9_]{0,29}$/.test(input.attributeCode)
    || !['text','select'].includes(input.frontendInput) || !['global','website','store'].includes(input.scope)
    || FLAG_FIELDS.some((key) => typeof input[key] !== 'boolean')) c.invalid();
  label(input.label); label(input.englishLabel, true);
  if (input.frontendInput === 'text' && (input.filterable || input.filterableInSearch)) {
    fail('MAGENTO_ATTRIBUTE_FILTER_TYPE_UNSUPPORTED', 'Фільтри доступні для атрибута з вибором одного варіанта.');
  }
  if (englishStoreId && !input.englishLabel) fail('MAGENTO_ATTRIBUTE_EN_LABEL_REQUIRED', 'Заповніть англійську назву атрибута для активного EN магазину.');
  if (!englishStoreId && input.englishLabel) fail('MAGENTO_ATTRIBUTE_EN_STORE_UNAVAILABLE', 'Активний EN магазин відсутній. Англійську назву неможливо зберегти в цьому контексті.');
  const attribute = { attribute_code: input.attributeCode, frontend_input: input.frontendInput,
    default_frontend_label: input.label, frontend_labels: [{store_id: 0, label: input.label}],
    scope: input.scope, is_required: input.required, is_user_defined: true,
    is_visible_on_front: input.visibleOnFront, is_searchable: input.searchable,
    is_filterable: input.filterable, is_filterable_in_search: input.filterableInSearch,
    apply_to: ['simple'], default_value: '', ...FIXED_FLAGS };
  if (englishStoreId) attribute.frontend_labels.push({ store_id: englishStoreId, label: input.englishLabel });
  // Omit attribute_id, options, backend/source models and extension attributes.
  // Magento's no-ID repository branch creates a new EAV record. No update path.
  return { attribute };
}
function safeAttribute(raw) {
  if (!raw || !c.positive(raw.attribute_id) || !c.code(raw.attribute_code)) c.invalid();
  return c.safeData(raw, [], 32768);
}
// Stock REST omits nullable getters whose value is null. Restrict that
// equivalence to these two empty-profile fields; present non-string values
// remain invalid, and backend type/source identity remain mandatory.
const emptyNullableRestField = (raw, field) => !Object.hasOwn(raw, field) || [null, ''].includes(raw[field]);
function verifyCreated(intent, id, raw) {
  safeAttribute(raw);
  const wanted = intent.body.attribute;
  if (String(raw.attribute_id) !== String(id) || raw.attribute_code !== wanted.attribute_code
    || raw.frontend_input !== wanted.frontend_input || raw.default_frontend_label !== wanted.default_frontend_label
    || raw.scope !== wanted.scope || !bool(raw.is_user_defined)
    || raw.backend_type !== (wanted.frontend_input === 'select' ? 'int' : 'varchar')
    || (wanted.frontend_input === 'select' ? raw.source_model !== 'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Table'
      : ![null, ''].includes(raw.source_model))
    || !emptyNullableRestField(raw, 'backend_model') || !emptyNullableRestField(raw, 'default_value')
    || c.hash(raw.apply_to) !== c.hash(['simple'])) {
    fail('MAGENTO_ATTRIBUTE_VERIFICATION_FAILED', 'Створений атрибут не відповідає перевіреним налаштуванням.');
  }
  for (const field of [...Object.keys(FIXED_FLAGS),'is_required','is_visible_on_front','is_searchable','is_filterable','is_filterable_in_search']) {
    if (bool(raw[field]) !== wanted[field]) fail('MAGENTO_ATTRIBUTE_VERIFICATION_FAILED', 'Налаштування атрибута відрізняються від підтверджених.');
  }
  const labels = raw.frontend_labels;
  if (!Array.isArray(labels) || labels.some((entry) => !Number.isSafeInteger(entry.store_id) || typeof entry.label !== 'string')
    || new Set(labels.map((entry) => entry.store_id)).size !== labels.length) c.invalid();
  // The admin/global label is represented by default_frontend_label. Magento
  // may omit store_id 0 from frontend_labels; active EN must be exact.
  for (const entry of wanted.frontend_labels.filter((entry) => entry.store_id !== 0)) {
    if (labels.find((candidate) => candidate.store_id === entry.store_id)?.label !== entry.label) {
      fail('MAGENTO_ATTRIBUTE_VERIFICATION_FAILED', 'Англійська назва атрибута не підтверджена.');
    }
  }
  if ((raw.options || []).some((entry) => entry.value !== '')) fail('MAGENTO_ATTRIBUTE_VERIFICATION_FAILED', 'Новий атрибут містить неперевірені варіанти.');
  return { attributeId: raw.attribute_id, attributeCode: raw.attribute_code, metadataHash: c.hash(raw) };
}
function groups(raw, setId) {
  if (!raw || !Array.isArray(raw.items) || !Number.isSafeInteger(raw.total_count)
    || raw.total_count !== raw.items.length || raw.items.length > 100) c.invalid();
  return c.unique(raw.items.map((item) => {
    const id = Number(item.attribute_group_id);
    if (!c.positive(id) || Number(item.attribute_set_id) !== setId || typeof item.attribute_group_name !== 'string' || !item.attribute_group_name) c.invalid();
    return { id, name: item.attribute_group_name, setId };
  }), (item) => item.id).sort((a,b) => a.id-b.id);
}
function membership(raw) {
  return c.unique(c.list(raw, 1000).map((item) => {
    safeAttribute(item);
    return { id: item.attribute_id, code: item.attribute_code };
  }), (item) => item.id).sort((a,b) => a.id-b.id);
}
module.exports = { CREATE_FIELDS, FIXED_FLAGS, creation, verifyCreated, safeAttribute, groups, membership, bool, fail };
