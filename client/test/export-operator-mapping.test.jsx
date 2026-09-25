import { useEffect, useState } from 'react';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DefinitionEditor } from '../src/components/export-templates/DefinitionEditor';
import { SourceDiagnostics } from '../src/components/export-templates/SourceDiagnostics';
import { questionField } from '../src/lib/export-template-attributes';
const require = createRequire(import.meta.url);
const { homeDefinition, officeEvidence, schema, stored } = require('../../server/test/fixtures/export-source-support');
const { upgradeSourceSupport, projectSupportProducts } = require('../../server/src/services/export-templates/source-support');
const { compileDefinition, hashJsonData } = require('../../server/src/services/export-templates/definition');
const { evaluateProduct } = require('../../server/src/services/export-templates/evaluate');
const { product } = require('../../server/test/fixtures/magento-v1/contract');
const { validateSourceReferences } = require('../../server/src/services/export-templates/source-references');

const names = ['Світлий', 'Темний', 'Пейзажний', 'Комбінований'];
const labels = () => ({ current: [{ label: 'Колір', include_in_sku: 1, options: names.map((label, i) => ({ value_id: String(i + 1), label, sku_code: `code-${i}` })) }], historical: [], truncated: false });
const registry = { productFields: ['weight'], references: {
  questions: [
    { category_code: 'BR', key: 'color', label: 'Колір', include_in_sku: 1, value_ids: ['1', '2', '3', '4'] },
    { category_code: 'BR', key: 'note', label: 'Примітка', include_in_sku: 0, input_type: 'text' },
  ], schemas: [{ category_code: 'BR', questions: [{ key: 'color', value_ids: ['1', '2', '3', '4'] }] }],
} };
let current, writes, read;
function Editor({ initial = upgradeSourceSupport(homeDefinition(), officeEvidence()) }) {
  const [definition, setDefinition] = useState(initial);
  useEffect(() => { current = definition; }, [definition]);
  return <DefinitionEditor definition={definition} registry={registry} loadSource={read} onChange={(next) => { writes++; setDefinition(next); }} />;
}
const click = (name) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
const change = (name, value) => fireEvent.change(screen.getByLabelText(name, { exact: true }), { target: { value } });
const open = (column) => click(`BR / ${column} / Основний`);
const apply = () => click('Застосувати до чернетки');
const csvInput = (name) => `Значення у CSV: ${name}`;
async function newColor(code = 'frozen_color') {
  click('+ Колонка'); change('Код у CSV', code); change('Звідки брати значення', 'source'); change('Характеристика', 'BR.color');
  await screen.findByRole('option', { name: 'Як названо в характеристиці' });
  // Wait for authorized display metadata, without choosing output automatically.
  await vi.waitFor(() => expect(screen.getByRole('option', { name: 'Як названо в характеристиці' }).disabled).toBe(false));
}
beforeEach(() => { window.innerWidth = 1600; writes = 0; read = vi.fn().mockResolvedValue({ data: labels() }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('explicit current-name choice previews and freezes a local mapping; later labels cannot change saved definitions or server output', async () => {
  const initial = upgradeSourceSupport(homeDefinition(), officeEvidence()); const view = render(<Editor initial={initial} />);
  const hash = hashJsonData(initial); await newColor();
  expect(current).toBe(initial); expect(screen.getByLabelText('Як записувати значення').value).toBe('');
  expect(screen.queryByRole('option', { name: /ID/ })).toBeNull();
  change('Як записувати значення', 'labels');
  for (const name of names) expect(screen.getByLabelText(csvInput(name)).value).toBe(name);
  expect(screen.getByText(/Подальші зміни назв у каталозі/)).toBeTruthy();
  expect(writes).toBe(0); expect(hashJsonData(current)).toBe(hash);
  click('Додати колонку'); expect(writes).toBe(1);
  const rule = current.groups[0].rows[0].cells.frozen_color;
  expect(rule.table).not.toBe('color4'); expect(current.tables[rule.table]).toEqual({ 1: names[0], 2: names[1], 3: names[2], 4: names[3] });
  expect(current.tables.color4).toEqual(initial.tables.color4);
  expect(current.sourceSupport).toEqual(initial.sourceSupport); expect(current.questionContracts).toEqual(initial.questionContracts);
  const saved = JSON.parse(JSON.stringify(current)); const savedHash = hashJsonData(saved);
  const renamed = labels(); renamed.current[0].options[0].label = 'Нова назва каталогу'; read.mockResolvedValue({ data: renamed });
  view.unmount(); render(<Editor initial={saved} />); open('frozen_color');
  expect((await screen.findByLabelText(csvInput('Нова назва каталогу'))).value).toBe('Світлий');
  apply(); expect(hashJsonData(current)).toBe(savedHash);
  for (let i = 0; i < names.length; i++) {
    const result = evaluateProduct(compileDefinition(current), product('BR', { color: i + 1 }));
    expect(result.base.frozen_color).toBe(names[i]); expect(result.english.frozen_color).toBe('');
  }
});

it('custom text survives save/load and evaluates exactly; existing named mapping opens without a table-ID decision', async () => {
  const initial = upgradeSourceSupport(homeDefinition(), officeEvidence()); const view = render(<Editor initial={initial} />);
  open('test_export_color'); await screen.findByLabelText(csvInput('Світлий'));
  expect(screen.queryByLabelText('Таблиця відповідностей')).toBeNull();
  expect(screen.queryByText('color4')).toBeNull();
  change('Як записувати значення', 'mapping'); change(csvInput('Світлий'), 'Світлий UX2');
  expect(writes).toBe(0); apply();
  expect(current.tables.color4).toEqual(initial.tables.color4);
  const saved = JSON.parse(JSON.stringify(current)); view.unmount(); render(<Editor initial={saved} />); open('test_export_color');
  expect((await screen.findByLabelText(csvInput('Світлий'))).value).toBe('Світлий UX2');
  click('Скасувати'); expect(current).toBe(saved);
  const result = evaluateProduct(compileDefinition(current), product('BR', { color: 1 }));
  expect(result.base.test_export_color).toBe('Світлий UX2'); expect(result.base.kolir).toBe('Світлий'); expect(result.english.test_export_color).toBe('');
});

it('custom mode starts with an editable preview of current names; cancelling creates nothing', async () => {
  const initial = upgradeSourceSupport(homeDefinition(), officeEvidence()); render(<Editor initial={initial} />);
  await newColor(); change('Як записувати значення', 'mapping');
  for (const name of names) expect(screen.getByLabelText(csvInput(name)).value).toBe(name);
  change(csvInput('Світлий'), 'Світлий UX2'); expect(writes).toBe(0); click('Скасувати');
  expect(current).toBe(initial); expect(writes).toBe(0);
});

it('raw semantic output is explicit Advanced; informational text needs no mapping and retains scalar semantics', async () => {
  render(<Editor />); await newColor('raw_color');
  expect(screen.getByRole('button', { name: 'Внутрішній ID варіанта' }).closest('details').open).toBe(false);
  fireEvent.click(screen.getByText('Технічні налаштування')); click('Внутрішній ID варіанта'); click('Додати колонку');
  expect(evaluateProduct(compileDefinition(current), product('BR', { color: 2 })).base.raw_color).toBe('2');
  click('+ Колонка'); change('Код у CSV', 'free_note'); change('Звідки брати значення', 'source'); change('Характеристика', 'BR.note');
  expect(screen.getByRole('option', { name: 'Використати значення як є' }).selected).toBe(true);
  expect(screen.queryByRole('table', { name: 'Відповідності для колонки' })).toBeNull(); click('Додати колонку');
  for (const [value, text] of [[0, '0'], ['0', '0'], ['  текст  ', '  текст  '], ['', ''], [null, '']]) {
    expect(evaluateProduct(compileDefinition(current), product('BR', { note: value })).base.free_note).toBe(text);
  }
});

it('missing or ambiguous current labels are not invented; the operator may explicitly add output', async () => {
  const data = labels(); data.current[0].options.push({ value_id: '1', label: 'Суперечлива назва' });
  data.current[0].options = data.current[0].options.filter((option) => option.value_id !== '4');
  data.historical = [{ version: 1, options: [{ value_id: '4', label: 'Історична назва' }] }]; read.mockResolvedValue({ data });
  render(<Editor />); await newColor(); change('Як записувати значення', 'labels');
  const table = screen.getByRole('table', { name: 'Відповідності для колонки' });
  expect(within(table).getAllByText('Відповідності немає')).toHaveLength(2);
  expect(within(table).getByText('Значення №4 — назву не підтверджено')).toBeTruthy();
  click('Додати текст: Значення №4 — назву не підтверджено'); change(csvInput('Значення №4 — назву не підтверджено'), 'Власна назва'); click('Додати колонку');
  const entries = current.tables[current.groups[0].rows[0].cells.frozen_color.table];
  expect(Object.hasOwn(entries, '1')).toBe(false); expect(entries['4']).toBe('Власна назва');
});

it('copying names into guarded mappings stays local and never authorizes deferred values or changes placeholder proof', async () => {
  const initial = upgradeSourceSupport(homeDefinition(), officeEvidence());
  read.mockResolvedValue({ data: { current: [{ label: 'Розмір', options: [{ value_id: '1', label: 'Малий' }, { value_id: '29', label: 'Майбутній розмір' }] }], historical: [] } });
  render(<Editor initial={initial} />); fireEvent.click(screen.getByRole('tab', { name: 'Картини' })); click('AR / rozmir_kartyny / Основний');
  await screen.findByLabelText(csvInput('Малий'));
  change('Як записувати значення', 'labels');
  expect(screen.getByLabelText(csvInput('Майбутній розмір')).value).toBe('Майбутній розмір');
  expect(screen.getAllByText('Ще не підтримується цією версією шаблону').length).toBeGreaterThan(0);
  expect(current).toBe(initial); apply();
  expect(current.sourceSupport).toEqual(initial.sourceSupport); expect(current.questionContracts).toEqual(initial.questionContracts);
  for (const [key, entries] of Object.entries(initial.tables)) if (key !== 'arSize') expect(current.tables[key]).toEqual(entries);
  expect(current.groups.filter((group) => group.route !== 'AR')).toEqual(initial.groups.filter((group) => group.route !== 'AR'));
  expect(validateSourceReferences(current, officeEvidence())).toEqual(validateSourceReferences(initial, officeEvidence()));
  const ar = stored(schema('AR', 3), 29); const nm = stored(schema('NM'), 0);
  const projected = projectSupportProducts([ar, nm], [schema('AR', 3), schema('NM')]);
  for (const item of projected) {
    const before = evaluateProduct(compileDefinition(initial), item);
    const after = evaluateProduct(compileDefinition(current), item);
    expect(after).toEqual(before);
    if (item.category === 'AR') expect(after.errors.some((error) => error.code === 'SOURCE_SUPPORT_INVALID')).toBe(true);
    else { expect(after.errors).toEqual([]); expect(after.base.dodatkovo_namysta).toBe(''); }
  }
  const lens = questionField(current, ['groups', 4, 'rows', 0, 'cells', 'rozmir_kartyny']);
  expect(current.tables[lens.lookup.table]['29']).toBe('Майбутній розмір');
});

it('ordinary rows show names once; technical codes and proof remain in closed details', async () => {
  render(<Editor />); open('test_export_color'); await screen.findByLabelText(csvInput('Світлий'));
  expect(screen.queryByText('Свідчення')).toBeNull();
  expect(screen.queryByText(/SKU-код code-0/)).toBeNull(); click('Технічні подробиці');
  const dialog = screen.getByRole('dialog', { name: 'Технічні подробиці' });
  expect(await within(dialog).findByText(/SKU-код code-0/)).toBeTruthy();
  click('← Звичайні налаштування'); expect(screen.queryByText(/SKU-код code-0/)).toBeNull();
  cleanup();
  render(<SourceDiagnostics definition={homeDefinition()} registry={registry} diagnostics={[{ sourceId: 'BR.color', code: 'SOURCE_REFERENCE_UNRESOLVED', unresolvedValueIds: ['29'], message: 'Technical source failure' }]} />);
  expect(screen.getByText('Джерело потрібно перевірити перед публікацією.')).toBeTruthy();
  expect(screen.getByText(/SOURCE_REFERENCE_UNRESOLVED/).closest('details').open).toBe(false);
  expect(screen.getByText(/Непідтверджені value_id: 29/).closest('details').open).toBe(false);
});
