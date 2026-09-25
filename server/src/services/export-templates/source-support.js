// Closed, opt-in source policy. Captured questionContracts.allowed remains catalog
// membership; mappings never confer authority. No DB access or client proof flags.
const { fail } = require('./input-projection');
const { parseVariationSku, parseVersionedSkuPart, buildSkuSuffixDecodeAttempts, decodeStoredSkuAnswers } = require('../../utils/sku');
const VERSION = 'historical-source-support-v1';
const EVALUATOR = 'magento-declarative-2';
const TARGETS = ['NM.extra', 'AR.size'];
const projections = new WeakMap();
const location = (s) => s?.kind !== 'product' ? `${s.category}.${s.key}` : null;
const policyFor = (d, s) => d.sourceSupport?.sources[location(s)];

function validateSupport(d, { check, shape, list, membership }) {
  if (!Object.hasOwn(d, 'sourceSupport')) { check(d.evaluatorVersion !== EVALUATOR, 'Source support policy required'); return; }
  check(d.evaluatorVersion === EVALUATOR, 'Source support evaluator required');
  shape(d.sourceSupport, ['version', 'sources']);
  check(d.sourceSupport.version === VERSION, 'Unknown source support version');
  const expected = TARGETS.filter((key) => Object.values(d.sources).some((s) => location(s) === key));
  shape(d.sourceSupport.sources, expected);
  for (const key of expected) {
    const p = d.sourceSupport.sources[key];
    shape(p, ['semanticValues', 'deferredValues', 'placeholder']);
    check(p.placeholder === (key === 'NM.extra' ? 'numeric-zero-v1' : 'none'), 'Unsupported placeholder policy');
    for (const values of [p.semanticValues, p.deferredValues]) {
      list(values, 512); membership(values.length);
      check(values.every((v) => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) && new Set(values).size === values.length, 'Support value IDs');
    }
    check(p.deferredValues.every((v) => key === 'AR.size' && ['29', '30', '31'].includes(v)
      && !p.semanticValues.includes(v)), 'Conflicting or unapproved deferred values');
    for (const [id, s] of Object.entries(d.sources).filter(([, s]) => location(s) === key)) {
      check(s.kind === 'semantic' && s.aliases.length === 0, 'Supported historical source must be semantic and unaliased');
      const contracts = Object.values(d.questionContracts).filter((q) => q.source === id);
      check(contracts.length > 0, 'Captured membership required for supported source');
      for (const q of contracts) {
        check([...p.semanticValues, ...p.deferredValues].every((v) => q.allowed.includes(v))
          && q.allowed.every((v) => p.semanticValues.includes(v) || p.deferredValues.includes(v)
            || (key === 'NM.extra' && v === '0')), 'Incomplete/conflicting source membership');
      }
    }
  }
}

function upgradeSourceSupport(definition, evidence) {
  const { compileDefinition } = require('./definition');
  compileDefinition(definition);
  const next = structuredClone(definition);
  // Repeated preparation never promotes newly published live values.
  if (next.sourceSupport) return next;
  next.evaluatorVersion = EVALUATOR;
  next.sourceSupport = { version: VERSION, sources: {} };
  for (const key of TARGETS) {
    const descriptors = Object.entries(next.sources).filter(([, s]) => location(s) === key);
    if (!descriptors.length) continue;
    const source = descriptors[0][1];
    const allowed = [...new Set(Object.values(next.questionContracts)
      .filter((q) => descriptors.some(([id]) => id === q.source)).flatMap((q) => q.allowed))];
    const historical = new Set(evidence.schemas.filter((s) => s.category_code === source.category)
      .flatMap((s) => s.questions.filter((q) => q.key === source.key).flatMap((q) => q.value_ids)));
    const deferredValues = key === 'AR.size' ? allowed.filter((v) => ['29', '30', '31'].includes(v) && !historical.has(v)) : [];
    next.sourceSupport.sources[key] = {
      semanticValues: allowed.filter((v) => !deferredValues.includes(v) && !(key === 'NM.extra' && v === '0' && !historical.has(v))),
      deferredValues, placeholder: key === 'NM.extra' ? 'numeric-zero-v1' : 'none',
    };
  }
  compileDefinition(next);
  return next;
}

