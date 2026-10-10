// Pure requiredness proof from one immutable publication. Historical callers
// omit product: today's answers cannot absolve an earlier optional-empty receipt.
const { assertCompiled } = require('../export-templates/definition');
const { readSource } = require('../export-templates/input-projection');
const { sourceSupportChecker } = require('../export-templates/source-support');
const { routeTools } = require('./binding-evidence-routes');
const { productRoutePlans } = require('./first-sync-route');

const present = value => value !== undefined && value !== null
  && !(typeof value === 'string' && value.trim() === '');
const normalize = value => value == null ? value : Number.isNaN(Number(value)) ? String(value) : Number(value);
const all = values => values.includes(false) ? false : values.includes(null) ? null : true;
const any = values => values.includes(true) ? true : values.includes(null) ? null : false;
const unproven = reason => ({ state: 'unproven', reason, questionIds: [] });
const object = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const bounded = value => value === null || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
  || typeof value === 'string' && value.length <= 4096;

function classifySemanticRequirement({ compiled, target, scope, source, product } = {}) {
  try { assertCompiled(compiled); } catch { return unproven('EXACT_COMPILED_DEFINITION_REQUIRED'); }
  if (!source || source.definitionHash !== compiled.hash || !['all', 'en'].includes(scope)
    || typeof source.routeKey !== 'string') return unproven('FIELD_SOURCE_IDENTITY_UNPROVEN');
  const definition = compiled.definition, bindings = new Map(definition.bindings.map(item => [item.id, item.value]));
  let work = 0;
  const tick = () => { if (++work > 20000) throw Error('REQUIREMENT_PROOF_LIMIT'); };
  const deref = raw => {
    let node = raw;
    while (node?.op === 'ref') { tick(); node = bindings.get(node.id); }
    return node;
  };
  const normalizePlan = plan => {
    const predicates = plan.predicates.map(p => ({ questionKey: p.key, valueId: p.value, equal: p.equal }))
      .sort((a, b) => {
        const key = p => p.questionKey + (p.equal ? '=' : '!=') + 'value_id:' + p.valueId;
        return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
      });
    return { ...plan, predicates, routeKey: predicates.length ? plan.amberGroup + '.'
      + predicates.map(p => p.questionKey + (p.equal ? '=' : '!=') + 'value_id:' + p.valueId).join('&') : plan.amberGroup + ':all' };
  };
  try {
    const routes = routeTools(definition).plans.filter(plan => !plan.analysis && plan.predicates.every(predicate =>
      definition.sources[predicate.sourceId]?.kind === 'semantic' && definition.sources[predicate.sourceId].category === plan.amberGroup))
      .map(plan => ({ syntax: plan, normalized: normalizePlan(plan) }))
      .filter(plan => plan.normalized.routeKey === source.routeKey);
    if (routes.length !== 1) return unproven('FIELD_ROUTE_UNPROVEN');
    const { syntax, normalized } = routes[0];
    if (product !== undefined && productRoutePlans([normalized], product).length !== 1) return unproven('FIELD_ROUTE_PRODUCT_MISMATCH');
    const group = definition.groups.find(item => item.route === syntax.amberGroup);
    const cell = group?.rows.find(row => row.id === (scope === 'all' ? 'base' : 'english'))?.cells[target];
    if (!cell) return unproven('FIELD_TARGET_UNPROVEN');
    const captured = {}, frozen = product === undefined ? source.requirednessEvidence : undefined;
    const checkSupport = product === undefined ? null : sourceSupportChecker(definition, product);
    if (frozen !== undefined) {
      if (!object(frozen, ['version', 'definitionHash', 'routeKey', 'target', 'scope', 'values']) || frozen.version !== 1
        || frozen.definitionHash !== compiled.hash || frozen.routeKey !== source.routeKey || frozen.target !== target || frozen.scope !== scope
        || !frozen.values || Object.getPrototypeOf(frozen.values) !== Object.prototype || Object.keys(frozen.values).length > 64) {
        return unproven('REQUIREDNESS_EVIDENCE_INVALID');
      }
      for (const id of Reflect.ownKeys(frozen.values)) {
        if (typeof id !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(frozen.values, id), 'value')) return unproven('REQUIREDNESS_EVIDENCE_INVALID');
        const descriptor = definition.sources[id], value = frozen.values[id];
        if (!descriptor || descriptor.kind !== 'product' && descriptor.category !== syntax.amberGroup
          || !object(value, ['known', 'present', 'value']) || value.known !== true || typeof value.present !== 'boolean'
          || Object.hasOwn(value, 'value') && !bounded(value.value) || value.present !== present(value.value)) return unproven('REQUIREDNESS_EVIDENCE_INVALID');
        for (const predicate of syntax.predicates.filter(p => p.sourceId === id)) {
          if (!value.present || !['string', 'number'].includes(typeof value.value)
            || !/^(0|-?[1-9][0-9]*)$/.test(String(value.value)) || !Number.isSafeInteger(Number(value.value))
            || (String(value.value) === predicate.value) !== predicate.equal) return unproven('REQUIREDNESS_EVIDENCE_ROUTE_MISMATCH');
        }
      }
    }
    const referenced = new Set();
    function outputSources(raw) {
      tick(); const node = deref(raw); if (!node) return;
      if (node.op === 'source') referenced.add(node.id);
      else if (node.op === 'questionValue') {
        referenced.add(definition.questionContracts[node.question].source); outputSources(node.value);
      } else if (node.op === 'when') { outputSources(node.then); outputSources(node.else); }
      else if (node.op === 'require') outputSources(node.value);
      else if (node.op === 'error' || node.op === 'literal') return;
      else if (node.op === 'lookup') outputSources(node.input);
      else {
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach(item => { if (item?.op) outputSources(item); });
          else if (value?.op) outputSources(value);
          else if (value && typeof value === 'object') Object.values(value).forEach(item => { if (item?.op) outputSources(item); });
        }
      }
    }
    outputSources(cell);
    let matchedSource;
    if (source.kind === 'derived') {
      if (source.key || source.field && source.field !== target) return unproven('FIELD_SOURCE_IDENTITY_UNPROVEN');
    } else if (['semantic', 'information', 'product'].includes(source.kind)) {
      const matches = [...referenced].filter(id => {
        const descriptor = definition.sources[id];
        return descriptor?.kind === source.kind && (source.kind === 'product' ? descriptor.field === source.field
          : descriptor.category === syntax.amberGroup && descriptor.key === source.key);
      });
      if (matches.length !== 1) return unproven('FIELD_SOURCE_IDENTITY_UNPROVEN');
      matchedSource = matches[0];
    } else return unproven('FIELD_SOURCE_IDENTITY_UNPROVEN');

    function valueFor(id) {
      const descriptor = definition.sources[id];
      if (!descriptor) return { known: false };
      if (product !== undefined) {
        const value = readSource(descriptor, product);
        checkSupport(descriptor, value);
        if (present(value) && descriptor.kind === 'semantic'
          && (!['string', 'number'].includes(typeof value) || !/^(0|-?[1-9][0-9]*)$/.test(String(value))
            || !Number.isSafeInteger(Number(value)))) return { known: false };
        if (value !== undefined && !bounded(value)) return { known: false };
        captured[id] = { known: true, present: present(value), ...(value === undefined ? {} : { value }) };
        if (Object.keys(captured).length > 64) throw Error('REQUIREMENT_PROOF_LIMIT');
        return { known: true, value };
      }
      if (frozen && Object.hasOwn(frozen.values, id)) {
        const read = frozen.values[id];
        if (read.present && descriptor.kind === 'semantic'
          && (!['string', 'number'].includes(typeof read.value) || !/^(0|-?[1-9][0-9]*)$/.test(String(read.value))
            || !Number.isSafeInteger(Number(read.value)))) return { known: false };
        return { known: true, value: read.value };
      }
      const predicate = syntax.predicates.find(p => p.sourceId === id && p.equal);
      return predicate ? { known: true, value: predicate.value } : { known: false };
    }
    function matches(id, expected) {
      const read = valueFor(id);
      // A successful historical read can prove absence. Match the evaluator's
      // scalar comparison exactly; only an unavailable read remains unknown.
      if (read.known) return expected.map(normalize).includes(normalize(read.value));
      const excluded = syntax.predicates.filter(p => p.sourceId === id && !p.equal).map(p => normalize(p.value));
      return expected.every(value => excluded.includes(normalize(value))) ? false : null;
    }
    function rule(raw) {
      tick(); return all(Object.entries(raw).map(([key, value]) => key === '$and' ? all(value.map(rule))
        : key === '$or' ? any(value.map(rule)) : matches(key, Array.isArray(value) ? value : [value])));
    }
    const sourceNode = raw => {
      let node = deref(raw); if (node?.op === 'semanticKey') node = deref(node.input);
      return node?.op === 'source' ? node : null;
    };
    function condition(raw) {
      tick(); const node = deref(raw);
      if (node?.op === 'literal' && typeof node.value === 'boolean') return node.value;
      if (node?.op === 'catalogRule') return rule(definition.questionContracts[node.question].rule);
      if (node?.op === 'all') return all(node.items.map(condition));
      if (node?.op === 'any') return any(node.items.map(condition));
      if (node?.op === 'not') { const value = condition(node.input); return value === null ? null : !value; }
      if (node?.op === 'present') {
        const input = sourceNode(node.input), read = input && valueFor(input.id);
        return read?.known ? present(read.value) : null;
      }
      if (node?.op === 'eq') {
        const left = deref(node.left), input = left?.op === 'semanticKey' && sourceNode(left.input), right = deref(node.right);
        if (input && right?.op === 'literal' && typeof right.value === 'string') {
          const read = valueFor(input.id);
          if (read.known && present(read.value)) return String(read.value) === right.value;
          return syntax.predicates.some(p => p.sourceId === input.id && !p.equal && p.value === right.value) ? false : null;
        }
      }
      if (node?.op === 'in') {
        const left = deref(node.input), input = left?.op === 'semanticKey' && sourceNode(left.input);
        if (input) {
          const read = valueFor(input.id);
          if (read.known && present(read.value)) return node.values.includes(String(read.value));
        }
      }
      return null;
    }
    const questions = new Set();
    const merge = states => states.includes('unproven') ? 'unproven' : states.includes('required') ? 'required'
      : states.every(state => state === 'inactive') ? 'inactive' : 'optional';
    function inspect(raw) {
      tick(); const node = deref(raw); if (!node) return 'unproven';
      if (node.op === 'literal') return node.value === '' || node.value === null ? 'inactive' : 'optional';
      if (node.op === 'source') {
        if (definition.sources[node.id]?.kind !== 'semantic') return 'optional';
        // Reading the canonical source directly must not shed the question
        // contract captured by this same publication. Only reachable leaves
        // are checked: an outer inactive branch still has no requirement.
        const contracts = Object.entries(definition.questionContracts).filter(([, question]) => question.source === node.id);
        return contracts.length ? merge(contracts.map(([id, question]) => {
          questions.add(id);
          if (!question.exists) return 'unproven';
          const active = rule(question.rule);
          return active === false ? 'inactive' : active === null ? 'unproven' : question.required ? 'required' : 'optional';
        })) : 'optional';
      }
      if (node.op === 'error') return 'unproven';
      if (node.op === 'questionValue') {
        const question = definition.questionContracts[node.question]; questions.add(node.question);
        if (!question.exists) return 'unproven';
        const active = rule(question.rule);
        if (active === false) return 'inactive';
        if (active === null) return 'unproven';
        if (question.required) return 'required';
        // An optional canonical question returns empty before evaluating its
        // value/lookup when this exact recorded source is absent.
        return question.source === matchedSource ? 'optional' : inspect(node.value);
      }
      if (node.op === 'when') {
        const active = condition(node.if);
        return active === null ? 'unproven' : inspect(active ? node.then : node.else);
      }
      if (node.op === 'require') {
        const guard = deref(node.if), guarded = guard?.op === 'present' && sourceNode(guard.input);
        if (guarded && referenced.has(guarded.id)) return 'required';
        return condition(node.if) === true ? inspect(node.value) : 'unproven';
      }
      if (node.op === 'lookup') {
        const input = inspect(node.input), fallback = inspect(node.otherwise);
        return input === 'required' ? 'required' : merge([input, fallback]);
      }
      if (['numberText', 'decimalText', 'numericBand'].includes(node.op)) {
        const input = inspect(node.input);
        return input === 'required' || input === 'unproven' ? input
          : node.op === 'decimalText' && input === 'inactive' ? 'inactive' : 'unproven';
      }
      if (['text', 'semanticKey'].includes(node.op)) return inspect(node.input);
      if (node.op === 'join') return merge(node.items.map(inspect));
      if (node.op === 'interpolate') return merge(Object.values(node.slots).map(inspect));
      if (node.op === 'firstPresent') {
        const states = node.items.map(inspect);
        return states.some(state => ['required', 'unproven'].includes(state)) ? 'unproven' : merge(states);
      }
      return 'unproven';
    }
    const state = inspect(cell);
    return { state, reason: state === 'required' ? 'ACTIVE_REQUIRED_FIELD' : state === 'inactive' ? 'FIELD_INACTIVE_IN_ORIGINAL_ROUTE'
      : state === 'optional' ? 'FIELD_NOT_REQUIRED' : 'SEMANTIC_REQUIREMENT_UNPROVEN', questionIds: [...questions].sort(),
    ...(product === undefined ? {} : { evidence: { version: 1, definitionHash: compiled.hash,
      routeKey: source.routeKey, target, scope, values: captured } }) };
  } catch { return unproven('SEMANTIC_REQUIREMENT_UNPROVEN'); }
}

module.exports = { classifySemanticRequirement };
