const test = require('node:test');
const assert = require('node:assert/strict');
const { unusedDictionaryRefusal } = require('../src/services/magento/binding-source-refusal');

function fixture() {
  const option = { sourceKind: 'semantic', reviewState: 'blocked', evidence: { note: 'Reviewed dictionary-only refusal' },
    amberGroup: 'CH', questionKey: 'texture', valueId: '8', sourceKey: 'CH.texture=value_id:8',
    evaluatedOutput: 'Змішана', optionId: '5945', bindingKey: 'texture-binding' };
  const definition = { sources: { 'CH.texture': { kind: 'semantic', category: 'CH', key: 'texture', aliases: [] } },
    questionContracts: { 'CH.texture': { source: 'CH.texture', allowed: ['1', '2', '3', '4', '5', '6', '7'] } } };
  const plans = [{ attributes: [{ bindingKey: option.bindingKey, options: [structuredClone(option)] }] }];
  const evidence = { questions: [{ category_code: 'CH', key: 'texture', value_ids: ['1', '2', '3', '4', '5', '6', '7'] }],
    schemas: [{ category_code: 'CH', questions: [{ key: 'texture', value_ids: ['1', '2', '3', '4', '5', '6', '7'] }] }] };
  return { option, definition, plans, evidence };
}
async function check(f, used = false) {
  return unusedDictionaryRefusal({ async query(sql, args) {
    assert.match(sql, /p.status='active' AND p.corrected_to_product_id IS NULL/);
    assert.deepEqual(args, ['CH', 'texture', '8']);
    return { rows: [{ used }] };
  } }, f.option, f.definition, f.plans, f.evidence);
}

test('CH.texture=8 permits only an unused reviewed dictionary refusal without claiming its candidate option', async () => {
  const f = fixture(); const before = structuredClone(f);
  assert.equal(await check(f), true);
  assert.deepEqual(f, before);
  assert.equal(await check(f, true), false, 'later current usage invalidates the exception');
});

test('reachable, known, aliased, unreviewed and invented sources retain semantic validation', async () => {
  for (const change of [
    (f) => { f.option.reviewState = 'approved'; },
    (f) => { f.option.reviewState = 'proposed'; },
    (f) => { f.option.evidence.note = ''; },
    (f) => { f.definition.questionContracts['CH.texture'].allowed.push('8'); },
    (f) => { f.definition.questionContracts = {}; },
    (f) => { f.definition.sources['CH.texture'].aliases.push({ key: 'old_texture', schemaId: '1' }); },
    (f) => { f.evidence.questions[0].value_ids.push('8'); },
    (f) => { f.evidence.schemas[0].questions[0].value_ids.push('8'); },
    (f) => { f.evidence.questions.push(f.evidence.questions[0]); },
    (f) => { f.plans[0].attributes[0].options = []; },
    (f) => { f.plans[0].attributes[0].unsupportedSemanticOutput = true; },
    (f) => { f.option.evaluatedOutput = 'Invented'; },
  ]) {
    const f = fixture(); change(f);
    assert.equal(await check(f), false);
  }
});
