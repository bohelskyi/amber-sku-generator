// Explicit, hashed policy for reviewed evaluator-5 successors. Old publications
// keep their original subject guards and evaluation semantics.
const POLICY = 'effective-product-names-v1';
const { own } = require('./input-projection');
const { hashJsonData } = require('./definition');
const validName = value => typeof value === 'string' && value.trim() !== ''
  && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
const pair = value => ({ all: own(value, 'all'), en: own(value, 'en') });
const validPair = value => validName(own(value, 'all')) && validName(own(value, 'en'));
const samePair = (a, b) => own(a, 'all') === own(b, 'all') && own(a, 'en') === own(b, 'en');
function resolveNames(generated, product) {
  let names = generated; let source = 'template'; let invalidStored = false;
  for (const key of ['magento_name_rule_pin', 'magento_name_override']) {
    const saved = own(product, key);
    if (!saved || !samePair(own(saved, 'generated'), generated)) continue;
    const values = own(saved, 'values');
    if (!validPair(values)) { invalidStored = true; continue; }
    names = pair(values); source = 'stored_full_names'; invalidStored = false;
  }
  return { generated, names, source, valid: !invalidStored && validPair(names), invalidStored };
}
function upgradeNameReadiness(definition) {
  const contract = require('./version-contract');
  if (!contract.isPublicEvaluator(definition.evaluatorVersion)) {
    throw Object.assign(new Error('Для підтримки ефективних назв потрібен шаблон публічної ідентичності.'), { code: 'TEMPLATE_INVALID' });
  }
  const next = require('./column-contract').upgradeColumns(definition);
  const sv = next.groups.find(group => group.route === 'SV');
  if (sv) {
    const bindings = new Map(next.bindings.map(binding => [binding.id, binding.value]));
    const check = bindings.get('SV.nameCheck');
    const expected = {
      op: 'require', if: { op: 'any', items: [{ op: 'ref', id: 'SV.manualPair' }, { op: 'ref', id: 'SV.automaticName' }] },
      value: { op: 'literal', value: '' }, error: { op: 'error', field: 'name', code: 'manual_name_required',
        message: { op: 'literal', value: 'Потрібна збережена українська та англійська назва товару.' } },
    };
    const reference = node => node?.op === 'ref' && node.id === 'SV.nameCheck' && Object.keys(node).length === 2;
    const owned = sv.evaluate.some(reference) || (sv.outputChecks || []).some(entry => reference(entry.rule));
    if (owned && hashJsonData(check) !== hashJsonData(expected)) {
      throw Object.assign(new Error('Перевірка назви змінена вручну. Перегляньте її перед підготовкою нового контракту.'), { code: 'TEMPLATE_INVALID' });
    }
    if (owned) {
      sv.evaluate = sv.evaluate.filter(node => !reference(node));
      sv.outputChecks = (sv.outputChecks || []).filter(entry => {
        if (!reference(entry.rule)) return true;
        if (entry.columns.length !== 1 || entry.columns[0] !== 'name') {
          throw Object.assign(new Error('Перевірка назви використовується іншими полями. Потрібен окремий перегляд.'), { code: 'TEMPLATE_INVALID' });
        }
        return false;
      });
    }
  }
  next.evaluatorVersion = contract.CHARACTERISTIC_EVALUATOR;
  next.sourceContractVersion = contract.CHARACTERISTIC_CONTRACT;
  next.nameReadiness = POLICY;
  require('./definition').compileDefinition(next);
  return next;
}
module.exports = { POLICY, validName, validPair, resolveNames, upgradeNameReadiness };
