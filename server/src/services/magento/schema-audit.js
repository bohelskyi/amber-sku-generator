const { createMagentoClient, PAGE_SIZE } = require('./client');
const { MagentoIntegrationError } = require('./errors');
const { percentEncode } = require('./oauth');
const { describeMapper, compare, sorted } = require('./mapper-schema');

const LIMIT = 10000;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const OPTION_INPUTS = new Set(['select', 'multiselect', 'boolean']);
const SAFE_CODE = /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/;
function auditContext(stage, entityType, entity, config) {
  const context = { stage, entityType };
  const secrets = ['consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret']
    .flatMap((key) => [config[key], percentEncode(config[key])]);
  const safe = (value) => !secrets.some((secret) => secret && String(value).includes(secret));
  const id = entity?.attribute_id ?? entity?.id ?? entity?.attribute_set_id;
  if (Number.isSafeInteger(id) && id >= 0 && safe(id)) context.entityId = id;
  if (entityType === 'attribute' && Number.isSafeInteger(entity?.attribute_set_id)
    && entity.attribute_set_id > 0 && safe(entity.attribute_set_id)) context.attributeSetId = entity.attribute_set_id;
  const value = entity?.attribute_code;
  if (typeof value === 'string' && SAFE_CODE.test(value) && safe(value)) context.entityCode = value;
  if (Number.isSafeInteger(entity?.index) && entity.index >= 0 && entity.index <= LIMIT) context.index = entity.index;
  return context;
}
function valueShape(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
function checked(field, value, validate) {
  try { return validate(value); } catch (error) {
    if (error instanceof MagentoIntegrationError) error.auditField = { field, valueShape: valueShape(value) };
    throw error;
  }
}
function located(stage, entityType, entity, config, action) {
  const rethrow = (error) => {
    const safe = error instanceof MagentoIntegrationError ? error : new MagentoIntegrationError('MAGENTO_AUDIT_FAILED');
    if (!safe.auditContext) safe.auditContext = auditContext(stage, entityType, entity, config);
    if (safe.auditField && SAFE_CODE.test(safe.auditField.field)
      && !['consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret']
        .some((key) => String(safe.auditField.field).includes(config[key]))) {
      Object.assign(safe.auditContext, safe.auditField);
    }
    throw safe;
  };
  try {
    const result = action();
    return result && typeof result.then === 'function' ? result.catch(rethrow) : result;
  } catch (error) { return rethrow(error); }
}
function invalid() { throw new MagentoIntegrationError('MAGENTO_RESPONSE_INVALID'); }
function bounded(value, max = LIMIT) {
  if (!Array.isArray(value)) invalid();
  if (value.length > max) throw new MagentoIntegrationError('MAGENTO_DISCOVERY_LIMIT');
  return value;
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}
function string(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid();
  return value;
}
function code(value) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(string(value))) invalid();
  return value;
}
function flag(value) {
  if (![true, false, 0, 1, '0', '1'].includes(value)) invalid();
  return value === true || value === 1 || value === '1';
}
function boolean(value) {
  if (typeof value !== 'boolean') invalid();
  return value;
}
function frontendInput(value) {
  if (value === null) return null;
  if (!string(value)) invalid();
  return value;
}
// Magento 2.4.6 EavAttributeInterface and AttributeInterface return types.
// Null is omitted from the bounded report; an absent optional field is likewise omitted.
const ATTRIBUTE_METADATA = Object.freeze({
  default_frontend_label: { validate: string, nullable: true },
  backend_type: { validate: string, nullable: true },
  is_required: { validate: boolean, nullable: false },
  is_unique: { validate: string, nullable: true },
  is_user_defined: { validate: boolean, nullable: true },
  is_visible: { validate: boolean, nullable: true },
  is_searchable: { validate: string, nullable: true },
  is_filterable: { validate: boolean, nullable: true },
  is_filterable_in_search: { validate: boolean, nullable: true },
  is_visible_on_front: { validate: string, nullable: true },
  is_used_for_promo_rules: { validate: string, nullable: true },
  scope: { validate: string, nullable: true },
});
function optional(raw, target, fields, validate) {
  for (const key of fields) if (raw[key] !== undefined && raw[key] !== null) {
    target[key] = checked(key, raw[key], validate);
  }
}
function unique(items, key) {
  if (new Set(items.map((v) => v[key])).size !== items.length) invalid();
  return items;
}
function normalizeAttribute(raw) {
  object(raw);
  const value = { attribute_id: checked('attribute_id', raw.attribute_id, (v) => integer(v, 1)),
    attribute_code: checked('attribute_code', raw.attribute_code, code),
    // A valid internal EAV attribute can have no merchandising input type.
    frontend_input: checked('frontend_input', raw.frontend_input, frontendInput) };
  for (const [field, contract] of Object.entries(ATTRIBUTE_METADATA)) {
    if (raw[field] === undefined) continue;
    if (raw[field] === null && contract.nullable) continue;
    value[field] = checked(field, raw[field], contract.validate);
  }
  return value;
}
function normalizeOptions(raw) {
  return unique(bounded(raw).map((item) => {
    object(item);
    // IDs are opaque installation identities. In particular, numeric zero is
    // not the empty choice. Only Magento's empty string is marked empty.
    const value = typeof item.value === 'number' ? String(integer(item.value)) : string(item.value);
    const option = { value, label: string(item.label), isEmpty: value === '' };
    optional(item, option, ['sort_order'], integer);
    optional(item, option, ['is_default'], flag);
    return option;
  }), 'value').sort((a, b) => compare(a.value, b.value));
}
async function pages(read, normalize, identity, stage, entityType, config) {
  const records = [];
  let total;
  for (let page = 1; page <= 100; page++) {
    const done = await located(stage, 'page', { index: page }, config, async () => {
      const result = object(await read(page));
      const count = integer(result.total_count);
      if (count > LIMIT) throw new MagentoIntegrationError('MAGENTO_DISCOVERY_LIMIT');
      if (total !== undefined && total !== count) invalid();
      total = count;
      const items = bounded(result.items, PAGE_SIZE).map((item, index) =>
        located(stage, entityType, { ...(item && typeof item === 'object' ? item : {}),
          index: (page - 1) * PAGE_SIZE + index }, config,
          () => normalize(item)));
      records.push(...items);
      unique(records, identity);
      if (records.length === total) return true;
      if (!items.length || records.length > total) invalid();
      return false;
    });
    if (done) return records;
  }
  return located(stage, 'page', { index: 100 }, config, () => {
    throw new MagentoIntegrationError('MAGENTO_DISCOVERY_LIMIT');
  });
}
function topology(raw, kind, config) {
  return unique(bounded(raw).map((item, index) => located('store_topology_normalization', kind,
    { ...(item && typeof item === 'object' ? item : {}), index }, config, () => {
    object(item);
    const result = { id: integer(item.id), name: string(item.name) };
    if (kind !== 'store_groups') result.code = string(item.code);
    else optional(item, result, ['code'], string);
    const required = kind === 'websites' ? [] : kind === 'store_groups'
      ? ['website_id', 'root_category_id', 'default_store_id'] : ['website_id', 'store_group_id'];
    for (const key of required) result[key] = integer(item[key]);
    optional(item, result, ['default_group_id'], integer);
    optional(item, result, ['is_active'], flag);
    return result;
  })), 'id').sort((a, b) => a.id - b.id);
}

