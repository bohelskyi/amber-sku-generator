import { changeControl } from './helpers/searchable-picker';
import { useEffect, useState } from 'react';
import { createRequire } from 'node:module';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DefinitionEditor } from '../src/components/export-templates/DefinitionEditor';
import { SourceDiagnostics } from '../src/components/export-templates/SourceDiagnostics';
import { conditionChain } from '../src/lib/export-template-conditions';
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { upgradeColumns } = require('../../server/src/services/export-templates/column-contract');
const { compileDefinition, hashJsonData } = require('../../server/src/services/export-templates/definition');
const { evaluateProduct } = require('../../server/src/services/export-templates/evaluate');
const { catalog, product } = require('../../server/test/fixtures/magento-v1/contract');
const literal = (value) => ({ op: 'literal', value });
const source = { op: 'source', id: 'AR.type' };
const condition = (id, result, otherwise) => ({ op: 'when', if: { op: 'eq', left: { op: 'semanticKey', input: source }, right: literal(id) }, then: literal(result), else: otherwise });
const landscape = 'Купити пейзаж з бурштину від Amber Galbin...';
const icon = 'Купити ікону з бурштину від Amber Galbin...';
const fallback = 'Картини з бурштину від Amber Galbin...';
const registry = { productFields: ['full_sku', 'weight'], references: { questions: [
  { category_code: 'AR', key: 'type', label: 'Тип картини', include_in_sku: 1, value_ids: ['1', '2', '3'] },
], schemas: [{ category_code: 'AR', questions: [{ key: 'type', value_ids: ['1', '2', '3'] }] }] } };
const evidence = { current: [{ label: 'Тип картини', include_in_sku: 1, options: [
  { value_id: '1', label: 'Ікона' }, { value_id: '2', label: 'Пейзаж' }, { value_id: '3', label: 'Панно' },
] }], historical: [], truncated: false };
const loadSource = vi.fn(async () => ({ data: evidence }));
let current;
const baseline = () => upgradeColumns(materializeMagentoV1(catalog()));
const ar = (d) => d.groups.find((g) => g.route === 'AR');
const expression = (d) => ar(d).rows[0].cells.meta_description;
function fixture(chain = false) {
  const d = baseline(); ar(d).rows[0].cells.meta_description = condition('2', landscape, chain ? condition('1', icon, literal(fallback)) : literal(fallback)); return d;
}
function Editor({ initial }) {
  const [definition, setDefinition] = useState(initial);
  useEffect(() => { current = definition; }, [definition]);
  return <DefinitionEditor definition={definition} onChange={setDefinition} registry={registry} loadSource={loadSource} />;
}
const click = (name, scope = screen) => fireEvent.click(scope.getByRole('button', { name, exact: true }));
const change = (label, value, scope = screen) => changeControl(scope.getByLabelText(label, { exact: true }), value);
const row = (index) => within(screen.getByRole('region', { name: `Умова ${index}` }));
const result = (d, type) => evaluateProduct(compileDefinition(JSON.parse(JSON.stringify(d))), product('AR', { type })).base.meta_description;
async function open(initial, language = 'Основний') {
  render(<Editor initial={initial} />); fireEvent.click(screen.getByRole('tab', { name: 'Картини' })); click(`AR / meta_description / ${language}`);
  await waitFor(() => expect(row(1).getByLabelText('Значення характеристики').value).not.toBe(''));
}
beforeEach(() => { window.innerWidth = 1600; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('UX5 converts constant SEO into two conditions with exact fallback, isolated Main edits and no early mutation', async () => {
  const d = baseline(); ar(d).rows[0].cells.meta_description = literal('  Original SEO\n'); const original = JSON.stringify(d);
  render(<Editor initial={d} />); fireEvent.click(screen.getByRole('tab', { name: 'Картини' })); click('AR / meta_description / Основний');
  expect([...screen.getByLabelText('Як формується значення').options].map((o) => o.value)).toEqual(['empty','literal','characteristic','text','condition','fallback','complex']);
  change('Як формується значення', 'condition');
  expect(within(screen.getByRole('region', { name: 'Інакше' })).getByLabelText('Текст у файлі').value).toBe('  Original SEO\n');
  change('Характеристика', 'AR.type', row(1)); fireEvent.focus(row(1).getByLabelText('Значення характеристики')); await screen.findByRole('option', { name: 'Пейзаж' });
  change('Значення характеристики', '"2"', row(1)); change('Текст у файлі', landscape, row(1)); click('Додати умову');
  change('Характеристика', 'AR.type', row(2)); fireEvent.focus(row(2).getByLabelText('Значення характеристики')); await row(2).findByRole('option', { name: 'Ікона' });
  change('Значення характеристики', '"1"', row(2)); change('Текст у файлі', icon, row(2));
  expect(JSON.stringify(current)).toBe(original); click('Застосувати до чернетки');
  expect(result(current, 2)).toBe(landscape); expect(result(current, 1)).toBe(icon); expect(result(current, 3)).toBe('  Original SEO\n');
  expect(ar(current).rows[1]).toEqual(ar(d).rows[1]); expect(current.bindings).toEqual(d.bindings);
});

it.each(['empty','characteristic','text','condition','fallback'])('UX5 cancels %s transformation byte-exactly', (intent) => {
  const d = baseline(); ar(d).rows[0].cells.meta_description = literal('  exact\n'); const hash = hashJsonData(d);
  render(<Editor initial={d} />); fireEvent.click(screen.getByRole('tab', { name: 'Картини' })); click('AR / meta_description / Основний');
  change('Як формується значення', intent); expect(current).toBe(d); click('Скасувати'); expect(hashJsonData(current)).toBe(hash);
});

it('single and nested conditions open as labelled ordered rules with explicit fallback and no mutation', async () => {
  for (const chain of [false, true]) {
    const d = fixture(chain); const hash = hashJsonData(d); await open(d);
    expect(screen.getAllByRole('region', { name: /^Умова / })).toHaveLength(chain ? 2 : 1);
    expect(row(1).getByLabelText('Характеристика').value).toBe('Картини → Тип картини');
    expect(row(1).getByLabelText('Значення характеристики').value).toBe('Пейзаж');
    expect(within(screen.getByRole('region', { name: 'Інакше' })).getByLabelText('Текст у файлі').value).toBe(fallback);
    expect(current).toBe(d); click('Скасувати'); expect(hashJsonData(current)).toBe(hash);
    click('AR / meta_description / Основний'); click('Застосувати до чернетки'); expect(current).toBe(d); cleanup();
  }
});

it('adds a second condition through readable normal controls, saves exact outputs and leaves EN independent', async () => {
  const d = fixture(); const en = structuredClone(ar(d).rows[1]); await open(d);
  click('Додати умову'); click('Застосувати до чернетки'); expect(current).toBe(d); // unfinished row cannot apply
  change('Характеристика', 'AR.type', row(2)); fireEvent.focus(row(2).getByLabelText('Значення характеристики')); await waitFor(() => expect(row(2).getByRole('option', { name: 'Ікона' })).toBeTruthy());
  change('Значення характеристики', JSON.stringify('1'), row(2)); change('Текст у файлі', icon, row(2));
  expect(current).toBe(d); click('Застосувати до чернетки');
  expect(conditionChain(current, expression(current)).rows).toHaveLength(2);
  expect(result(current, 2)).toBe(landscape); expect(result(current, 1)).toBe(icon); expect(result(current, 3)).toBe(fallback);
  expect(ar(current).rows[1]).toEqual(en); expect(current.questionContracts).toEqual(d.questionContracts); expect(current.sources).toEqual(d.sources);
});

it('reordering chooses the first matching branch, removal retains the explicit fallback', async () => {
  const d = fixture(true); expression(d).else.if.right.value = '2'; await open(d);
  expect(result(d, 2)).toBe(landscape); click('Вище', row(2)); expect(document.activeElement).toBe(row(1).getByLabelText('Характеристика'));
  click('Застосувати до чернетки'); expect(result(current, 2)).toBe(icon);
  click('AR / meta_description / Основний'); click('Вилучити умову', row(1)); click('Застосувати до чернетки');
  expect(result(current, 2)).toBe(landscape); expect(result(current, 3)).toBe(fallback);
  expect(conditionChain(current, expression(current)).rows).toHaveLength(1);
});

it('a plain branch inserts a readable characteristic token and evaluates using existing interpolation', async () => {
  await open(fixture()); change('Текст у файлі', 'Купити ', row(1)); click('+ Додати характеристику', row(1));
  const pickers = row(1).getAllByLabelText('Характеристика'); changeControl(pickers[1], 'AR.type');
  const formats = row(1).getByLabelText('Як записувати значення');
  const option = [...formats.options].find((entry) => entry.value !== '__choose');
  expect(option.textContent).not.toMatch(/arType|arSeoSubject/); fireEvent.change(formats, { target: { value: option.value } });
  click('Вставити характеристику', row(1)); expect(row(1).getByLabelText('Текст у файлі').value).toContain('{Тип картини}');
  click('Застосувати до чернетки');
  expect(expression(current).then.op).toBe('interpolate'); expect(result(current, 2)).toBe('Купити ' + current.tables[option.value]['2']);
});

it('real AR SEO keeps its computed-presence guard and readiness dependencies when editing an ordinary branch', async () => {
  const d = baseline(); const original = structuredClone(d); await open(d);
  expect(screen.getByText(/Заповнюється, коли для характеристики/)).toBeTruthy();
  change('Текст у файлі', 'Мозаїка UX2', row(1)); click('Застосувати до чернетки');
  expect(result(current, 7)).toBe('Мозаїка UX2'); expect(result(current, 2)).toBe(result(original, 2));
  expect(current.bindings).toEqual(original.bindings); expect(current.questionContracts).toEqual(original.questionContracts);
  expect(expression(current).if).toEqual(expression(original).if);
  expect(expression(current).else).toEqual(expression(original).else);
});

it('unsupported predicates and custom results stay intact and offer Advanced without flattening', async () => {
  const d = fixture(); expression(d).then = { op: 'futureExpression', custom: { fallback: [0, null, ''] } };
  expression(d).if = { op: 'all', items: [expression(d).if, literal(true)] };
  const hash = hashJsonData(d); render(<Editor initial={d} />); fireEvent.click(screen.getByRole('tab', { name: 'Картини' })); click('AR / meta_description / Основний');
  expect(screen.getByText(/Умова використовує складну перевірку/)).toBeTruthy();
  expect([...screen.getByLabelText('Як формується значення').options].map((option) => option.value)).toEqual(['condition', 'complex']);
  expect(row(1).getAllByRole('button', { name: 'Розширені правила' })).toHaveLength(2);
  change('Текст у файлі', 'edited default', within(screen.getByRole('region', { name: 'Інакше' })));
  click('Скасувати'); expect(hashJsonData(current)).toBe(hash);
  click('AR / meta_description / Основний'); click('Розширені правила', within(screen.getByText(/Власне правило збережено/).parentElement));
  expect(screen.getByRole('button', { name: '← Звичайні налаштування' })).toBeTruthy(); click('Скасувати'); expect(hashJsonData(current)).toBe(hash);
});

it('EN conditions edit independently of Main and source option names never become comparison values', async () => {
  const d = fixture(); ar(d).rows[1].cells.meta_description = condition('2', 'Landscape', literal('Paintings')); await open(d, 'EN');
  change('Значення характеристики', JSON.stringify('1'), row(1)); change('Текст у файлі', 'Icon', row(1)); click('Застосувати до чернетки');
  expect(ar(current).rows[0]).toEqual(ar(d).rows[0]);
  expect(ar(current).rows[1].cells.meta_description.if.right.value).toBe('1');
  expect(evaluateProduct(compileDefinition(current), product('AR', { type: 1 })).english.meta_description).toBe('Icon');
});

it('membership and typed product comparisons use existing strict semantics; presence keeps zero filled', async () => {
  const d = fixture(); await open(d);
  change('Перевірка значення', 'in', row(1));
  const options = row(1).getByLabelText('Значення характеристики (можна кілька)');
  for (const option of options.options) option.selected = ['"1"', '"2"'].includes(option.value);
  fireEvent.change(options); click('Застосувати до чернетки');
  expect(result(current, 1)).toBe(landscape); expect(result(current, 2)).toBe(landscape); expect(result(current, 3)).toBe(fallback);
  click('AR / meta_description / Основний'); change('Характеристика', 'weight', row(1)); change('Перевірка значення', 'eq', row(1));
  change('Тип: Значення для порівняння', 'number', row(1)); click('Застосувати до чернетки');
  expect(evaluateProduct(compileDefinition(current), product('AR', {}, { weight: 0 })).base.meta_description).toBe(landscape);
  expect(evaluateProduct(compileDefinition(current), product('AR', {}, { weight: '0' })).base.meta_description).toBe(fallback);
  click('AR / meta_description / Основний'); change('Перевірка значення', 'present', row(1)); click('Застосувати до чернетки');
  expect(evaluateProduct(compileDefinition(current), product('AR', {}, { weight: 0 })).base.meta_description).toBe(landscape);
  expect(evaluateProduct(compileDefinition(current), product('AR', {}, { weight: null })).base.meta_description).toBe(fallback);
});

it('narrow conditional inspector keeps actions reachable in its existing dialog and details collapsed', async () => {
  window.innerWidth = 390; await open(fixture(true));
  const dialog = screen.getByRole('dialog', { name: 'Налаштування колонки' });
  expect(within(dialog).getByRole('button', { name: 'Застосувати до чернетки' })).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: 'Скасувати' })).toBeTruthy();
  expect([...dialog.querySelectorAll('details')].every((detail) => !detail.open)).toBe(true);
  expect(within(dialog).queryByText('Подробиці джерела')).toBeNull();
  expect(dialog.querySelector('pre')).toBeNull();
  const primary = dialog.cloneNode(true); primary.querySelectorAll('details').forEach((element) => element.remove());
  expect(primary.textContent).not.toMatch(/AR\.type|value_id|include_in_sku|semanticKey/);
  expect(row(1).getByLabelText('Текст у файлі').rows).toBe(3);
});

