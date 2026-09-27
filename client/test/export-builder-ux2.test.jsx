import { useEffect, useState } from 'react';
import { createRequire } from 'node:module';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DefinitionEditor } from '../src/components/export-templates/DefinitionEditor';
import { SourcePicker } from '../src/components/export-templates/SourcePicker';
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { upgradeColumns } = require('../../server/src/services/export-templates/column-contract');
const { hashJsonData, compileDefinition } = require('../../server/src/services/export-templates/definition');
const { evaluateProduct } = require('../../server/src/services/export-templates/evaluate');
const { catalog, product } = require('../../server/test/fixtures/magento-v1/contract');
const { homeDefinition, officeEvidence } = require('../../server/test/fixtures/export-source-support');
const { upgradeSourceSupport } = require('../../server/src/services/export-templates/source-support');
const baseline = () => upgradeColumns(materializeMagentoV1(catalog()));
let current;
function Editor({ initial = baseline(), registry }) {
  const [definition, setDefinition] = useState(initial);
  useEffect(() => { current = definition; }, [definition]);
  return <DefinitionEditor definition={definition} registry={registry} onChange={setDefinition} />;
}
const click = (name) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
const change = (name, value) => fireEvent.change((name === 'Текст у файлі' ? within(screen.getByRole('region', { name: 'Умова 1' })) : screen).getByLabelText(name, { exact: true }), { target: { value } });
beforeEach(() => { window.innerWidth = 1600; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('one category navigation and exact Main/EN cells edit independent name rules without implicit inheritance', () => {
  const initial = baseline(); const en = structuredClone(initial.groups[0].rows[1]); render(<Editor initial={initial} />);
  expect(screen.getAllByRole('tablist', { name: 'Категорії файлів' })).toHaveLength(1);
  expect(screen.queryByLabelText('Категорія')).toBeNull(); expect(screen.queryByLabelText('Мова')).toBeNull();
  click('BR / name / Основний'); expect(within(screen.getByRole('region', { name: 'Умова 1' })).getByLabelText('Текст у файлі').value).toContain('Браслет');
  const main = within(screen.getByRole('region', { name: 'Умова 1' })).getByLabelText('Текст у файлі').value;
  change('Текст у файлі', '[Main] ' + main); expect(current).toBe(initial); click('Застосувати до чернетки');
  expect(current.groups[0].rows[1]).toEqual(en);
  click('BR / name / EN'); expect(within(screen.getByRole('region', { name: 'Умова 1' })).getByLabelText('Текст у файлі').value).not.toContain('[Main]');
  change('Текст у файлі', '[EN] ' + within(screen.getByRole('region', { name: 'Умова 1' })).getByLabelText('Текст у файлі').value); click('Застосувати до чернетки');
  const result = evaluateProduct(compileDefinition(current), product('BR'));
  expect(result.base.name).toMatch(/^\[Main\]/); expect(result.english.name).toMatch(/^\[EN\]/);
  expect(Object.hasOwn(current.groups[0].rows[1].cells, 'price')).toBe(false);
});

it('custom future rules, extra properties and typed mappings survive open, Advanced, cancel and no-op apply exactly', () => {
  const initial = baseline(); initial.groups[0].rows[0].cells.meta_title = { op: 'futureExpression', value: [null, 0, '0', '', '  '] };
  initial.tables.unknown_local = { absentNeighbor: null, number: 0, text: '0', spaces: '  ' };
  const hash = hashJsonData(initial); render(<Editor initial={initial} />);
  click('BR / meta_title / Основний'); expect(screen.getByText(/Власне правило збережено/)).toBeTruthy();
  click('Розширені правила цієї колонки'); expect(screen.getByText(/Непідтримувана операція/)).toBeTruthy(); click('Скасувати');
  click('BR / meta_title / Основний'); click('Застосувати до чернетки'); expect(hashJsonData(current)).toBe(hash); expect(current).toBe(initial);
});

it('source discovery searches human labels and exposes only authorized sources with secondary type hints', () => {
  const registry = { productFields: ['weight'], references: { questions: [
    { category_code: 'BR', key: 'color', label: 'Колір', include_in_sku: 1 },
    { category_code: 'BR', key: 'unpublished', label: 'Неопублікована', include_in_sku: 1 },
  ], schemas: [{ category_code: 'BR', questions: [{ key: 'color' }] }] } };
  const set = vi.fn(); render(<SourcePicker registry={registry} group="BR" value="" onChange={set} />);
  change('Характеристика', 'колір'); expect(screen.getByRole('option', { name: 'Браслети → Колір' })).toBeTruthy(); expect(set).not.toHaveBeenCalled();
  expect(screen.queryByRole('option', { name: /Неопублікована/ })).toBeNull(); expect(screen.queryByRole('option', { name: /Вага/ })).toBeNull();
  fireEvent.click(screen.getByRole('option', { name: 'Браслети → Колір' })); expect(set).toHaveBeenCalledWith('BR.color');
});

it('historical placeholder, deferred catalog values and genuine semantic zero have different explanations without refresh', () => {
  const initial = upgradeSourceSupport(homeDefinition(), officeEvidence()); const hash = hashJsonData(initial);
  const view = render(<Editor initial={initial} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Намиста' })); click('NM / dodatkovo_namysta / Основний');
  expect(screen.getByText('Історичне порожнє значення підтверджується схемою товару.')).toBeTruthy();
  click('Технічні подробиці');
  expect(screen.getAllByText(/лише з підтвердженим історичним placeholder/).length).toBeGreaterThan(0);
  expect(screen.queryByText(/звичайне підтримуване значення/)).toBeNull(); click('Скасувати');
  fireEvent.click(screen.getByRole('tab', { name: 'Картини' })); click('AR / rozmir_kartyny / Основний');
  expect(screen.getByText(/ще не підтримується цією версією/)).toBeTruthy(); expect(screen.queryByText('⚠ Не вдалося підтвердити джерело для публікації.')).toBeNull();
  expect(hashJsonData(current)).toBe(hash); view.unmount();
  const zero = structuredClone(initial); zero.sourceSupport.sources['NM.extra'] = { semanticValues: ['0', '1', '2'], deferredValues: [] };
  render(<Editor initial={zero} />); fireEvent.click(screen.getByRole('tab', { name: 'Намиста' })); click('NM / dodatkovo_namysta / Основний');
  expect(screen.getByText('Джерело підтверджено')).toBeTruthy(); expect(screen.queryByText('Історичне порожнє значення підтверджується схемою товару.')).toBeNull();
});

it('numeric bands preserve inclusive and exclusive boundaries', () => {
  const initial = baseline(); render(<Editor initial={initial} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Намиста' })); click('NM / dovzhyna_namysta / Основний');
  const bands = screen.getByRole('table', { name: 'Числові діапазони' }); const rows = within(bands).getAllByRole('row');
  const first = within(rows[1]).getAllByRole('checkbox');
  const original = initial.bindings.find((b) => b.id === 'NM.dovzhyna_namysta').value;
  expect(first[0].checked).toBe(original.bands[0].minInclusive); expect(first[1].checked).toBe(original.bands[0].maxInclusive);
  fireEvent.click(first[1]); expect(current).toBe(initial); click('Застосувати до чернетки');
  expect(current.groups[1].rows[0].cells.dovzhyna_namysta.bands[0]).toEqual({ ...original.bands[0], maxInclusive: !original.bands[0].maxInclusive });
  expect(current.bindings).toEqual(initial.bindings);
});

it('ordinary fallback ordering and conditional branches change only after complete local application', () => {
  const initial = baseline(); const literal = (value) => ({ op: 'literal', value });
  initial.groups[0].rows[0].cells.meta_title = { op: 'firstPresent', policy: 'answer-v1', items: [literal('first'), literal('second')] };
  initial.groups[0].rows[0].cells.meta_description = { op: 'when', if: literal(true), then: literal('then'), else: literal('else') };
  render(<Editor initial={initial} />); click('BR / meta_title / Основний');
  expect(screen.getByText('Використати перше заповнене значення, зверху вниз.')).toBeTruthy();
  fireEvent.click(screen.getByText('1. first')); fireEvent.click(screen.getAllByRole('button', { name: 'Нижче' })[0]);
  expect(current).toBe(initial); click('Застосувати до чернетки');
  expect(evaluateProduct(compileDefinition(current), product('BR')).base.meta_title).toBe('second');
  click('BR / meta_description / Основний'); expect(screen.getByText('Коли виконуються умови')).toBeTruthy();
  fireEvent.change(within(screen.getByRole('region', { name: 'Інакше' })).getByLabelText('Текст у файлі'), { target: { value: '  fallback  ' } }); click('Застосувати до чернетки');
  expect(current.groups[0].rows[0].cells.meta_description).toEqual({ op: 'when', if: literal(true), then: literal('then'), else: literal('  fallback  ') });
  expect(evaluateProduct(compileDefinition(current), product('BR')).base.meta_description).toBe('then');
});

it('category, rule-cell and header-menu arrow keys retain focus and never mutate a definition', () => {
  const initial = baseline(); render(<Editor initial={initial} />);
  const tab = screen.getByRole('tab', { name: 'Браслети' }); tab.focus(); fireEvent.keyDown(tab, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Намиста' }));
  fireEvent.keyDown(document.activeElement, { key: 'Home' });
  const main = screen.getByRole('button', { name: 'BR / name / Основний' }); main.focus(); fireEvent.keyDown(main, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'BR / name / EN' }));
  const menu = screen.getByRole('button', { name: 'Дії колонки name' }); menu.focus(); fireEvent.click(menu);
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Налаштувати' }));
  fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' }); expect(document.activeElement.textContent).toBe('Додати ліворуч');
  fireEvent.keyDown(document.activeElement, { key: 'Escape' }); expect(document.activeElement).toBe(menu); expect(current).toBe(initial);
});

it('content width switches to a contained inspector dialog without shrinking the table beside it', () => {
  let resize; let width = 1800;
  vi.stubGlobal('ResizeObserver', class { constructor(callback) { resize = callback; } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width }));
  render(<Editor />); click('BR / meta_title / Основний');
  expect(screen.getByRole('complementary', { name: 'Налаштування колонки' })).toBeTruthy();
  act(() => { width = 1100; resize(); }); expect(screen.getByRole('dialog', { name: 'Налаштування колонки' })).toBeTruthy();
  expect(document.querySelector('.et-design-with-panel')).toBeNull();
  act(() => { width = 390; resize(); }); expect(screen.getAllByRole('tablist', { hidden: true })).toHaveLength(1);
  click('Скасувати'); expect(screen.queryByRole('dialog')).toBeNull();
});
