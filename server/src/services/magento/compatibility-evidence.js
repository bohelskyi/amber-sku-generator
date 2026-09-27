const { createMagentoClient } = require('./client');
const { productEvidence, evaluate } = require('./binding-evidence-products');
const { optionCandidates, semanticEvidence, OPTION_INPUTS } = require('./binding-evidence-analysis');
const { PLANS, SIZE_CASES } = require('./compatibility-evidence-plans');
const { numericComparison, orientation, sizeOrientation, populated, scopeComparison, sizeTextOccurs } = require('./compatibility-evidence-comparisons');
const { MagentoIntegrationError } = require('./errors');

const STONE_FIELDS = ['decor_weight', 'rozmir_suveniriv', 'suveniry', 'kamin_obrobka', 'kamin_suvenirnyi',
  'kolir', 'typy_obrobky_burshtynu', 'fraction'];
const CH_FIELDS = ['dovzhyna_namystyny', 'diametr_namystyny', 'dovzhyna_vyrobu', 'rozmir_kameniu', 'vaha_vyrobu'];
const SCOPE_FIELDS = ['name', 'meta_title', 'meta_description', 'description', 'short_description'];
const SUBTYPE_FIELDS = ['vyd_statuetky', 'vyd_symvoliky'];
// Alternative AR representation is a bounded text observation, never a mapping.
const AR_OTHER_FIELDS = ['name', 'meta_title', 'description', 'short_description'];
const TARGETS = new Set([...STONE_FIELDS, ...CH_FIELDS, ...SCOPE_FIELDS, ...SUBTYPE_FIELDS, 'rozmir_kartyny', 'kulony_dodatkovo']);
const invalid = () => { throw new MagentoIntegrationError('MAGENTO_BINDING_EVIDENCE_INVALID'); };
function localScalar(value) {
  if (value === undefined || value === null) return null;
  if ((typeof value === 'string' && value.length <= 16384) || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return value;
  return invalid();
}
function tally(items, key) {
  const counts = {};
  for (const item of items) { const value = String(key(item)); counts[value] = (counts[value] || 0) + 1; }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
function resolved(schema, target, raw) {
  const attribute = schema.attributes.find((a) => a.attribute_code === target);
  if (!OPTION_INPUTS.has(attribute?.frontend_input)) return null;
  const ids = !populated(raw) ? [] : (Array.isArray(raw) ? raw : String(raw).split(',')).map(String);
  return ids.map((optionId) => ({ optionId, label: attribute.options.find((o) => o.value === optionId)?.label ?? null }));
}
function fieldEvidence(schema, target, item) {
  const observed = item.observed.fields[target] ?? null;
  const options = resolved(schema, target, observed);
  const expectedAvailable = Object.hasOwn(item.expected.base, target);
  const expected = expectedAvailable ? item.expected.base[target] : null;
  const unknownOption = options?.some((o) => o.label === null);
  const exact = !expectedAvailable || !populated(expected) || unknownOption ? null : options
    ? options.length === 1 && options[0].label === expected : String(expected) === String(observed);
  return { target, expectedAvailable, expected, observed, resolvedOptions: options, exactLabelOrValueMatch: exact,
    predictedSetMembership: item.selected ? item.selected.attributeCodes.includes(target) : null,
    actualSetMembership: schema.attributeSets.find((s) => s.attribute_set_id === item.observed.attributeSetId)
      ?.attributeCodes.includes(target) ?? null };
}

async function compatibilityEvidence(config, amber, schema, analysis, { fetchImpl, now, magentoSchemaObservedAt }) {
  const client = createMagentoClient(config, { fetchImpl, storeCode: 'all' });
  const cache = new Map();
  const allSkus = new Map();
  let productGetCount = 0;
  const maxProductGets = PLANS.reduce((sum, p) => sum + p.attempts, 0) + 20;
  async function get(product, scope = 'all') {
    if (allSkus.has(product.full_sku) && allSkus.get(product.full_sku) !== product.id) invalid();
    allSkus.set(product.full_sku, product.id);
    const key = `${scope}:${product.full_sku}`;
    if (!cache.has(key)) {
      if (++productGetCount > maxProductGets) invalid();
      try {
        const scoped = scope === 'all' ? client : createMagentoClient(config, { fetchImpl, storeCode: scope });
        cache.set(key, productEvidence(await scoped.findProductBySku(product.full_sku), scope === 'all' ? TARGETS : new Set(SCOPE_FIELDS)));
      } catch (cause) {
        if (cause.code !== 'MAGENTO_PRODUCT_NOT_FOUND') throw cause;
        cache.set(key, null);
      }
    }
    return cache.get(key);
  }
  async function sample(planId, accepts = () => true) {
    const plan = PLANS.find((p) => p.id === planId);
    const candidates = amber.candidates.filter((c) => c.route_id === planId).sort((a, b) => a.product_id - b.product_id);
    const eligibleCount = candidates[0]?.eligible_count ?? candidates.length;
    const items = []; const records = []; const skipped = [];
    let attempts = 0; let examined = 0;
    for (const candidate of candidates.slice(0, plan.scan)) {
      if (attempts === plan.attempts || items.length === plan.found) break;
      examined++;
      const product = amber.products.find((p) => p.id === candidate.product_id);
      if (!product || product.category !== plan.category || !Number.isSafeInteger(product.id) || product.id <= 0) invalid();
      const expected = evaluate(amber, product);
      if (!accepts(expected)) {
        skipped.push({ localProductId: product.id, reason: expected.ready ? 'required_outputs_not_populated' : 'evaluation_not_ready' });
        continue;
      }
      const predicted = expected.base.attribute_set_code ?? null;
      const matches = schema.attributeSets.filter((s) => s.attribute_set_name === predicted);
      const selected = matches.length === 1 ? matches[0] : null;
      const sourceKeys = [...new Set(Object.values(amber.compiled.definition.sources)
        .filter((s) => s.category === product.category).map((s) => s.key))].sort();
      const record = { localProductId: product.id, sku: product.full_sku, amberGroup: product.category,
        localStatus: candidate.local_status ?? null,
        evaluation: { ready: expected.ready, issueFields: expected.issueFields, provisional: !expected.ready },
        sourceAnswers: Object.fromEntries(sourceKeys.filter((key) => Object.hasOwn(product.details?.answers || {}, key))
          .map((key) => [key, localScalar(product.details.answers[key])])),
        predictedAttributeSet: { name: predicted, id: selected?.attribute_set_id ?? null,
          resolution: matches.length === 1 ? 'exact' : matches.length ? 'ambiguous' : 'missing' } };
      attempts++;
      const observed = await get(product);
      if (!observed) { records.push({ ...record, lookup: 'not_found' }); continue; }
      Object.assign(record, { lookup: 'found', magentoProductId: observed.magentoProductId,
        actualAttributeSetId: observed.attributeSetId, status: observed.status, visibility: observed.visibility });
      records.push(record);
      items.push({ product, expected, selected, observed, record });
    }
    return { items, evidence: { limits: { candidates: plan.scan, attempts: plan.attempts, found: plan.found },
      eligibleLocalCount: eligibleCount, examinedLocalCount: examined, attempts, found: items.length,
      notFound: records.filter((r) => r.lookup === 'not_found').length,
      unexaminedLocalCount: Math.max(0, eligibleCount - examined),
      stopReason: items.length === plan.found ? 'found_limit' : attempts === plan.attempts ? 'attempt_limit'
        : eligibleCount > examined ? 'local_scan_limit' : 'local_candidates_exhausted', skipped, products: records } };
  }

  const stone = await sample('sv_stone');
  for (const item of stone.items) item.record.fields = STONE_FIELDS.map((target) => fieldEvidence(schema, target, item));
  const svStoneAttributeSetEvidence = { ...stone.evidence,
    actualSetDistribution: tally(stone.items, (i) => i.observed.attributeSetId),
    set151Count: stone.items.filter((i) => i.observed.attributeSetId === 151).length,
    set154Count: stone.items.filter((i) => i.observed.attributeSetId === 154).length,
    fieldPresenceCounts: Object.fromEntries(STONE_FIELDS.map((target) => [target,
      stone.items.filter((i) => populated(i.observed.fields[target])).length])),
    fieldPresencePatterns: tally(stone.items, (i) => STONE_FIELDS.filter((t) => populated(i.observed.fields[t])).join(',')),
    classification: 'attribute_set_convention_review_required' };

  const ch = await sample('ch_dimensions');
  for (const item of ch.items) {
    const a = item.product.details?.answers || {}; const fields = item.observed.fields;
    item.record.localDimensions = Object.fromEntries(['bead_length', 'bead_width', 'rosary_length']
      .map((key) => [key, localScalar(a[key])]));
    item.record.localPhysicalWeight = localScalar(item.product.weight);
    item.record.fields = CH_FIELDS.map((target) => fieldEvidence(schema, target, item));
    item.record.comparisons = {
      orientation: orientation(a.bead_length, a.bead_width, fields.dovzhyna_namystyny, fields.diametr_namystyny),
      sizeTextOrientation: sizeOrientation(a.bead_length, a.bead_width, fields.rozmir_kameniu),
      rosaryLength: numericComparison(a.rosary_length, fields.dovzhyna_vyrobu),
      physicalWeight: numericComparison(item.product.weight, fields.vaha_vyrobu, true),
      templateNumericFields: Object.fromEntries(CH_FIELDS.filter((t) => t !== 'rozmir_kameniu').map((target) =>
        [target, numericComparison(item.expected.base[target], fields[target], target === 'vaha_vyrobu')])),
      templateSizeOrientation: (() => {
        const parts = typeof item.expected.base.rozmir_kameniu === 'string' ? item.expected.base.rozmir_kameniu.split('×') : [];
        return parts.length === 2 ? sizeOrientation(...parts, fields.rozmir_kameniu) : 'unavailable_or_non_numeric';
      })() };
  }
  const chDimensionEvidence = { ...ch.evidence,
    orientationCounts: tally(ch.items, (i) => i.record.comparisons.orientation),
    weightCounts: tally(ch.items, (i) => i.record.comparisons.physicalWeight),
    roundingDefinition: 'Observed value equals nearest integer of local value; observation only, not an approved rounding policy.' };

  const arSizeEvidence = { usageBasis: 'stored_semantic_answers', values: [] };
  for (const c of SIZE_CASES) {
    const samples = await sample(`ar_${c.valueId}`);
    const semantic = semanticEvidence(amber, { amberGroup: 'AR', questionKey: 'size' }, c.valueId);
    const outputs = analysis.bindingEvidence.filter((e) => e.amberGroup === 'AR' && e.target === c.target && e.row === 'base')
      .flatMap((e) => e.values.filter((v) => v.amber.some((a) => a.questionKey === 'size' && a.value_id === c.valueId)));
    const attribute = schema.attributes.find((a) => a.attribute_code === c.target);
    for (const item of samples.items) {
      item.record.fields = [fieldEvidence(schema, c.target, item)];
      const labels = [...new Set(outputs.map((o) => o.mapperOutput))].filter(populated);
      item.record.alternativeSizeEvidence = { inspectedFields: AR_OTHER_FIELDS,
        classification: 'bounded_text_occurrences_only_not_a_mapping',
        matches: AR_OTHER_FIELDS.flatMap((target) => labels.filter((label) => sizeTextOccurs(item.observed.fields[target], label))
          .map((label) => ({ target, matchedSizeText: label }))) };
    }
    arSizeEvidence.values.push({ value_id: c.valueId, semanticEvidence: semantic,
      usage: amber.usage.find((u) => u.category === 'AR' && u.key === 'size' && u.valueId === c.valueId) ?? null,
      enumeratedMapperOutputs: outputs, templateOutput: outputs.length ? 'enumerated_see_reachability' : 'not_enumerated',
      currentLabelCandidates: semantic.current.map((o) => ({ label: o.label,
        evidenceSource: 'current_catalog_label_not_mapper_output', ...optionCandidates(attribute, o.label) })),
      authority: 'evidence_only', ...samples.evidence });
  }

  const kl = await sample('kl_inclusion');
  for (const item of kl.items) {
    const field = fieldEvidence(schema, 'kulony_dodatkovo', item);
    item.record.fields = [field];
    item.record.reportedConvention = field.resolvedOptions?.length === 1 && field.resolvedOptions[0].optionId === '6047'
      && field.resolvedOptions[0].label === 'Інзклюз' ? 'observed_6047_reported_label' : 'exception';
  }
  const klInclusionEvidence = { ...kl.evidence, reportedOption: { optionId: '6047', label: 'Інзклюз' },
    observedSchemaOption: schema.attributes.find((a) => a.attribute_code === 'kulony_dodatkovo')?.options
      .find((o) => o.value === '6047') ?? null,
    conventionCounts: tally(kl.items, (i) => i.record.reportedConvention) };

  const subtype = await sample('sv_subtype', (expected) => expected.ready && SUBTYPE_FIELDS.every((t) => populated(expected.base[t])));
  for (const item of subtype.items) {
    item.record.fields = SUBTYPE_FIELDS.map((target) => fieldEvidence(schema, target, item));
    item.record.comparison = item.record.fields.some((f) => f.exactLabelOrValueMatch === null) ? 'unresolved'
      : item.record.fields.every((f) => f.exactLabelOrValueMatch) ? 'exact' : 'mismatch';
  }
  const svSubtypeEvidence = { ...subtype.evidence, comparisonCounts: tally(subtype.items, (i) => i.record.comparison) };

  const storeScopeEvidence = { classification: 'field_ownership_evidence', groups: [],
    inheritance: 'REST GET equality cannot prove explicit override versus inheritance from global scope.' };
  for (const group of ['BR', 'NM', 'KL', 'CH', 'AR']) {
    const samples = await sample(`scope_${group}`);
    for (const item of samples.items) {
      const scopes = { all: Object.fromEntries(SCOPE_FIELDS.map((f) => [f, item.observed.fields[f] ?? null])) };
      const scopeStatus = { all: 'found' };
      for (const scope of ['ua', 'en']) {
        if (!schema.storeTopology.storeViews.some((s) => s.code === scope && s.is_active === true)) {
          scopeStatus[scope] = 'unavailable_or_inactive'; continue;
        }
        const observed = await get(item.product, scope);
        scopeStatus[scope] = observed ? 'found' : 'not_found';
        if (!observed) continue;
        if (observed.magentoProductId !== item.observed.magentoProductId || observed.attributeSetId !== item.observed.attributeSetId) invalid();
        scopes[scope] = Object.fromEntries(SCOPE_FIELDS.map((f) => [f, observed.fields[f] ?? null]));
      }
      item.record.scopes = scopes; item.record.scopeStatus = scopeStatus;
      item.record.comparisons = SCOPE_FIELDS.map((f) => scopeComparison(f, scopes, item.expected));
    }
    storeScopeEvidence.groups.push({ amberGroup: group, ...samples.evidence });
  }
  return { reportVersion: 1, mode: 'compatibility', generatedAt: now(), limitations: [
    'Bounded deterministic samples are not a census or proof of the correct production convention. Unexamined local counts are explicit.',
    'Current/uncorrected means active with no correction successor, following the existing product-information eligibility rule.',
    'Local database evidence is a read-only repeatable-read snapshot; later Magento GET observations are not an atomic cross-system snapshot.',
    'All predicted/evaluated values come from the existing evaluator. Non-ready evaluations are provisional, not binding authority.',
    'No set, option, orientation, rounding, ownership or persistence policy is chosen. Label candidates are not bindings.',
    'Option labels are all-scope schema observations. REST GET equality cannot prove explicit store override versus inheritance.',
    'AR alternative representation checks only size-text occurrences in the four named text fields, not arbitrary Magento fields.',
    'SV subtype eligibility requires both evaluated subtype outputs and a ready evaluation within the first 100 current SV candidates.',
  ], sources: { amberObservedAt: amber.observedAt, magentoSchemaObservedAt, template: amber.template },
  svStoneAttributeSetEvidence, chDimensionEvidence, arSizeEvidence, klInclusionEvidence, svSubtypeEvidence, storeScopeEvidence,
  summary: { productGetCount, maxProductGets, stoneFound: stone.items.length, chFound: ch.items.length,
    arFound: arSizeEvidence.values.reduce((n, v) => n + v.found, 0), klFound: kl.items.length, subtypeFound: subtype.items.length,
    scopeFound: storeScopeEvidence.groups.reduce((n, g) => n + g.found, 0) } };
}
module.exports = { compatibilityEvidence };
