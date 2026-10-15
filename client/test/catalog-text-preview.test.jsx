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
const stored = (value, revision = '9007199254740993') => ({ id: 'example-family', draft: { definition: value, revision, definitionHash: `hash-${revision}` } });
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
  api.create.mockImplementation(async ({ definition: value }) => response(stored(value)));
  api.preview.mockResolvedValue(previewResponse());
});
afterEach(cleanup);

it('only explicitly previews the unsaved definition in an isolated family, showing server UA/EN text without HTML execution', async () => {
  const current = definition(); const onBusyChange = vi.fn();
  view({ getDefinition: () => current, onBusyChange });
  expect(api.create).not.toHaveBeenCalled(); expect(api.preview).not.toHaveBeenCalled(); expect(api.searchSamples).not.toHaveBeenCalled();
  await selectSample();
  expect(screen.queryByRole('button', { name: 'Обрати SV-0099' })).toBeNull();
  expect(api.create).not.toHaveBeenCalled();
  clickPreview();
  expect(await screen.findByText('Назва, з комою')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Приклад EN' })).getByText('English <b>text</b>').querySelector('b')).toBeNull();
  expect(api.create).toHaveBeenCalledWith({ key: expect.stringMatching(/^catalog-example-/), displayName: 'Приклад тексту · BR', definition: current });
  expect(api.preview).toHaveBeenCalledWith('example-family', { expectedRevision: '9007199254740993', expectedDefinitionHash: 'hash-9007199254740993', productIds: [12] });
  expect(api.save).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled(); expect(api.clone).not.toHaveBeenCalled();
  expect(onBusyChange.mock.calls.map(([value]) => value)).toEqual([true, false]);
  expect(current).toEqual(definition());
});

it('marks examples stale after edits and saves only the isolated family on the next explicit click using opaque revision strings', async () => {
  const result = view(); await selectSample(); clickPreview(); await screen.findByText('Назва, з комою');
  const edited = definition('Змінено без збереження');
  result.update({ getDefinition: () => edited, changeKey: 'edited' });
  expect(screen.getByText(/Правило або товар змінилися/)).toBeTruthy();
  expect(api.save).not.toHaveBeenCalled(); expect(api.preview).toHaveBeenCalledTimes(1);
  api.save.mockResolvedValue(response(stored(edited, '9007199254740994').draft));
  api.preview.mockResolvedValue(previewResponse('9007199254740994'));
  clickPreview(); await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
  expect(api.create).toHaveBeenCalledOnce();
  expect(api.save).toHaveBeenCalledWith('example-family', { expectedRevision: '9007199254740993', definition: edited });
  expect(api.preview).toHaveBeenLastCalledWith('example-family', { expectedRevision: '9007199254740994', expectedDefinitionHash: 'hash-9007199254740994', productIds: [12] });
  await waitFor(() => expect(screen.queryByText(/Правило або товар змінилися/)).toBeNull());
});

it('recovers a lost create response by the exact generated key and never creates a second family', async () => {
  let key;
  api.create.mockImplementation(async (input) => { key = input.key; throw new Error('Lost response'); });
  api.list.mockImplementation(async () => response({ templates: [{ id: 'wrong', template_key: 'unrelated' }, { id: 'example-family', template_key: key }] }));
  api.get.mockResolvedValue(response(stored(definition())));
  view(); await selectSample(); clickPreview(); await screen.findByText('Назва, з комою');
  expect(api.create).toHaveBeenCalledOnce(); expect(api.get).toHaveBeenCalledWith('example-family'); expect(api.save).not.toHaveBeenCalled();
  clickPreview(); await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
  expect(api.create).toHaveBeenCalledOnce(); expect(api.list).toHaveBeenCalledOnce();
});

it('recovers an uncertain save through a read and uses the verified saved revision for preview', async () => {
  const result = view(); await selectSample(); clickPreview(); await screen.findByText('Назва, з комою');
  const edited = definition('Після редагування'); result.update({ getDefinition: () => edited, changeKey: 'edited' });
  api.save.mockRejectedValue(new Error('Lost save response'));
  api.get.mockResolvedValue(response(stored(edited, '9007199254740994')));
  api.preview.mockResolvedValue(previewResponse('9007199254740994'));
  clickPreview(); await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
  expect(api.save).toHaveBeenCalledOnce(); expect(api.get).toHaveBeenCalledWith('example-family');
  expect(api.preview).toHaveBeenLastCalledWith('example-family', expect.objectContaining({ expectedRevision: '9007199254740994' }));
});

it('does not overwrite a divergent save recovery or preview another revision', async () => {
  const result = view(); await selectSample(); clickPreview(); await screen.findByText('Назва, з комою');
  result.update({ getDefinition: () => definition('My edit'), changeKey: 'edited' });
  api.save.mockRejectedValue(new Error('Revision conflict'));
  api.get.mockResolvedValue(response(stored(definition('Other edit'), '9007199254740994')));
  clickPreview(); await screen.findByRole('alert');
  expect(api.save).toHaveBeenCalledOnce(); expect(api.preview).toHaveBeenCalledOnce();
  expect(screen.getByText(/Правило або товар змінилися/)).toBeTruthy();
});

it('discards an obsolete response and does not continue requests after principal invalidation', async () => {
  const pending = deferred(); api.create.mockReturnValue(pending.promise);
  const principalLifetime = { id: 'user', valid: true }; const onBusyChange = vi.fn();
  view({ onBusyChange }, { permissions, principalLifetime }); await selectSample(); clickPreview();
  principalLifetime.valid = false;
  await act(async () => pending.resolve(response(stored(definition()))));
  expect(api.preview).not.toHaveBeenCalled(); expect(screen.queryByText('Назва, з комою')).toBeNull();
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
});

it('blocks automatic work, disabled actions and permission-limited viewers', async () => {
  const result = view({ disabled: true });
  expect(screen.getByRole('button', { name: 'Оновити приклад' }).disabled).toBe(true);
  clickPreview(); expect(api.create).not.toHaveBeenCalled();
  result.update({ disabled: false }, { permissions: ['export_templates.view'] });
  expect(screen.queryByRole('button', { name: 'Оновити приклад' })).toBeNull();
  expect(api.create).not.toHaveBeenCalled(); expect(api.searchSamples).not.toHaveBeenCalled();
});

it('keeps a response from an earlier edit visibly stale and never substitutes local text for failed server evaluation', async () => {
  const pending = deferred(); api.preview.mockReturnValue(pending.promise);
  const result = view(); await selectSample(); clickPreview(); await waitFor(() => expect(api.preview).toHaveBeenCalledOnce());
  result.update({ getDefinition: () => definition('New edit during request'), changeKey: 'second' });
  await act(async () => pending.resolve(previewResponse()));
  expect(screen.getByText(/Правило або товар змінилися/)).toBeTruthy();
  expect(screen.queryByText('New edit during request')).toBeNull();
  api.save.mockResolvedValue(response(stored(definition('New edit during request'), '9007199254740994').draft));
  api.preview.mockResolvedValue(response({ revision: '9007199254740994', definitionHash: 'hash-9007199254740994', result: { provisionalArtifacts: [], errors: [{ productId: 12, fields: [{ field: 'price', message: 'Missing price' }] }] } }));
  clickPreview(); await screen.findByText(/Приклад поки не обчислено/);
  expect(screen.queryByRole('region', { name: 'Приклад UA' })).toBeNull();
  expect(screen.getByText('price: Missing price')).toBeTruthy();
});

it('invalid materialized edits cannot create or save a preview draft', async () => {
  view({ getDefinition: () => { throw new Error('Choose a characteristic'); } }); await selectSample(); clickPreview();
  await screen.findByRole('alert');
  expect(api.create).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled(); expect(api.preview).not.toHaveBeenCalled();
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
