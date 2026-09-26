import { changeControl } from './helpers/searchable-picker';
import { useEffect, useState } from 'react';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DefinitionEditor } from '../src/components/export-templates/DefinitionEditor';
import { columnChange } from '../src/lib/export-template-columns';
import { parsePreviewCsv } from '../src/lib/export-template-csv';

const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { upgradeColumns } = require('../../server/src/services/export-templates/column-contract');
const { catalog, product } = require('../../server/test/fixtures/magento-v1/contract');
const { compileDefinition, hashJsonData } = require('../../server/src/services/export-templates/definition');
const { evaluateBatch } = require('../../server/src/services/export-templates/evaluate');
const registry = { productFields: ['weight'], references: { questions: [{ category_code: 'BR', key: 'color', label: 'Колір', include_in_sku: 1, value_ids: ['1', '2', '3', '4'] }], schemas: [
  { category_code: 'BR', version: 1, questions: [{ key: 'color', value_ids: ['1', '2', '3', '4'] }] },
] } };
function fixture(existing = false) {
  let d = columnChange(upgradeColumns(materializeMagentoV1(catalog())), 0, 'add', null, 'test_export_note');
  d.groups[0].columnLabels = { price: 'Ціна', name: 'Назва', test_export_note: 'Тестова примітка' };
  d.groups[0].rows[0].cells.test_export_note.value = 'ПЕРЕВІРКА';
  if (existing) d = columnChange(d, 0, 'add', null, 'test_export_color');
  return d;
}
let current, updates;
function Editor({ initial = fixture(), readOnly = false, sourceRegistry = registry }) {
  const [definition, setDefinition] = useState(initial);
  useEffect(() => { current = definition; }, [definition]);
  return <DefinitionEditor definition={definition} registry={sourceRegistry} readOnly={readOnly} onChange={(next) => { updates++; setDefinition(next); }} />;
}
beforeEach(() => { updates = 0; window.innerWidth = 1600; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const click = (name) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
const columnName = () => { if (!screen.queryByLabelText('Назва колонки', { exact: true })) click('Змінити назву колонки'); return screen.getByLabelText('Назва колонки', { exact: true }); };
const change = (name, value) => {
  if (name === 'Назва колонки') columnName();
  if (name === 'Звідки брати значення' && !screen.queryByLabelText(name, { exact: true })) { name = 'Як формується значення'; value = value === 'source' ? 'characteristic' : value; }
  changeControl(screen.getByLabelText(name, { exact: true }), value);
};
const open = (code, row = 'Основний', group = 'BR') => click(`${group} / ${code} / ${row}`);
const apply = () => click('Застосувати до чернетки');
const menu = (code, action) => { click('Дії колонки ' + code); fireEvent.click(screen.getByRole('menuitem', { name: action, exact: true })); };
function mapping() {
  change('Звідки брати значення', 'source'); change('Характеристика', 'BR.color');
  expect(screen.getByLabelText('Як записувати значення').value).toBe('');
  change('Як записувати значення', 'mapping');
  expect(screen.getByRole('table', { name: 'Відповідності для колонки' })).toBeTruthy();
  expect(screen.queryByLabelText('Таблиця відповідностей')).toBeNull();
  expect(screen.getAllByText('Відповідності немає')).toHaveLength(4);
  if (screen.queryByText('Взяти збережені відповідності')) {
    fireEvent.click(screen.getByText('Взяти збережені відповідності'));
    click('Використати набір 1: "Світлий" / "Темний" / "Пейзажний"');
  } else for (const [i, text] of ['Світлий', 'Темний', 'Пейзажний', 'Комбінований'].entries()) {
    click(`Додати текст: Значення №${i + 1} — назву не підтверджено`);
    change(`Значення у CSV: Значення №${i + 1} — назву не підтверджено`, text);
  }
}

it('toolbar create is always a separate fresh transaction, including after closing an inspector', () => {
  const initial = fixture(true); render(<Editor initial={initial} />);
  for (const state of ['closed', 'open', 'closed-again']) {
    if (state !== 'closed') open('price');
    if (state === 'closed-again') click('Закрити налаштування');
    click('+ Колонка'); const dialog = screen.getByRole('dialog', { name: 'Нова колонка' });
    expect(within(dialog).getByLabelText('Назва колонки').value).toBe('');
    expect(within(dialog).getByLabelText('Код у CSV').value).toBe('');
    expect(within(dialog).queryByRole('button', { name: 'Видалити колонку' })).toBeNull();
    click('Скасувати'); expect(current).toBe(initial); expect(updates).toBe(0);
  }
});

it('cancel preserves already dirty edits and never applies pending label, text or creation input', () => {
  render(<Editor />); open('test_export_note'); change('Назва колонки', 'Локальна примітка'); apply();
  const dirty = current; const hash = hashJsonData(dirty); const count = updates;
  open('test_export_note'); change('Текст у файлі', 'not applied'); change('Назва колонки', 'not applied'); click('Скасувати');
  click('+ Колонка'); change('Назва колонки', 'Незавершена'); change('Код у CSV', 'pending_column');
  click('+ Колонка'); expect(screen.getByLabelText('Назва колонки').value).toBe('Незавершена'); click('Скасувати');
  expect(current).toBe(dirty); expect(hashJsonData(current)).toBe(hash); expect(updates).toBe(count);
});

it('normal mapped-column creation is one change and matches the server CSV with independent blank EN and exact neighbors', () => {
  const initial = fixture(); const view = render(<Editor initial={initial} />);
  click('+ Колонка'); change('Назва колонки', 'Тестовий колір'); change('Код у CSV', 'test_export_color');
  expect(screen.getByLabelText('Позиція нової колонки').selectedOptions[0].textContent).toContain('після test_export_note');
  mapping(); expect(updates).toBe(0);
  const submit = screen.getByRole('button', { name: 'Додати колонку' }); fireEvent.click(submit); fireEvent.click(submit);
  expect(updates).toBe(1); expect(current.groups[0].columns.slice(-2)).toEqual(['test_export_note', 'test_export_color']);
  expect(current.groups[0].rows[1].cells.test_export_color).toEqual({ op: 'literal', value: '' });
  expect(current.groups.slice(1)).toEqual(initial.groups.slice(1));
  expect(current.tables.color4).toEqual(initial.tables.color4);
  const stored = JSON.parse(JSON.stringify(current)); view.unmount(); render(<Editor initial={stored} />);
  open('test_export_color'); expect(columnName().value).toBe('Тестовий колір'); click('Скасувати');
  for (const [color, text] of [[1, 'Світлий'], [4, 'Комбінований']]) {
    const p = product('BR', { color }); const result = evaluateBatch(compileDefinition(current), [p]); expect(result.status).toBe('ready');
    const csv = parsePreviewCsv(result.artifacts[0].csvContent); const original = parsePreviewCsv(evaluateBatch(compileDefinition(initial), [p]).artifacts[0].csvContent);
    expect(csv.headers).toEqual(current.groups[0].columns); expect(csv.rows.map((row) => row.length)).toEqual([csv.headers.length, csv.headers.length]);
    expect(csv.rows.map((row) => row.at(-1))).toEqual([text, '']); expect(csv.rows.map((row) => row.slice(0, -1))).toEqual(original.rows);
    expect(csv.rows[0][csv.headers.indexOf('test_export_note')]).toBe('ПЕРЕВІРКА');
  }
});

it('creates a local mapping without a table ID; typed blanks, whitespace and zero remain exact', () => {
  render(<Editor />); click('+ Колонка'); change('Код у CSV', 'local_color');
  change('Звідки брати значення', 'source'); change('Характеристика', 'BR.color'); change('Як записувати значення', 'mapping');
  click('Додати текст: Значення №1 — назву не підтверджено'); change('Значення у CSV: Значення №1 — назву не підтверджено', '  світлий  '); click('Додати текст: Значення №2 — назву не підтверджено'); change('Значення у CSV: Значення №2 — назву не підтверджено', '0'); click('Додати колонку');
  const rule = current.groups[0].rows[0].cells.local_color; expect(current.tables[rule.table]).toEqual({ 1: '  світлий  ', 2: '0' });
  expect(evaluateBatch(compileDefinition(current), [product('BR')]).status).toBe('ready');
  open('local_color'); change('Значення у CSV: Значення №1 — назву не підтверджено', ''); apply(); expect(current.tables[current.groups[0].rows[0].cells.local_color.table]['1']).toBe('');
});

it('existing empty column uses one complete transaction; later mapping edit affects only that column', () => {
  const initial = fixture(true); render(<Editor initial={initial} />);
  open('test_export_color'); change('Назва колонки', 'Тестовий колір'); mapping(); expect(current).toBe(initial); apply();
  const before = current; open('test_export_color'); change('Значення у CSV: Значення №1 — назву не підтверджено', 'Лише тест'); expect(current).toBe(before); apply();
  const node = current.groups[0].rows[0].cells.test_export_color;
  expect(node.table).not.toBe('color4'); expect(current.tables[node.table]['1']).toBe('Лише тест'); expect(current.tables.color4).toEqual(initial.tables.color4); expect(current.bindings).toEqual(initial.bindings);
  open('test_export_color'); change('Звідки брати значення', 'literal'); apply();
  expect(current.groups[0].rows[0].cells.test_export_color).toEqual({ op: 'literal', value: '' }); expect(evaluateBatch(compileDefinition(current), [product('BR')]).status).toBe('ready');
});

it('both row rules survive header duplicate, rename, numbered move and explicit delete; stale inspector callbacks cannot write', () => {
  const initial = fixture(); render(<Editor initial={initial} />); open('price');
  const old = columnName(); const late = old[Object.keys(old).find((key) => key.startsWith('__reactProps'))].onChange;
  click('+ Колонка'); change('Назва колонки', 'Тестовий колір'); change('Код у CSV', 'test_export_color');
  change('Позиція нової колонки', initial.groups[0].columns[initial.groups[0].columns.indexOf('price') + 1]); mapping();
  fireEvent.click(screen.getByLabelText('Налаштувати інший рядок окремо')); click('EN'); change('Текст у файлі', 'English only'); click('Додати колонку');
  act(() => late({ target: { value: 'Запізнілий callback' } }));
  const originalRules = current.groups[0].rows.map((row) => row.cells.test_export_color);
  menu('test_export_color', 'Перейменувати…'); change('Код у CSV', 'renamed_color'); apply();
  menu('renamed_color', 'Перемістити…'); change('Перемістити на позицію', '0'); apply();
  expect(current.groups[0].columns[0]).toBe('renamed_color');
  menu('renamed_color', 'Дублювати'); change('Код у CSV', 'copied_color'); apply();
  expect(current.groups[0].rows[1].cells.copied_color).toEqual(originalRules[1]);
  expect(current.groups[0].rows[0].cells.copied_color.table).not.toBe(current.groups[0].rows[0].cells.renamed_color.table);
  menu('copied_color', 'Видалити…'); expect(screen.getByText(/обидва її правила/)).toBeTruthy(); click('Видалити колонку');
  expect(current.groups[0].columns).not.toContain('copied_color'); expect(current.groups[0].rows.every((row) => !Object.hasOwn(row.cells, 'copied_color'))).toBe(true);
  for (const key of ['price', 'name', 'test_export_note']) {
    expect(current.groups[0].columnLabels[key]).toBe(initial.groups[0].columnLabels[key]);
    for (let ri = 0; ri < 2; ri++) expect(current.groups[0].rows[ri].cells[key]).toEqual(initial.groups[0].rows[ri].cells[key]);
  }
});

it('common source output preserves genuine numeric/string zero, absent, null and significant whitespace through the pure server evaluator', () => {
  const sourceRegistry = { ...registry, references: { ...registry.references, questions: [{ category_code: 'BR', key: 'test_zero', label: 'Тестовий нуль', include_in_sku: 0 }] } };
  render(<Editor sourceRegistry={sourceRegistry} />); click('+ Колонка'); change('Код у CSV', 'raw_zero'); change('Звідки брати значення', 'source'); change('Характеристика', 'BR.test_zero'); change('Як записувати значення', 'raw'); click('Додати колонку');
  for (const [value, expected] of [[0, '0'], ['0', '0'], [null, ''], ['', ''], [undefined, ''], [' x ', ' x ']]) {
    const result = evaluateBatch(compileDefinition(current), [product('BR', { test_zero: value })]); expect(result.status).toBe('ready');
    const csv = parsePreviewCsv(result.artifacts[0].csvContent); expect(csv.rows[0][csv.headers.indexOf('raw_zero')]).toBe(expected);
  }
});

it('complex mapping keeps frozen guards and readiness, with no mutation before local apply', () => {
  const initial = fixture(); render(<Editor initial={initial} />); open('kolir');
  expect(screen.queryByLabelText('Звідки брати значення')).toBeNull(); change('Значення у CSV: Значення №1 — назву не підтверджено', 'Локальний колір'); expect(current).toBe(initial); apply();
  expect(current.questionContracts).toEqual(initial.questionContracts); expect(current.tables.color4).toEqual(initial.tables.color4); expect(current.groups.slice(1)).toEqual(initial.groups.slice(1));
  expect(evaluateBatch(compileDefinition(current), [product('BR')]).status).toBe('ready');
});

it('left and right header actions use the exact insertion anchor; required columns and locked rules are distinct', () => {
  const initial = fixture(); render(<Editor initial={initial} />);
  const name = screen.getByRole('button', { name: 'Налаштувати колонку name' }).closest('th'); expect(name.textContent).toContain('Обов’язкова колонка'); expect(name.textContent).not.toContain('Захищене правило');
  expect(screen.getByRole('columnheader', { name: /sku/ }).textContent).toContain('Захищене правило');
  menu('price', 'Додати ліворуч'); expect(screen.getByLabelText('Позиція нової колонки').value).toBe('price'); click('Скасувати');
  menu('price', 'Додати праворуч'); expect(screen.getByLabelText('Позиція нової колонки').value).toBe(initial.groups[0].columns[initial.groups[0].columns.indexOf('price') + 1]); click('Скасувати');
  click('Дії колонки name'); expect(screen.getByRole('menuitem', { name: 'Видалити…' }).disabled).toBe(true); expect(screen.getByRole('menuitem', { name: 'Перейменувати…' }).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' }); open('price'); expect(screen.getByText(/Правило заповнення можна редагувати/)).toBeTruthy(); click('Скасувати');
  open('sku'); expect(screen.getByText('Захищене ідентифікаційне поле: sku.')).toBeTruthy(); expect(current).toBe(initial);
});

it('invalid/duplicate codes and an unchosen output mode keep creation unapplied with labelled errors', () => {
  render(<Editor />); const initial = current; click('+ Колонка');
  for (const code of ['Price!', 'price']) {
    change('Код у CSV', code); click('Додати колонку'); const input = screen.getByLabelText('Код у CSV');
    expect(input.getAttribute('aria-invalid')).toBe('true'); expect(document.getElementById(input.getAttribute('aria-describedby')).textContent).toBeTruthy(); expect(current).toBe(initial);
  }
  change('Код у CSV', 'raw_color'); change('Звідки брати значення', 'source'); change('Характеристика', 'BR.color'); click('Додати колонку');
  expect(screen.getByRole('alert').textContent).toContain('Оберіть, як записувати'); expect(current).toBe(initial);
  fireEvent.click(screen.getByText('Технічні налаштування')); click('Внутрішній ID варіанта'); click('Додати колонку'); expect(current.groups[0].rows[0].cells.raw_color.op).toBe('text');
});

it('stored local source identities remain readable and editable through approved registry descriptors without rewriting them on open', () => {
  const initial = fixture(true); initial.sources.saved_color_alias = structuredClone(initial.sources['BR.color']);
  initial.groups[0].rows[0].cells.test_export_color = { op: 'text', input: { op: 'source', id: 'saved_color_alias' }, trim: false, format: 'scalar-v1', onAbsent: 'empty' };
  render(<Editor initial={initial} />); open('test_export_color');
  expect(screen.getByLabelText('Характеристика').value).toBe('Браслети → Колір'); expect(current).toBe(initial);
  change('Як записувати значення', 'mapping'); click('Додати текст: Значення №1 — назву не підтверджено'); change('Значення у CSV: Значення №1 — назву не підтверджено', '  локальний  '); apply();
  expect(current.sources).toEqual(initial.sources); expect(current.groups[0].rows[0].cells.test_export_color.input.input.id).toBe('saved_color_alias');
  const csv = parsePreviewCsv(evaluateBatch(compileDefinition(current), [product('BR')]).artifacts[0].csvContent);
  expect(csv.rows[0][csv.headers.indexOf('test_export_color')]).toBe('  локальний  ');
});

it('pending changes guard category/cell/create transitions and separate same-code state in another category', () => {
  let initial = fixture(true); initial = columnChange(initial, 1, 'add', null, 'test_export_color'); render(<Editor initial={initial} />);
  open('test_export_color'); change('Звідки брати значення', 'source'); change('Характеристика', 'BR.color'); open('price');
  expect(screen.getByRole('dialog', { name: 'Незастосоване заповнення' })).toBeTruthy(); click('Залишитися');
  expect(screen.getByLabelText('Характеристика').value).toBe('Браслети → Колір'); click('+ Колонка'); click('Залишитися');
  fireEvent.click(screen.getByRole('tab', { name: 'Намиста' })); click('Відкинути заповнення й перейти');
  open('test_export_color', 'Основний', 'NM'); change('Назва колонки', 'Лише NM'); apply();
  expect(current.groups[1].columnLabels.test_export_color).toBe('Лише NM'); expect(current.groups[0]).toEqual(initial.groups[0]);
});

it('readonly does not write; narrow dialogs use shared focus containment and restore the create trigger', () => {
  window.innerWidth = 390;
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}]);
  const initial = fixture(true); const onChange = vi.fn(); const view = render(<DefinitionEditor definition={initial} registry={registry} onChange={onChange} readOnly />);
  expect(screen.queryByRole('button', { name: '+ Колонка' })).toBeNull(); open('test_export_color'); expect(screen.getByLabelText('Як формується значення').disabled).toBe(true);
  click('Закрити налаштування'); view.rerender(<DefinitionEditor definition={initial} registry={registry} onChange={onChange} />);
  const plus = screen.getByRole('button', { name: '+ Колонка' }); plus.focus(); fireEvent.click(plus);
  const first = screen.getByLabelText('Назва колонки'); expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); expect(document.activeElement.textContent).toBe('Скасувати');
  fireEvent.keyDown(document.activeElement, { key: 'Escape' }); expect(document.activeElement).toBe(plus); expect(onChange).not.toHaveBeenCalled();
});