it('distinct source issues retain exact navigation and collapsed machine evidence, even with the same display label', () => {
  const d = baseline(); const onOpenSource = vi.fn();
  const diagnostics = ['AR.type', 'AR.size'].map((sourceId) => ({ sourceId, category: 'AR', key: 'size', code: 'SOURCE_REFERENCE_UNRESOLVED', message: 'Unverified semantic value IDs', unresolvedValueIds: ['29'] }));
  const { container } = render(<SourceDiagnostics definition={d} registry={registry} diagnostics={diagnostics} onOpenSource={onOpenSource} />);
  expect(screen.getAllByText('Картини → розмір')).toHaveLength(2);
  const primary = container.cloneNode(true); primary.querySelectorAll('details').forEach((element) => element.remove());
  expect(primary.textContent).not.toMatch(/SOURCE_REFERENCE|Unverified|AR\.size|value_id/);
  expect(screen.getAllByText(/SOURCE_REFERENCE_UNRESOLVED/)).toHaveLength(2);
  expect([...container.querySelectorAll('details')].every((details) => !details.open)).toBe(true);
  click('Картини → SEO опис · Основний · Тип картини');
  expect(onOpenSource).toHaveBeenCalledWith('AR.type', expect.objectContaining({ groupIndex: 4, rowIndex: 0, column: 'meta_description' }));
});
