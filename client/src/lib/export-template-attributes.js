import { at, resolveNode, sourceOf, editField, editMapping, affectedFields } from './export-template-presentation.js';
import { copyDefinition, consumers, replaceAt } from './export-template-editor.js';

// A lens through existing wrappers, never an evaluator or a rewritten contract.
export function questionField(definition, cellPath) {
  let root = resolveNode(definition, at(definition, cellPath));
  const guards = [];
  while (!root.problem && ['when', 'require'].includes(root.node?.op)) {
    guards.push(root.node);
    const key = root.node.op === 'when' ? 'then' : 'value';
    root = resolveNode(definition, root.node[key], [...root.trail, key]);
  }
  if (root.problem || root.node?.op !== 'questionValue') return null;
  const contract = definition.questionContracts?.[root.node.question];
  if (!contract || !Array.isArray(contract.allowed) || !definition.sources[contract.source]
    || !contract.rule || typeof contract.rule !== 'object' || Array.isArray(contract.rule)) return null;
  let value = resolveNode(definition, root.node.value, [...root.trail, 'value']);
  while (!value.problem && ['when', 'require'].includes(value.node?.op)) {
    guards.push(value.node);
    const key = value.node.op === 'when' ? 'then' : 'value';
    value = resolveNode(definition, value.node[key], [...value.trail, key]);
  }
  if (value.problem || value.node?.op !== 'lookup' || sourceOf(definition, value.node.input) !== contract.source
    || !definition.tables[value.node.table]) return null;
  return { question: root.node, questionTrail: root.trail, contract, sourceId: contract.source, lookup: value.node, trail: value.trail, guards };
}

export function editQuestionMapping(definition, cellPath, scope, transform) {
  const lens = questionField(definition, cellPath);
  if (!lens) throw new Error('Це правило потребує розширеного редактора.');
  if (scope === 'shared') return editMapping(definition, cellPath, lens.trail, scope, transform);
  const group = definition.groups[cellPath[1]];
  const own = `${group.route} / ${group.rows[cellPath[3]].id === 'english' ? 'EN' : 'база'} / ${cellPath[5]}`;
  const outputConsumers = (id) => consumers(definition, 'ref', id).filter((name) => !name.endsWith('/ перевірка готовності'));
  const rootRef = lens.trail.find((step) => typeof step === 'object')?.ref;
  const exclusive = rootRef && outputConsumers(rootRef).every((name) => name === own)
    && affectedFields(definition, cellPath, lens.trail).filter((name) => !name.endsWith('/ перевірка готовності')).every((name) => name === own);
  // For a field-private binding keep readiness refs attached to that binding.
  // Only its table is detached when shared; repeated edits do not create copies.
  if (exclusive) {
    let count = 0;
    const visit = (n) => { if (!n || typeof n !== 'object') return; if (n.op === 'lookup' && n.table === lens.lookup.table) count++; Object.values(n).forEach(visit); };
    visit(definition);
    let id = lens.lookup.table;
    if (count > 1) { let i = 1; while (Object.hasOwn(definition.tables, `${id}.copy${i}`)) i++; id = `${id}.copy${i}`; }
    const next = editField(definition, cellPath, lens.trail, 'shared', (n) => ({ ...n, table: id }));
    return { ...next, tables: { ...next.tables, [id]: transform(copyDefinition(definition.tables[lens.lookup.table])) } };
  }
  const next = editMapping(definition, cellPath, lens.trail, 'local', transform);
  const prefix = rootRef ? lens.trail.slice(0, lens.trail.findIndex((step) => typeof step === 'object')) : lens.questionTrail;
  const originalQuestion = JSON.stringify(lens.question);
  const inlineBindings = rootRef ? [] : definition.bindings.filter((b) => b.group === group.route && JSON.stringify(b.value) === originalQuestion).map((b) => b.id);
  const ids = new Set(next.bindings.map((b) => b.id));
  const unique = (base) => { let i = 1; while (ids.has(`${base}.field${i}`)) i++; const id = `${base}.field${i}`; ids.add(id); return id; };
  const newId = unique(rootRef || `${group.route}.${cellPath[5]}`);
  next.bindings = [...next.bindings, { id: newId, group: group.route, value: at(at(next, cellPath), prefix) }];
  const replacements = new Map((rootRef ? [rootRef] : inlineBindings).map((id) => [id, newId]));
  const visiting = new Set();
  function readiness(n) {
    if (!n || typeof n !== 'object') return n;
    if (!rootRef && JSON.stringify(n) === originalQuestion) return { op: 'ref', id: newId };
    if (n.op === 'ref') {
      if (replacements.has(n.id)) return { ...n, id: replacements.get(n.id) };
      if (visiting.has(n.id) || outputConsumers(n.id).some((name) => name !== own)) return n;
      const binding = definition.bindings.find((b) => b.id === n.id);
      if (!binding) return n;
      visiting.add(n.id); const value = readiness(binding.value); visiting.delete(n.id);
      if (JSON.stringify(value) === JSON.stringify(binding.value)) return n;
      const id = unique(n.id); replacements.set(n.id, id); next.bindings.push({ ...binding, id, value });
      return { ...n, id };
    }
    return Array.isArray(n) ? n.map(readiness) : Object.fromEntries(Object.entries(n).map(([k, v]) => [k, readiness(v)]));
  }
  const evaluate = group.evaluate.map(readiness);
  if (group.outputChecks) next.groups[cellPath[1]].outputChecks = group.outputChecks.map((c) => ({ ...c, rule: readiness(c.rule) }));
  return replaceAt(replaceAt(next, [...cellPath, ...prefix], { op: 'ref', id: newId }), ['groups', cellPath[1], 'evaluate'], evaluate);
}

export function optionEvidence(details, id) {
  const current = (details?.current || []).flatMap((q) => q.options || []).filter((o) => String(o.value_id) === id);
  const historical = (details?.historical || []).flatMap((q) => (q.options || []).map((o) => ({ ...o, version: q.version }))).filter((o) => String(o.value_id) === id);
  return { current, historical };
}

export function fieldsForSource(definition, sourceId, includeDependencies = false) {
  const fields = []; const dependent = [];
  const ruleUses = (rule) => rule && typeof rule === 'object' && Object.entries(rule).some(([key, value]) => key === sourceId
    || (['$and', '$or'].includes(key) && Array.isArray(value) && value.some(ruleUses)));
  function uses(node, seen = new Set()) {
    if (!node || typeof node !== 'object') return false;
    if (node.op === 'source' && node.id === sourceId) return true;
    if (node.op === 'questionValue' || node.op === 'catalogRule') {
      const q = definition.questionContracts?.[node.question];
      if (q?.source === sourceId || ruleUses(q?.rule)) return true;
    }
    if (node.op === 'ref' && !seen.has(node.id)
      && uses(definition.bindings.find((b) => b.id === node.id)?.value, new Set([...seen, node.id]))) return true;
    return Object.values(node).some((v) => uses(v, seen));
  }
  definition?.groups?.forEach((group, gi) => group.rows.forEach((row, ri) => Object.keys(row.cells).forEach((column) => {
    const cellPath = ['groups', gi, 'rows', ri, 'cells', column];
    if (questionField(definition, cellPath)?.sourceId === sourceId) fields.push({ groupIndex: gi, rowIndex: ri, column });
    else if (uses(row.cells[column])) dependent.push({ groupIndex: gi, rowIndex: ri, column });
  })));
  return includeDependencies ? [...fields, ...dependent] : fields.length ? fields : dependent;
}
