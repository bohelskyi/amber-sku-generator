import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attentionProblemGroups, needsDeliveryRecovery, nextAction, problemImpact,
  problemRepairUrl, problemTaskKey, problemTitle,
} from '../src/components/attention/sync-problem-presentation.js';
import { problemCodeExplanation, problemCodePresentation } from '../src/lib/magento-problem-messages.js';

const titles = [
  ['DURABLE_REMOTE_ID_REQUIRED', 'Не підтверджено ідентичність товару Magento'],
  ['FIRST_SYNC_HISTORY_REVIEW_REQUIRED', 'Потрібна перевірка історії товару'],
  ['FIRST_SYNC_HISTORY_COMPONENT_UNSUPPORTED', 'Потрібне окреме узгодження історії'],
  ['LOCAL_EVIDENCE_CHANGED', 'Дані Amber змінилися під час перевірки'],
  ['PREDECESSOR_NOT_RETIRED', 'Попередню версію ще не виведено з обігу'],
  ['EXPOSURE_RECONCILIATION_CONFLICT', 'Не вдалося підтвердити історію доставки'],
  ['UPDATE_NOT_SENDABLE', 'Оновлення товару ще не готове'],
  ['PRODUCT_EVALUATION_NOT_READY', 'Дані товару не готові до синхронізації'],
];

for (const [code, title] of titles) test(`code-only ${code} has a human title without changing evidence`, () => {
  const problem = Object.freeze({ code });
  assert.equal(problemTitle(problem), title);
  assert.deepEqual(problem, { code });
});

test('every requested code has a stable human explanation and a next step', () => {
  for (const [code, title] of titles) {
    const text = problemCodePresentation(code);
    assert.equal(text.title, title);
    assert.match(text.detail, /[А-ЯІЇЄҐа-яіїєґ]/u);
    assert.match(text.nextStep, /[А-ЯІЇЄҐа-яіїєґ]/u);
    const explanation = problemCodeExplanation(code);
    assert.ok(explanation.includes(text.detail));
    assert.ok(explanation.includes(text.nextStep));
    assert.equal(explanation.includes(code), false);
    assert.throws(() => { text.title = 'Перезаписаний заголовок'; }, TypeError);
    assert.equal(problemCodePresentation(code).title, title);
  }
});

test('unknown, inherited, malformed and non-string codes never receive a known explanation', () => {
  const noCoercion = { toString() { throw new Error('Code lookup must not coerce objects'); } };
  for (const code of [undefined, null, 0, false, {}, [], noCoercion, 'constructor', 'toString', '__proto__',
    'hasOwnProperty', 'UNKNOWN_CODE', ' LOCAL_EVIDENCE_CHANGED', 'LOCAL_EVIDENCE_CHANGED ',
    'LOCAL_EVIDENCE_CHANGED: details', 'local_evidence_changed']) {
    assert.equal(problemCodePresentation(code), null);
    assert.equal(problemCodeExplanation(code), null);
  }
});

test('an exact redundant raw-code message receives the translation while custom detail stays intact', () => {
  for (const [code, title] of titles) {
    assert.equal(problemTitle(Object.freeze({ code, message: code })), title);
    const message = `${code}: конкретна додаткова причина`;
    assert.equal(problemTitle(Object.freeze({ code, message })), message);
  }
});

test('a nested unknown evaluator code does not mask the known outer product failure', () => {
  assert.equal(problemTitle({ code: 'PRODUCT_EVALUATION_NOT_READY', diagnosticCode: 'SOURCE_VALUE_UNAVAILABLE' }),
    'Дані товару не готові до синхронізації');
});

test('a concrete evaluator message wins over the general product title and field prefix', () => {
  assert.equal(problemTitle({ code: 'PRODUCT_EVALUATION_NOT_READY', target: 'weight', message: 'Загальне пояснення',
    evaluationIssues: [{ code: 'REQUIRED', field: 'weight', message: 'Вага має бути більшою за нуль.' }] }),
  'Вага має бути більшою за нуль.');
});

test('native upgrade instructions keep their exact server explanation and action', () => {
  const problem = { code: 'PRODUCT_EVALUATION_NOT_READY', diagnosticCode: 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED',
    resolution: 'integration_configuration', target: 'weight', message: 'Підготуйте підтримку нових характеристик для цієї категорії.' };
  assert.equal(problemTitle(problem), problem.message);
  assert.equal(nextAction(problem), 'Підготувати підтримку нових товарів');
});

