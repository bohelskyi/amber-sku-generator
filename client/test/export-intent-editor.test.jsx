import { useEffect, useState } from 'react';
import { createRequire } from 'node:module';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DefinitionEditor } from '../src/components/export-templates/DefinitionEditor';
import { columnIntent, expressionIntent, intentNames } from '../src/lib/export-template-intent';
const require = createRequire(import.meta.url);
const { homeDefinition, officeEvidence } = require('../../server/test/fixtures/export-source-support');
const { upgradeSourceSupport, sourceSupportUpdate } = require('../../server/src/services/export-templates/source-support');
const { compileDefinition, hashJsonData } = require('../../server/src/services/export-templates/definition');
const { evaluateProduct } = require('../../server/src/services/export-templates/evaluate');
const { product } = require('../../server/test/fixtures/magento-v1/contract');
const literal = (value) => ({ op: 'literal', value });
const registry = { productFields: ['weight', 'full_sku'], references: { questions: [
  { category_code: 'BR', key: 'color', label: 'Колір', include_in_sku: 1, value_ids: ['1', '2'] },
  { category_code: 'BR', key: 'note', label: 'Примітка', include_in_sku: 0 },
], schemas: [{ category_code: 'BR', questions: [{ key: 'color', value_ids: ['1', '2'] }] }] } };
const loadSource = vi.fn(async () => ({ data: { current: [{ label: 'Колір', options: [{ value_id: '1', label: 'Світлий', sku_code: 'SECRET_SKU_CODE' }, { value_id: '2', label: 'Темний' }] }], historical: [{ version: 99, options: [{ value_id: '1', label: 'Історична назва' }] }] } }));
const fixture = () => upgradeSourceSupport(homeDefinition(), officeEvidence());
let current, pending;
function Editor({ initial = fixture(), diagnostics = [], focusField }) {
  const [definition, setDefinition] = useState(initial);
  useEffect(() => { current = definition; }, [definition]);
  return <DefinitionEditor definition={definition} onChange={setDefinition} registry={registry} loadSource={loadSource} diagnostics={diagnostics} focusField={focusField} onPendingChange={(value) => { pending = value; }} />;
}
const click = (name, scope = screen) => fireEvent.click(scope.getByRole('button', { name, exact: true }));
const change = (name, value, scope = screen) => fireEvent.change(scope.getByLabelText(name, { exact: true }), { target: { value } });
const open = (column = 'meta_title') => click(`BR / ${column} / Основний`);
const normal = () => document.querySelector('.et-intent-editor');
beforeEach(() => { window.innerWidth = 1600; pending = false; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('six read-only intent lenses keep accepted definitions and unknown interpolation byte/hash safe', () => {
  const d = fixture(); const before = JSON.stringify(d); const hash = hashJsonData(d);
  const path = ['groups', 0, 'rows', 0, 'cells', 'meta_title'];
  expect(Object.values(intentNames)).toHaveLength(6);
  expect(columnIntent(d, path)).toBe('literal');
  expect(columnIntent(d, ['groups', 0, 'rows', 0, 'cells', 'kolir'])).toBe('characteristic');
  expect(columnIntent(d, ['groups', 4, 'rows', 0, 'cells', 'meta_description'])).toBe('condition');
  expect(columnIntent(d, ['groups', 2, 'rows', 0, 'cells', 'rozmir_iuvelirnoho_vyrobu'])).toBe('fallback');
  expect(expressionIntent(d, { op: 'interpolate', template: '{unknown}', slots: { unknown: { op: 'future', evidence: [0, null] } } })).toBe('complex');
  expect(JSON.stringify(d)).toBe(before); expect(hashJsonData(d)).toBe(hash);
});

it('literal mode shows only a value, keeps exact whitespace and cancels only its transaction', () => {
  const d = fixture(); render(<Editor initial={d} />); open();
  expect(screen.getByLabelText('Як формується значення').selectedOptions[0].textContent).toBe('Постійне значення');
  expect(normal().querySelectorAll('textarea')).toHaveLength(1);
  expect(within(normal()).queryByLabelText('Характеристика')).toBeNull(); expect(normal().querySelector('table,pre,details')).toBeNull();
  change('Текст у файлі', '  saved locally\n'); expect(current).toBe(d); expect(pending).toBe(true); click('Застосувати до чернетки');
  const dirty = current; open(); change('Текст у файлі', 'discard'); click('Скасувати');
  expect(current).toBe(dirty); expect(current.groups[0].rows[0].cells.meta_title.value).toBe('  saved locally\n');
});

it('typed literal controls retain numeric zero, string zero, null and empty as distinct values', () => {
  const d = fixture(); d.groups[0].rows[0].cells.meta_title = literal(0); render(<Editor initial={d} />); open();
  expect(screen.getByLabelText('Тип: Значення').value).toBe('number');
  change('Тип: Значення', 'null'); click('Застосувати до чернетки'); expect(current.groups[0].rows[0].cells.meta_title).toEqual(literal(null));
  open(); change('Тип: Значення', 'string'); change('Значення', '0'); click('Застосувати до чернетки');
  expect(current.groups[0].rows[0].cells.meta_title).toEqual(literal('0'));
  open(); change('Текст у файлі', ''); click('Застосувати до чернетки'); expect(current.groups[0].rows[0].cells.meta_title).toEqual(literal(''));
});

it('semantic mode contains source and frozen/custom outputs, with no inline technical evidence', async () => {
  const d = fixture(); render(<Editor initial={d} />); open('test_export_color');
  await screen.findByLabelText('Значення у CSV: Світлий');
  expect(screen.getByLabelText('Як записувати значення').selectedOptions[0].textContent).toBe('Задати свої значення');
  expect(screen.getByText('Джерело підтверджено')).toBeTruthy();
  expect(normal().textContent).not.toMatch(/color4|value_id|sku_code|SECRET_SKU_CODE|historical|semanticValues|Де застосувати|Додати відповідність/);
  expect(normal().querySelector('pre,details')).toBeNull();
  change('Як записувати значення', 'labels'); change('Значення у CSV: Світлий', 'Світлий UX2'); click('Застосувати до чернетки');
  expect(evaluateProduct(compileDefinition(current), product('BR', { color: 1 })).base.test_export_color).toBe('Світлий UX2');
  expect(current.sourceSupport).toEqual(d.sourceSupport); expect(sourceSupportUpdate(current).status).toBe('current');
});

it('free-text source has as-is output without semantic mapping controls', () => {
  const d = fixture(); d.sources['BR.note'] = { kind: 'information', category: 'BR', key: 'note', type: 'scalar' };
  d.groups[0].rows[0].cells.test_export_note = { op: 'text', input: { op: 'source', id: 'BR.note' }, trim: false, format: 'scalar-v1', onAbsent: 'empty' };
  render(<Editor initial={d} />); open('test_export_note');
  expect(screen.getByLabelText('Як записувати значення').selectedOptions[0].textContent).toBe('Використати значення як є');
  expect(within(normal()).queryByRole('option', { name: 'Задати свої значення' })).toBeNull();
  expect(normal().querySelector('table,pre,details')).toBeNull(); click('Застосувати до чернетки'); expect(current).toBe(d);
});

it('interpolation exposes readable text/tokens and keeps slot IDs and evidence out of the normal surface', async () => {
  const d = fixture(); d.groups[0].rows[0].cells.meta_title = { op: 'interpolate', template: 'Бурштин {private_slot}', slots: { private_slot: d.groups[0].rows[0].cells.test_export_color } };
  render(<Editor initial={d} />); open();
  expect(screen.getByLabelText('Текст у файлі').value).toBe('Бурштин {Колір}');
  expect(normal().textContent).not.toMatch(/private_slot|color4|semanticKey|sourceSupport/); expect(normal().querySelector('pre,details')).toBeNull();
  expect(screen.getByRole('button', { name: '+ Додати характеристику' })).toBeTruthy();
  change('Текст у файлі', 'Купити {Колір}'); click('Застосувати до чернетки');
  expect(evaluateProduct(compileDefinition(current), product('BR', { color: 1 })).base.meta_title).toBe('Купити Світлий');
});

it('ordered fallback supports add, move, remove and keeps its existing absence/lazy-error semantics', () => {
  const d = fixture(); const error = { op: 'error', code: 'TEST_LAZY', field: 'meta_title', message: literal('late error') };
  d.groups[0].rows[0].cells.meta_title = { op: 'firstPresent', policy: 'answer-v1', items: [literal('first'), error] };
  render(<Editor initial={d} />); open();
  expect(screen.getByRole('region', { name: 'Перше доступне значення' })).toBeTruthy(); expect(normal().querySelector('pre')).toBeNull();
  click('Додати постійне значення'); const list = screen.getByRole('region', { name: 'Перше доступне значення' });
  const entries = within(list).getAllByRole('listitem'); change('Значення', 'priority', within(entries[2]));
  click('Вище', within(entries[2])); click('Вище', within(within(list).getAllByRole('listitem')[1]));
  click('Вилучити значення 2'); click('Застосувати до чернетки');
  expect(current.groups[0].rows[0].cells.meta_title.items).toEqual([literal('priority'), error]);
  const output = evaluateProduct(compileDefinition(current), product('BR')); expect(output.base.meta_title).toBe('priority'); expect(output.errors).toEqual([]);
  expect(current.groups[0].rows[1]).toEqual(d.groups[0].rows[1]);
});

it('custom structures open summary and separate Advanced; no-op close/cancel never changes hash', () => {
  const d = fixture(); d.groups[0].rows[0].cells.meta_title = { op: 'future', preserved: { fallback: [0, null, '', '  '] } };
  const hash = hashJsonData(d); render(<Editor initial={d} />); open();
  expect(screen.getByText('Ця колонка використовує складне правило.')).toBeTruthy();
  expect(normal().querySelector('textarea,pre')).toBeNull(); click('Відкрити розширені правила');
  expect(screen.getByRole('dialog', { name: 'Розширені правила' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Як формується значення' })).toBeNull();
  click('← Звичайні налаштування'); expect(screen.queryByRole('dialog', { name: 'Розширені правила' })).toBeNull(); click('Застосувати до чернетки');
  expect(current).toBe(d); expect(hashJsonData(current)).toBe(hash);
});

it('technical evidence and raw-ID output exist only after explicit opening; closing preserves Main/EN and focus', async () => {
  window.innerWidth = 390; vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}]);
  const d = fixture(); render(<Editor initial={d} />); open('test_export_color');
  await screen.findByLabelText('Значення у CSV: Світлий');
  expect(screen.queryByRole('button', { name: 'Внутрішній ID варіанта' })).toBeNull();
  const trigger = screen.getByRole('button', { name: 'Технічні подробиці', exact: true }); trigger.focus(); fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Технічні подробиці' });
  expect(screen.queryByRole('dialog', { name: 'Налаштування колонки' })).toBeNull();
  await waitFor(() => expect(dialog.textContent).toContain('SECRET_SKU_CODE'));
  fireEvent.click(within(dialog).getByText('Технічні налаштування')); click('Внутрішній ID варіанта');
  click('← Звичайні налаштування');
  expect(screen.queryByRole('dialog', { name: 'Технічні подробиці' })).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Налаштування колонки' })).toBeTruthy();
  expect(current).toBe(d); expect(screen.queryByText(/SECRET_SKU_CODE/)).toBeNull();
  // The standard dialog helper restores focus to a connected normal control.
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  expect(document.activeElement).toBe(trigger);
  click('Застосувати до чернетки');
  expect(evaluateProduct(compileDefinition(current), product('BR', { color: 2 })).base.test_export_color).toBe('2');
  expect(current.groups[0].rows[1]).toEqual(d.groups[0].rows[1]);
});

it('issue navigation selects the exact normal row/source and retains machine codes only in Technical', () => {
  const d = fixture(); const issue = { sourceId: 'BR.color', code: 'SOURCE_REFERENCE_UNRESOLVED', message: 'Unverified semantic value IDs', unresolvedValueIds: ['29'] };
  render(<Editor initial={d} diagnostics={[issue]} focusField={{ groupIndex: 0, rowIndex: 0, column: 'test_export_color', sourceId: 'BR.color' }} />);
  expect(screen.getByText('Джерело потрібно перевірити перед публікацією.')).toBeTruthy();
  expect(normal().textContent).not.toMatch(/SOURCE_REFERENCE|Unverified|unresolvedValueIds/);
  click('Технічні подробиці'); const dialog = screen.getByRole('dialog', { name: 'Технічні подробиці' });
  expect(dialog.textContent).toContain('SOURCE_REFERENCE_UNRESOLVED'); expect(dialog.textContent).toContain('Unverified semantic value IDs');
  click('← Звичайні налаштування'); expect(screen.getByLabelText('Характеристика').value).toBe('BR.color'); click('Скасувати'); expect(current).toBe(d);
});

it('normal, Technical and Advanced share one pending transaction and reject callbacks from a suspended surface', () => {
  render(<Editor />); open(); change('Текст у файлі', 'prior dirty edit'); click('Застосувати до чернетки');
  const dirty = current; open(); change('Текст у файлі', 'normal pending');
  const input = screen.getByLabelText('Текст у файлі');
  const late = input[Object.keys(input).find((key) => key.startsWith('__reactProps'))].onChange;
  click('Технічні подробиці'); const technical = within(screen.getByRole('dialog', { name: 'Технічні подробиці' }));
  act(() => late({ target: { value: 'stale callback' } }));
  expect(technical.getByLabelText('Текст у файлі').value).toBe('normal pending');
  change('Текст у файлі', 'technical pending', technical); click('← Звичайні налаштування');
  expect(screen.getByLabelText('Текст у файлі').value).toBe('technical pending');
  click('Розширені правила цієї колонки'); const advanced = within(screen.getByRole('dialog', { name: 'Розширені правила' }));
  change('Значення', 'advanced pending', advanced); click('← Звичайні налаштування');
  expect(screen.getByLabelText('Текст у файлі').value).toBe('advanced pending');
  expect(current).toBe(dirty); click('Скасувати'); expect(current).toBe(dirty);
});

it('an unfinished semantic output can explicitly choose raw ID in Technical without a temporary mapping', async () => {
  const d = fixture(); render(<Editor initial={d} />); open('test_export_note');
  change('Як формується значення', 'characteristic'); change('Характеристика', 'BR.color');
  expect(screen.getByLabelText('Як записувати значення').value).toBe('');
  expect(screen.queryByRole('button', { name: 'Внутрішній ID варіанта' })).toBeNull();
  click('Технічні подробиці'); fireEvent.click(within(screen.getByRole('dialog', { name: 'Технічні подробиці' })).getByText('Технічні налаштування'));
  click('Внутрішній ID варіанта'); click('← Звичайні налаштування'); click('Застосувати до чернетки');
  expect(evaluateProduct(compileDefinition(current), product('BR', { color: 2 })).base.test_export_note).toBe('2');
  expect(current.tables).toEqual(d.tables); expect(current.sourceSupport).toEqual(d.sourceSupport);
});