function compareMapper(mapper, attributes, attributeSets) {
  const diagnostics = [];
  const review = (code, details) => diagnostics.push({ code, severity: 'review', ...details });
  const mapperAttributeSetComparison = mapper.attributeSets.map((expected) => {
    const matches = attributeSets.filter((set) => set.attribute_set_name === expected.attribute_set_code)
      .map(({ attribute_set_id, attribute_set_name }) => ({ attribute_set_id, attribute_set_name }));
    const status = matches.length === 1 ? 'exact' : matches.length ? 'ambiguous' : 'missing';
    if (status !== 'exact') review(status === 'missing' ? 'ATTRIBUTE_SET_NOT_FOUND' : 'ATTRIBUTE_SET_AMBIGUOUS', expected);
    return { ...expected, status, matches };
  });
  const optionComparisons = [];
  const mapperAttributes = mapper.targets.map((target) => {
    const attribute = attributes.find((a) => a.attribute_code === target.target);
    const sets = attributeSets.filter((s) => s.attributeCodes.includes(target.target)).map((s) => s.attribute_set_id);
    if (!attribute && target.kind === 'product_attribute') review('ATTRIBUTE_NOT_FOUND', { target: target.target });
    if (attribute?.frontend_input === null && target.kind === 'product_attribute') {
      review('ATTRIBUTE_FRONTEND_INPUT_MISSING', { target: target.target, attribute_id: attribute.attribute_id });
    }
    const expectedSetMembership = mapperAttributeSetComparison.filter((expected) =>
      target.usages.some((usage) => usage.amberGroup === expected.amberGroup)).map((expected) => {
      const setId = expected.status === 'exact' ? expected.matches[0].attribute_set_id : null;
      const contains = setId === null ? null : sets.includes(setId);
      if (attribute && contains === false && target.kind === 'product_attribute') {
        review('ATTRIBUTE_NOT_IN_EXPECTED_SET', { target: target.target, amberGroup: expected.amberGroup, attribute_set_id: setId });
      }
      return { amberGroup: expected.amberGroup, attribute_set_code: expected.attribute_set_code, attribute_set_id: setId, contains };
    });
    if (attribute?.options && (attribute.options.length || OPTION_INPUTS.has(attribute.frontend_input))) {
      const businessOptions = attribute.options.filter((o) => !o.isEmpty);
      const values = target.usages.flatMap((usage) => usage.values.map((v) => ({
        amberGroup: usage.amberGroup, row: usage.row, ...v,
      })));
      const compared = values.map((value) => {
        const candidates = value.label === '' ? [] : businessOptions.filter((o) => o.label === value.label).map((o) => o.value);
        const status = value.label === '' ? 'empty_output' : candidates.length === 1 ? 'candidate' : candidates.length ? 'ambiguous' : 'unmatched';
        if (status === 'unmatched') review('MAPPER_VALUE_NOT_IN_MAGENTO', { target: target.target, ...value });
        return { ...value, status, candidateOptionIds: candidates };
      });
      const duplicateLabels = sorted(businessOptions.map((o) => o.label)).map((label) => ({
        label, optionIds: businessOptions.filter((o) => o.label === label).map((o) => o.value),
      })).filter((entry) => entry.optionIds.length > 1);
      for (const entry of duplicateLabels) review('OPTION_LABEL_AMBIGUOUS', { target: target.target, ...entry });
      const unmappedOptions = businessOptions.filter((o) => !values.some((v) => v.label !== '' && v.label === o.label));
      for (const option of unmappedOptions) review('MAGENTO_OPTION_UNMAPPED', { target: target.target, optionId: option.value, label: option.label });
      optionComparisons.push({ target: target.target, matching: 'exact_label_only_not_a_binding',
        dynamicOutput: target.usages.some((u) => u.dynamicOutput), values: compared, duplicateLabels,
        unmappedOptions, emptyOptions: attribute.options.filter((o) => o.isEmpty) });
    }
    return { ...target, exists: Boolean(attribute), attribute_id: attribute?.attribute_id ?? null,
      frontend_input: attribute?.frontend_input ?? null, hasOptions: attribute ? Boolean(attribute.options?.length) : null,
      optionCount: attribute?.optionCount ?? null, attributeSetIds: sets, expectedSetMembership };
  });
  return { mapperAttributeSetComparison, mapperAttributes, optionComparisons,
    unmappedMagentoAttributes: attributes.filter((a) => !mapper.targets.some((t) => t.target === a.attribute_code)).map((a) => a.attribute_code),
    diagnostics: diagnostics.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))) };
}