test('semantic option context retains its exact field and zero value', () => {
  assert.equal(problemTitle({ code: 'PRODUCT_EVALUATION_NOT_READY', fieldLabel: 'Колір', valueLabel: 'Без кольору',
    causeContext: { kind: 'semantic_option', target: 'color', question: 'kolir', value: '0' } }),
  'Колір: значення «Без кольору» потребує відповідності');
});

for (const [primaryReason, title] of [
  ['INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP', 'Немає точного підтвердження, які попередні версії товару доставлено в Magento'],
  ['EVIDENCE_INTEGRITY_UNRESOLVED', 'Цілісність підтверджень попередньої доставки потребує перевірки'],
]) test(`lifecycle evidence remains more specific than a general translation: ${primaryReason}`, () => {
  const problem = { code: 'PREDECESSOR_NOT_RETIRED', resolution: 'lifecycle_reconciliation',
    message: 'Збережене пояснення', eligibilityIssue: { primaryReason } };
  assert.equal(problemTitle(problem), title);
  assert.equal(needsDeliveryRecovery(problem), true);
  assert.equal(nextAction(problem), 'Перевірити товар і вибрати рішення');
});

test('specific first-sync reason and known language remain in the visible title', () => {
  const problem = { code: 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED', resolution: 'first_sync_fields',
    reason: 'CANONICAL_WEIGHT_SETTER_UNSUPPORTED', target: 'weight', scope: 'en',
    message: 'Автоматичне прийняття ваги поки не підтримує всі пов’язані дані товару.' };
  assert.equal(problemTitle(problem), `Вага · EN: ${problem.message}`);
  assert.equal(problemImpact(problem), 'Передавання зупинено до вибору значень для непідтверджених полів.');
  assert.equal(nextAction(problem), 'Перевірити поля першого отримання');
});

test('custom server detail and category path are not replaced by a generic dictionary title', () => {
  assert.equal(problemTitle({ code: 'UPDATE_NOT_SENDABLE', path: 'Прикраси/Кулони', message: 'У цього товару не підтверджено набір характеристик.' }),
    'Прикраси/Кулони — У цього товару не підтверджено набір характеристик.');
});

test('unknown codes keep a neutral fallback and existing custom evidence', () => {
  assert.equal(problemTitle({ code: 'FUTURE_UNRECOGNIZED_CODE' }), 'Причину ще не визначено');
  assert.equal(problemTitle({ code: 'FUTURE_UNRECOGNIZED_CODE', message: 'Новий конкретний діагноз.' }), 'Новий конкретний діагноз.');
});

test('formatting preserves exact diagnostic grouping, order, repair context and task identity', () => {
  const first = Object.freeze({ code: 'PRODUCT_EVALUATION_NOT_READY', resolution: 'product', target: 'name',
    routeKey: 'SV:all', question: 'nazva', value: 0, message: 'Перше пояснення' });
  const second = Object.freeze({ ...first, message: 'Інше пояснення' });
  const duplicate = Object.freeze({ ...first });
  const uncertain = Object.freeze({ code: 'reconciliation_required', message: 'Результат ще не підтверджено.' });
  const records = Object.freeze([first, second, duplicate, uncertain]);
  const serialized = JSON.stringify(records);
  const before = attentionProblemGroups(records);
  const task = problemTaskKey(first);
  const href = problemRepairUrl(first, { productId: 7, category: 'SV' }, '/attention?group=chosen');
  for (const problem of records) { problemTitle(problem); problemImpact(problem); }
  assert.equal(JSON.stringify(records), serialized);
  const after = attentionProblemGroups(records);
  assert.equal(after.length, 3);
  assert.equal(after[0].problem, uncertain);
  assert.equal(after[1].problem, first);
  assert.deepEqual(after[1].evidence, [first, duplicate]);
  assert.equal(after[2].problem, second);
  assert.deepEqual(after.map(group => group.key), before.map(group => group.key));
  assert.equal(problemTaskKey(first), task);
  assert.equal(problemTaskKey(first), problemTaskKey(second));
  assert.equal(problemRepairUrl(first, { productId: 7, category: 'SV' }, '/attention?group=chosen'), href);
  const url = new URL(href, 'https://fixture.invalid');
  assert.equal(url.pathname, '/admin/catalog');
  assert.deepEqual(Object.fromEntries(url.searchParams), { view: 'text', productId: '7', category: 'SV',
    field: 'name', question: 'nazva', value: '0', route: 'SV:all', returnTo: '/attention?group=chosen' });
  assert.equal(nextAction(first), 'Доповнити дані товару');
  assert.equal(needsDeliveryRecovery(first), false);
  assert.equal(needsDeliveryRecovery(uncertain), true);
});
