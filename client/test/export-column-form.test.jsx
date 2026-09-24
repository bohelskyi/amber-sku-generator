import { useEffect, useState } from 'react';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
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
const registry = { productFields: ['weight'], references: { questions: [], schemas: [
  { category_code: 'BR', version: 1, questions: [{ key: 'color', value_ids: ['1', '2', '3', '4'] }] },
] } };
function fixture(existing = false) {
  let d = upgradeColumns(materializeMagentoV1(catalog()));
  d = columnChange(d, 0, 'add', null, 'test_export_note');
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
afterEach(() => { cleanup(); updates = 0; });
const click = (name) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
const change = (name, value) => fireEvent.change(screen.getByLabelText(name, { exact: true }), { target: { value } });
const actions = () => fireEvent.click(screen.getByText('Код, порядок та інші дії'));
function mapping() {
  change('Чим заповнювати', 'source'); change('Характеристика', 'BR.color');
  expect(screen.getByLabelText('Як записувати').value).toBe('');
  change('Як записувати', 'mapping');
  expect(screen.getByLabelText('Таблиця відповідностей').value).toBe('');
  change('Таблиця відповідностей', 'color4');
  const rows = within(screen.getByRole('table', { name: 'Відповідності для колонки' })).getAllByRole('row').slice(1);
  expect(rows.map((row) => row.textContent)).toEqual(['1Світлий', '2Темний', '3Пейзажний', '4Комбінований']);
}

it('toolbar + expresses create intent with settings closed, open, and closed again without changing the draft', () => {
  const initial = fixture(true); updates = 0;
  render(<Editor initial={initial} />);
  for (const state of ['closed', 'open', 'closed-again']) {
    if (state !== 'closed') click('Налаштувати колонку price');
    if (state === 'closed-again') click('Закрити налаштування');
    click('+ Колонка');
    const dialog = screen.getByRole('dialog', { name: 'Нова колонка' });
    expect(within(dialog).getByLabelText('Назва для редактора').value).toBe('');
    expect(within(dialog).getByLabelText('Код колонки CSV').value).toBe('');
    expect(within(dialog).queryByRole('button', { name: 'Видалити колонку' })).toBeNull();
    click('Скасувати');
    expect(current).toBe(initial); expect(updates).toBe(0);
  }
});

it('cancel/repeated + preserve partial creation, canonical definition and pre-existing local edits', () => {
  const initial = fixture(); render(<Editor initial={initial} />);
  click('Налаштувати колонку test_export_note'); change('Назва для редактора', 'Локальна примітка');
  const dirty = current; const hash = hashJsonData(dirty); const count = updates;
  click('+ Колонка'); change('Назва для редактора', 'Незавершена'); change('Код колонки CSV', 'pending_column');
  click('+ Колонка'); expect(screen.getByLabelText('Назва для редактора').value).toBe('Незавершена');
  expect(current).toBe(dirty); expect(updates).toBe(count);
  click('Скасувати'); expect(current).toBe(dirty); expect(hashJsonData(current)).toBe(hash);
});

it('creates exactly one complete mapped base column after the note and survives serialized editor remount with exact server CSV alignment', () => {
  const initial = fixture(); updates = 0; const view = render(<Editor initial={initial} />);
  click('+ Колонка'); change('Назва для редактора', 'Тестовий колір'); change('Код колонки CSV', 'test_export_color');
  expect(screen.getByLabelText('Позиція нової колонки').selectedOptions[0].textContent).toContain('після test_export_note');
  mapping(); expect(updates).toBe(0);
  const submit = screen.getByRole('button', { name: 'Додати колонку', exact: true });
  fireEvent.click(submit); fireEvent.click(submit);
  expect(updates).toBe(1); expect(current.groups[0].columns.slice(-2)).toEqual(['test_export_note', 'test_export_color']);
  click('Закрити налаштування'); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Налаштувати колонку test_export_color' }));
  expect(current.groups[0].columnLabels.test_export_color).toBe('Тестовий колір');
  expect(current.groups[0].rows[0].cells.test_export_color).toEqual({ op: 'lookup', input: { op: 'semanticKey', input: { op: 'source', id: 'BR.color' } }, table: 'color4', otherwise: { op: 'literal', value: '' } });
  expect(current.groups[0].rows[1].cells.test_export_color).toEqual({ op: 'literal', value: '' });
  expect(current.groups.slice(1)).toEqual(initial.groups.slice(1)); expect(current.tables).toEqual(initial.tables);
  const stored = JSON.parse(JSON.stringify(current)); view.unmount(); render(<Editor initial={stored} />);
  click('Налаштувати колонку test_export_color');
  expect(screen.getByLabelText('Назва для редактора').value).toBe('Тестовий колір');
  expect(screen.getByLabelText('Характеристика').value).toBe('BR.color'); expect(screen.getByLabelText('Таблиця відповідностей').value).toBe('color4');
  for (const [color, text] of [[1, 'Світлий'], [4, 'Комбінований']]) {
    const p = product('BR', { color });
    const result = evaluateBatch(compileDefinition(current), [p]); expect(result.status).toBe('ready');
    const csv = parsePreviewCsv(result.artifacts[0].csvContent);
    const original = parsePreviewCsv(evaluateBatch(compileDefinition(initial), [p]).artifacts[0].csvContent);
    expect(csv.headers).toEqual(current.groups[0].columns);
    expect(csv.rows.map((row) => row.length)).toEqual([csv.headers.length, csv.headers.length]);
    expect(csv.rows.map((row) => row.at(-1))).toEqual([text, '']);
    expect(csv.rows.map((row) => row.slice(0, -1))).toEqual(original.rows);
    expect(csv.rows[0][csv.headers.indexOf('test_export_note')]).toBe('ПЕРЕВІРКА');
  }
});

it('configures an existing empty column in place; local output edits detach color4 without changing its consumers', () => {
  const initial = fixture(true); render(<Editor initial={initial} />);
  click('Налаштувати колонку test_export_color'); change('Назва для редактора', 'Тестовий колір'); mapping(); click('Застосувати заповнення');
  expect(current.groups[0].columns).toEqual(initial.groups[0].columns);
  expect(current.groups[0].rows[1].cells.test_export_color.value).toBe('');
  change('Текст для ID 1', 'Лише тест');
  const node = current.groups[0].rows[0].cells.test_export_color;
  expect(node.table).not.toBe('color4'); expect(current.tables[node.table]['1']).toBe('Лише тест');
  expect(current.tables.color4).toEqual(initial.tables.color4);
  expect(current.bindings).toEqual(initial.bindings);
  change('Чим заповнювати', 'literal'); click('Застосувати заповнення');
  expect(current.groups[0].rows[0].cells.test_export_color).toEqual({ op: 'literal', value: '' });
  expect(screen.queryByRole('button', { name: 'Застосувати заповнення' })).toBeNull();
  expect(evaluateBatch(compileDefinition(current), [product('BR')]).status).toBe('ready');
});

it('price -> new beside price -> rename/move/duplicate/delete keeps neighboring identity and ignores detached input events', () => {
  const initial = fixture(); render(<Editor initial={initial} />);
  click('Налаштувати колонку price');
  const oldLabel = screen.getByLabelText('Назва для редактора');
  // Simulate a queued callback, not just dispatch into a disconnected DOM node
  // (React correctly ignores the latter before reaching the parent's fence).
  const lateChange = oldLabel[Object.keys(oldLabel).find((key) => key.startsWith('__reactProps'))].onChange;
  click('+ Колонка'); change('Назва для редактора', 'Тестовий колір'); change('Код колонки CSV', 'test_export_color');
  change('Позиція нової колонки', initial.groups[0].columns[initial.groups[0].columns.indexOf('price') + 1]);
  mapping(); click('Додати колонку'); fireEvent.change(oldLabel, { target: { value: 'Запізніла подія' } }); fireEvent.blur(oldLabel);
  act(() => lateChange({ target: { value: 'Запізнілий callback' } }));
  expect(current.groups[0].columns[current.groups[0].columns.indexOf('price') + 1]).toBe('test_export_color');
  actions(); change('Код колонки CSV', 'renamed_color'); click('Змінити код колонки');
  actions(); change('Перемістити на позицію', '0'); change('Код нової колонки', 'copied_color'); click('Дублювати');
  actions(); click('Видалити колонку');
  click('Закрити налаштування'); click('Налаштувати колонку renamed_color');
  expect(screen.getByLabelText('Назва для редактора').value).toBe('Тестовий колір');
  for (const key of ['price', 'name', 'test_export_note']) {
    expect(current.groups[0].columnLabels[key]).toBe(initial.groups[0].columnLabels[key]);
    for (let ri = 0; ri < 2; ri++) expect(current.groups[0].rows[ri].cells[key]).toEqual(initial.groups[0].rows[ri].cells[key]);
  }
});

it('common-source output preserves genuine zero versus absent values using the server evaluator', () => {
  // A separate optional answer: removing the real required product weight must
  // still fail its original readiness checks, independently of this new column.
  const sourceRegistry = { ...registry, references: { ...registry.references, questions: [{ category_code: 'BR', key: 'test_zero', label: 'Тестовий нуль', include_in_sku: 0 }] } };
  render(<Editor sourceRegistry={sourceRegistry} />); click('+ Колонка'); change('Код колонки CSV', 'raw_zero'); change('Чим заповнювати', 'source');
  change('Характеристика', 'BR.test_zero'); change('Як записувати', 'raw'); click('Додати колонку');
  for (const [value, expected] of [[0, '0'], [null, ''], ['', ''], [undefined, '']]) {
    const result = evaluateBatch(compileDefinition(current), [product('BR', { test_zero: value })]);
    expect(result.status).toBe('ready');
    const csv = parsePreviewCsv(result.artifacts[0].csvContent); expect(csv.rows[0][csv.headers.indexOf('raw_zero')]).toBe(expected);
  }
});

it('complex conditions, fallbacks and readiness stay on the lossless editor when opening an existing rule', () => {
  const initial = fixture(); render(<Editor initial={initial} />); click('Налаштувати колонку kolir');
  expect(screen.queryByLabelText('Чим заповнювати')).toBeNull();
  expect(screen.getByText(/збережене складне правило/)).toBeTruthy();
  change('Текст для ID 1', 'Локальний колір');
  expect(current.questionContracts).toEqual(initial.questionContracts);
  expect(current.tables.color4).toEqual(initial.tables.color4);
  expect(current.groups.slice(1)).toEqual(initial.groups.slice(1));
  expect(evaluateBatch(compileDefinition(current), [product('BR')]).status).toBe('ready');
});

it('both insertion actions open the same fresh form with the exact anchor', () => {
  const initial = fixture(); render(<Editor initial={initial} />); click('Налаштувати колонку price'); actions();
  click('Додати колонку ліворуч'); expect(screen.getByLabelText('Позиція нової колонки').value).toBe('price'); click('Скасувати');
  actions(); click('Додати колонку праворуч');
  expect(screen.getByLabelText('Позиція нової колонки').value).toBe(initial.groups[0].columns[initial.groups[0].columns.indexOf('price') + 1]);
  expect(screen.getByLabelText('Назва для редактора').value).toBe(''); click('Скасувати'); expect(current).toBe(initial);
});

it('validates duplicate/invalid codes and requires an explicit source output choice', () => {
  render(<Editor />); const initial = current; click('+ Колонка');
  for (const code of ['Price!', 'price']) {
    change('Код колонки CSV', code); click('Додати колонку');
    const input = screen.getByLabelText('Код колонки CSV'); expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')).textContent).toBeTruthy(); expect(current).toBe(initial);
  }
  change('Код колонки CSV', 'raw_color'); change('Чим заповнювати', 'source'); change('Характеристика', 'BR.color'); click('Додати колонку');
  expect(screen.getByRole('alert').textContent).toContain('Оберіть, як записувати'); expect(current).toBe(initial);
  change('Як записувати', 'raw'); click('Додати колонку'); expect(current.groups[0].rows[0].cells.raw_color.op).toBe('text');
});

it('unfinished source/rename input requires explicit resolution, and same code in another category has independent state', () => {
  let initial = fixture(true); initial = columnChange(initial, 1, 'add', null, 'test_export_color');
  render(<Editor initial={initial} />); click('Налаштувати колонку test_export_color');
  change('Чим заповнювати', 'source'); change('Характеристика', 'BR.color'); click('Налаштувати колонку price');
  expect(screen.getByRole('dialog', { name: 'Незастосоване заповнення' })).toBeTruthy(); click('Залишитися');
  expect(screen.getByLabelText('Характеристика').value).toBe('BR.color'); click('Скасувати заповнення');
  actions(); change('Код колонки CSV', 'pending_rename'); click('+ Колонка'); click('Залишитися');
  expect(screen.getByLabelText('Код колонки CSV').value).toBe('pending_rename');
  change('Категорія', '1'); click('Відкинути заповнення й перейти');
  expect(screen.getByLabelText('Чим заповнювати').value).toBe('literal');
  change('Назва для редактора', 'Лише NM'); expect(current.groups[1].columnLabels.test_export_color).toBe('Лише NM');
  expect(current.groups[0]).toEqual(initial.groups[0]);
});

it('readonly and protected identity fields cannot mutate; creation focus loops and returns to +', () => {
  const initial = fixture(true); const onChange = vi.fn();
  const view = render(<DefinitionEditor definition={initial} registry={registry} onChange={onChange} readOnly />);
  expect(screen.queryByRole('button', { name: '+ Колонка' })).toBeNull(); click('Налаштувати колонку test_export_color');
  expect(screen.getByLabelText('Чим заповнювати').disabled).toBe(true);
  view.rerender(<DefinitionEditor definition={initial} registry={registry} onChange={onChange} />);
  click('Налаштувати колонку sku'); expect(screen.queryByLabelText('Чим заповнювати')).toBeNull();
  const plus = screen.getByRole('button', { name: '+ Колонка' }); plus.focus(); fireEvent.click(plus);
  const first = screen.getByLabelText('Назва для редактора'); expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); expect(document.activeElement.textContent).toBe('Скасувати');
  fireEvent.keyDown(document.activeElement, { key: 'Escape' }); expect(document.activeElement).toBe(plus); expect(onChange).not.toHaveBeenCalled();
});
