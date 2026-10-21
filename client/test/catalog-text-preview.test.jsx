import { createRequire } from 'node:module';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { exportTemplatesApi as api } from '../src/api/export-templates-api.js';
import CatalogTextPreview from '../src/components/workspace/CatalogTextPreview.jsx';
import { ColumnInspector } from '../src/components/export-templates/ColumnInspector.jsx';

vi.mock('../src/api/export-templates-api.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, exportTemplatesApi: Object.fromEntries(Object.keys(original.exportTemplatesApi).map((key) => [key, vi.fn()])) };
});
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { upgradeColumns } = require('../../server/src/services/export-templates/column-contract');
const { catalog } = require('../../server/test/fixtures/magento-v1/contract');
const permissions = ['export_templates.view', 'export_templates.manage', 'exports.view'];
const sample = { id: 12, public_sku: 'BR-0012', full_sku: 'internal-encoded-sku', category: 'BR', status: 'active' };
const response = (data) => ({ data });
const definition = (text = 'Нова назва') => ({ sources: {}, bindings: [], groups: [{ route: 'BR', rows: [{ id: 'base', cells: { name: { op: 'literal', value: text } } }] }] });
const previewResponse = (revision = '9007199254740993') => response({ revision, definitionHash: `hash-${revision}`, draftOnly: true, publicationReady: false,
  result: { errors: [], provisionalArtifacts: [{ groupCode: 'BR', csvContent: 'sku,store_view_code,name\r\nBR-0012,,"Назва, з комою"\r\nBR-0012,en,"English <b>text</b>"\r\n' }] } });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const clickPreview = () => fireEvent.click(screen.getByRole('button', { name: 'Оновити приклад' }));