// Availability is about the frozen contract, never current catalog contents.
// Check the closed upgrade shape too: a valid legacy source may use an alias
// that this policy cannot support. Empty history here establishes only shape,
// never semantic authority; actual prepare/apply always read server evidence.
// The detached result is discarded. No stored definition is changed.
function sourceSupportUpdate(definition) {
  try { upgradeSourceSupport(definition, { schemas: [] }); } catch (cause) {
    if (cause.code !== 'TEMPLATE_INVALID') throw cause;
    return { status: 'unsupported', currentPolicy: VERSION, code: cause.code };
  }
  return { status: definition.sourceSupport ? 'current' : 'available', currentPolicy: VERSION };
}

// Server loaders supply the immutable schemas separately. JSON from a request or
// product.details cannot manufacture an association in this private WeakMap.
function projectSupportProducts(products, schemas) {
  const byId = new Map(schemas.map((s) => [String(s.id), s]));
  return products.map((product) => {
    const projected = { ...product };
    projections.set(projected, { schema: byId.get(String(product.sku_schema_version_id)) });
    return projected;
  });
}

function reconstruct(product, context) {
  if (Object.hasOwn(context, 'decoded')) return context.decoded;
  context.decoded = null;
  const schema = context.schema;
  if (!schema || schema.category_code !== product.category || String(schema.id) !== String(product.sku_schema_version_id)) return null;
  const { baseFullSku } = parseVariationSku(product.full_sku);
  if (!baseFullSku.startsWith(product.category)) return null;
  const parsed = parseVersionedSkuPart(baseFullSku.slice(product.category.length));
  if (parsed.version !== Number(schema.version)) return null;
  const successes = buildSkuSuffixDecodeAttempts(parsed.encodedWithSuffix)
    .map((attempt) => decodeStoredSkuAnswers(schema.questions, attempt.encodedPart, product.details?.answers)).filter(Boolean);
  if (!successes.length || successes.some((answers) => JSON.stringify(answers) !== JSON.stringify(successes[0]))) return null;
  context.decoded = successes[0];
  return context.decoded;
}

function checkSourceSupport(d, descriptor, product, raw, context) {
  const p = policyFor(d, descriptor);
  if (!p || raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return;
  const key = location(descriptor);
  const reject = (reason) => fail('SOURCE_SUPPORT_INVALID', `${key}: ${reason}`);
  if (!['number', 'string'].includes(typeof raw) || !/^(0|[1-9][0-9]*)$/.test(String(raw))) reject('invalid semantic value');
  if (!context) reject('authoritative historical schema evidence required');
  const decoded = reconstruct(product, context);
  const question = context.schema?.questions.filter((q) => q.key === descriptor.key);
  if (!decoded || question?.length !== 1) reject('schema ownership or stored SKU reconstruction failed');
  const answer = decoded.find((a) => a.key === descriptor.key);
  const q = question[0];
  const semantic = q.options.some((o) => String(o.value_id) === String(raw));
  if (semantic) {
    if (!p.semanticValues.includes(String(raw)) || !answer || answer.is_placeholder || String(answer.value_id) !== String(raw)) reject('semantic value is not supported by this template and product schema');
    return;
  }
  if (key !== 'NM.extra' || raw !== 0 || p.placeholder !== 'numeric-zero-v1'
    || Number(q.required) !== 0 || q.options.some((o) => /^0+$/.test(String(o.sku_code)))
    || !answer?.is_placeholder || answer.value_id !== null) reject('value is neither an authorized semantic value nor a proven numeric-zero placeholder');
}

function sourceSupportChecker(definition, product) {
  const evidence = projections.get(product);
  const context = evidence ? { schema: evidence.schema } : null;
  return (descriptor, raw) => checkSourceSupport(definition, descriptor, product, raw, context);
}

module.exports = { VERSION, EVALUATOR, validateSupport, upgradeSourceSupport, sourceSupportUpdate, policyFor, projectSupportProducts, sourceSupportChecker };