async function auditMagentoSchema(config, { fetchImpl, storeCode = 'all' } = {}) {
  const client = createMagentoClient(config, { fetchImpl, storeCode });
  const storeTopology = {
    websites: await located('store_topology_normalization', 'websites', null, config,
      async () => topology(await client.getWebsites(), 'websites', config)),
    storeGroups: await located('store_topology_normalization', 'store_groups', null, config,
      async () => topology(await client.getStoreGroups(), 'store_groups', config)),
    storeViews: await located('store_topology_normalization', 'store_views', null, config,
      async () => topology(await client.getStoreViews(), 'store_views', config)),
  };
  for (const group of storeTopology.storeGroups) {
    located('store_topology_normalization', 'store_groups', group, config, () => {
      if (!storeTopology.websites.some((w) => w.id === group.website_id)) invalid();
    });
  }
  for (const view of storeTopology.storeViews) {
    located('store_topology_normalization', 'store_views', view, config, () => {
      if (!storeTopology.storeGroups.some((g) => g.id === view.store_group_id && g.website_id === view.website_id)) invalid();
    });
  }
  const attributeSets = (await pages(client.listAttributeSets, (raw) => {
    object(raw);
    const set = { attribute_set_id: integer(raw.attribute_set_id, 1), attribute_set_name: string(raw.attribute_set_name) };
    if (!set.attribute_set_name) invalid();
    optional(raw, set, ['sort_order', 'entity_type_id'], integer);
    return set;
  }, 'attribute_set_id', 'attribute_set_metadata', 'attribute_set', config))
    .sort((a, b) => a.attribute_set_id - b.attribute_set_id);
  const attributes = (await pages(client.listProductAttributes, normalizeAttribute, 'attribute_code',
    'product_attribute_normalization', 'attribute', config))
    .sort((a, b) => compare(a.attribute_code, b.attribute_code));
  located('product_attribute_normalization', 'attribute_list', null, config, () => unique(attributes, 'attribute_id'));
  const byCode = new Map(attributes.map((a) => [a.attribute_code, a]));
  let memberships = 0;
  for (const set of attributeSets) {
    await located('assigned_attribute_membership', 'attribute_set', set, config, async () => {
      const assigned = unique(bounded(await client.getAttributeSetAttributes(set.attribute_set_id))
        .map((item, index) => located('assigned_attribute_membership', 'attribute',
          { ...(item && typeof item === 'object' ? item : {}), index, attribute_set_id: set.attribute_set_id },
          config, () => normalizeAttribute(item))), 'attribute_code');
      memberships += assigned.length;
      if (memberships > 100000) throw new MagentoIntegrationError('MAGENTO_DISCOVERY_LIMIT');
      for (const attribute of assigned) {
        located('assigned_attribute_membership', 'attribute', attribute, config, () => {
          const known = byCode.get(attribute.attribute_code);
          if (!known || Object.entries(attribute).some(([key, value]) => Object.hasOwn(known, key) && known[key] !== value)) invalid();
          // Some endpoints expose more optional metadata than others. Retain it,
          // but reject conflicting observations instead of silently choosing one.
          Object.assign(known, attribute);
        });
      }
      set.attributeCodes = sorted(assigned.map((a) => a.attribute_code));
    });
  }
  const mapper = located('mapper_derivation', 'mapper', null, config, describeMapper);
  const mapperTargets = new Set(mapper.targets.map((target) => target.target));
  let optionCount = 0;
  for (const attribute of attributes) {
    // Include all actual mapper targets, even non-select attributes: custom
    // source models and boolean fields can expose options too. An empty list
    // on a text attribute is not an unmatched-label finding.
    if (OPTION_INPUTS.has(attribute.frontend_input) || mapperTargets.has(attribute.attribute_code)) {
      await located('option_normalization', 'attribute', attribute, config, async () => {
        attribute.options = normalizeOptions(await client.getProductAttributeOptions(attribute.attribute_code));
        attribute.optionCount = attribute.options.length;
        optionCount += attribute.optionCount;
        if (optionCount > 100000) throw new MagentoIntegrationError('MAGENTO_DISCOVERY_LIMIT');
      });
    }
  }
  return located('report_assembly', 'report', null, config, () => {
    const report = { reportVersion: 1, storeCode, mapperSource: mapper.source,
      limitations: ['Sequential GET observations, not an atomic Magento snapshot.',
        'Exact labels are candidate evidence only; Amber value IDs and Magento option IDs are separate identities.',
        'Code-backed mapper only; deployed Amber catalog, saved drafts and publications are not read.',
        'All output branches are inspected without evaluating business conditions; dynamic outputs are not enumerated.',
        'CSV controls are checked by literal field name but their absence is not an EAV error.'],
      storeTopology, attributeSets, attributes, mapperSources: mapper.sources,
      ...located('mapper_comparison', 'mapper', null, config, () => compareMapper(mapper, attributes, attributeSets)) };
    const serialized = JSON.stringify(report);
    if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) throw new MagentoIntegrationError('MAGENTO_DISCOVERY_LIMIT');
    // Reject reflected credentials even inside otherwise allowed schema labels.
    // Do not redact labels into misleading matching evidence.
    const secrets = ['consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret']
      .flatMap((key) => [config[key], percentEncode(config[key])]);
    const strings = [];
    function collect(value) {
      if (typeof value === 'string') strings.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    }
    collect(report);
    if (strings.some((value) => /OAuth\s|oauth_signature|Authorization\s*:/i.test(value)
      || secrets.some((secret) => secret && value.includes(secret)))) {
      throw new MagentoIntegrationError('MAGENTO_AUDIT_SENSITIVE_DATA');
    }
    return report;
  });
}

module.exports = { auditMagentoSchema, normalizeOptions, normalizeAttribute, MAX_REPORT_BYTES };