async function selectSample() {
  fireEvent.change(screen.getByLabelText('Пошук за артикулом або внутрішнім SKU'), { target: { value: 'BR-0012' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Обрати BR-0012' }));
}
function view(props = {}, auth = { permissions }) {
  const all = { getDefinition: () => definition(), changeKey: 'first', categoryCode: 'BR', column: 'name', rowId: 'base', ...props };
  const shell = (next = {}, nextAuth = auth) => <AuthContext.Provider value={nextAuth}><CatalogTextPreview {...all} {...next} /></AuthContext.Provider>;
  const result = render(shell());
  return { ...result, update: (next, nextAuth) => result.rerender(shell(next, nextAuth)) };
}
beforeEach(() => {
  vi.resetAllMocks();
  api.searchSamples.mockResolvedValue(response({ products: [sample, { ...sample, id: 99, category: 'SV', public_sku: 'SV-0099' }], nextOffset: null }));
  api.evaluateExample.mockResolvedValue(previewResponse());
});
afterEach(cleanup);

it('explicitly evaluates unsaved input without creating a family and shows literal server UA/EN text', async () => {
  const current = definition(); const onBusyChange = vi.fn(); view({ getDefinition: () => current, onBusyChange });
  expect(api.evaluateExample).not.toHaveBeenCalled(); expect(api.searchSamples).not.toHaveBeenCalled();
  await selectSample(); expect(screen.queryByRole('button', { name: 'Обрати SV-0099' })).toBeNull();
  clickPreview(); expect(await screen.findByText('Назва, з комою')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Приклад EN' })).getByText('English <b>text</b>').querySelector('b')).toBeNull();
  expect(api.evaluateExample).toHaveBeenCalledWith({ definition: current, productIds: [12] });
  for (const method of ['create', 'save', 'publish', 'clone', 'list', 'get', 'preview']) expect(api[method]).not.toHaveBeenCalled();
  expect(onBusyChange.mock.calls.map(([value]) => value)).toEqual([true, false]); expect(current).toEqual(definition());
});

it('marks edits stale and evaluates the new exact definition only after another click', async () => {
  const result = view(); await selectSample(); clickPreview(); await screen.findByText('Назва, з комою');
  const edited = definition('Змінено без збереження'); result.update({ getDefinition: () => edited, changeKey: 'edited' });
  expect(screen.getByText(/Правило або товар змінилися/)).toBeTruthy(); expect(api.evaluateExample).toHaveBeenCalledTimes(1);
  clickPreview(); await waitFor(() => expect(api.evaluateExample).toHaveBeenCalledTimes(2));
  expect(api.evaluateExample).toHaveBeenLastCalledWith({ definition: edited, productIds: [12] });
  await waitFor(() => expect(screen.queryByText(/Правило або товар змінилися/)).toBeNull());
  expect(api.create).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled();
});

it('keeps the chosen example compact and makes changing the product an explicit stale result', async () => {
  view(); await selectSample(); clickPreview(); await screen.findByText('Назва, з комою');
  expect(screen.queryByLabelText('Пошук за артикулом або внутрішнім SKU')).toBeNull();
  expect(screen.getAllByText('Артикул: BR-0012')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Змінити товар' }));
  expect(screen.getByLabelText('Пошук за артикулом або внутрішнім SKU').value).toBe('');
  expect(screen.getByText(/Правило або товар змінилися/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Оновити приклад' }).disabled).toBe(true);
  expect(api.evaluateExample).toHaveBeenCalledTimes(1);
});

it('a failed example is safely repeatable and never searches or creates a recovery family', async () => {
  api.evaluateExample.mockRejectedValueOnce(new Error('Response lost'));
  view(); await selectSample(); clickPreview(); await screen.findByRole('alert');
  clickPreview(); await screen.findByText('Назва, з комою');
  expect(api.evaluateExample).toHaveBeenCalledTimes(2);
  for (const method of ['create', 'save', 'list', 'get']) expect(api[method]).not.toHaveBeenCalled();
});

it('discards a response after principal invalidation', async () => {
  const pending = deferred(); api.evaluateExample.mockReturnValue(pending.promise);
  const principalLifetime = { id: 'user', valid: true };
  view({}, { permissions, principalLifetime }); await selectSample(); clickPreview();
  principalLifetime.valid = false; await act(async () => pending.resolve(previewResponse()));
  expect(screen.queryByText('Назва, з комою')).toBeNull(); expect(api.create).not.toHaveBeenCalled();
});

it('blocks disabled actions and permission-limited viewers', () => {
  const result = view({ disabled: true }); expect(screen.getByRole('button', { name: 'Оновити приклад' }).disabled).toBe(true);
  clickPreview(); result.update({ disabled: false }, { permissions: ['export_templates.view'] });
  expect(screen.queryByRole('button', { name: 'Оновити приклад' })).toBeNull();
  expect(api.evaluateExample).not.toHaveBeenCalled(); expect(api.searchSamples).not.toHaveBeenCalled();
});

it('keeps late results visibly stale and never invents a local result for failed evaluation', async () => {
  const pending = deferred(); api.evaluateExample.mockReturnValueOnce(pending.promise);
  const result = view(); await selectSample(); clickPreview(); await waitFor(() => expect(api.evaluateExample).toHaveBeenCalledOnce());
  result.update({ getDefinition: () => definition('New edit during request'), changeKey: 'second' });
  await act(async () => pending.resolve(previewResponse())); expect(screen.getByText(/Правило або товар змінилися/)).toBeTruthy();
  expect(screen.queryByText('New edit during request')).toBeNull();
  api.evaluateExample.mockResolvedValue(response({ result: { provisionalArtifacts: [], errors: [{ productId: 12, fields: [{ field: 'price', message: 'Missing price' }] }] } }));
  clickPreview(); await screen.findByText(/Приклад поки не обчислено/);
  expect(screen.queryByRole('region', { name: 'Приклад UA' })).toBeNull(); expect(screen.getByText('price: Missing price')).toBeTruthy();
});

it('invalid materialized edits cannot issue a server evaluation', async () => {
  view({ getDefinition: () => { throw new Error('Choose a characteristic'); } }); await selectSample(); clickPreview();
  await screen.findByRole('alert'); expect(api.evaluateExample).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
});

it('ColumnInspector exposes materialized pending text without applying it and ignores preview input for draft dirtiness and validity', () => {
  const initial = upgradeColumns(materializeMagentoV1(catalog()));
  initial.groups[0].rows[0].cells.name = { op: 'literal', value: 'Початковий текст' };
  const before = structuredClone(initial); const onApply = vi.fn(); const onCancel = vi.fn(); const onPendingChange = vi.fn(); const snapshots = [];
  const props = { integration: true, embedded: true, simple: true, definition: initial, groupIndex: 0, rowIndex: 0, column: 'name', registry: { references: { questions: [], schemas: [] } }, onApply, onCancel, onPendingChange, onRequestClose: vi.fn() };
  render(<ColumnInspector {...props} renderPreview={({ getDefinition, disabled }) => <><input aria-label="Пошук прикладу" required /><button type="button" disabled={disabled} onClick={() => snapshots.push(getDefinition())}>Перевірити введене</button></>} />);
  fireEvent.change(screen.getByLabelText('Пошук прикладу'), { target: { value: 'BR' } });
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByLabelText('Значення для Magento'), { target: { value: 'Незастосований текст' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити введене' }));
  expect(snapshots[0].groups[0].rows[0].cells.name.value).toBe('Незастосований текст');
  expect(initial).toEqual(before); expect(onApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати' })); expect(onCancel).toHaveBeenCalledOnce(); expect(onApply).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Пошук прикладу'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
  expect(onApply).toHaveBeenCalledWith(snapshots[0], before);
});
