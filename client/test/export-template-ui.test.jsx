import { createRequire } from 'node:module';
import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, Link } from 'react-router-dom';
import { DefinitionEditor } from '../src/components/export-templates/DefinitionEditor';
import ExportTemplatesPage from '../src/pages/ExportTemplatesPage';
import { AuthContext } from '../src/auth/auth-context';
import { exportTemplatesApi as api, createExportTemplatesApi } from '../src/api/export-templates-api';
vi.mock('../src/api/export-templates-api', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, exportTemplatesApi: Object.fromEntries(Object.keys(original.exportTemplatesApi).map((key) => [key, vi.fn()])) };
});
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { hashJsonData, compileDefinition } = require('../../server/src/services/export-templates/definition');
const { evaluateProduct } = require('../../server/src/services/export-templates/evaluate');
const { catalog, product } = require('../../server/test/fixtures/magento-v1/contract');
const baseline = () => materializeMagentoV1(catalog());
const response = (data) => ({ data });
const all = ['export_templates.view', 'export_templates.manage', 'export_templates.publish', 'export_templates.activate', 'exports.view'];
const family = (id = 'family', definition = baseline()) => ({ id, display_name: `Шаблон ${id}`, draft: { revision: '9007199254740993', definitionHash: hashJsonData(definition), definition }, versions: [] });
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; };
let lastDefinition;
function Editor({ initial = baseline(), readOnly = false }) {
  const [definition, setDefinition] = useState(initial);
  useEffect(() => { lastDefinition = definition; }, [definition]);
  return <DefinitionEditor definition={definition} onChange={setDefinition} readOnly={readOnly} />;
}
function page(permissions = all) {
  const router = createMemoryRouter([{ path: '*', element: <><Link to="/elsewhere">Інший розділ</Link><ExportTemplatesPage /></> }, { path: '/elsewhere', element: <p>Інший екран</p> }]);
  return { ...render(<AuthContext.Provider value={{ permissions }}><RouterProvider router={router} /></AuthContext.Provider>), router };
}
const choose = (label, value) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
const click = (name) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
beforeEach(() => {
  vi.clearAllMocks();
  for (const method of Object.keys(api)) vi.spyOn(api, method).mockResolvedValue(response({}));
  api.list.mockResolvedValue(response({ templates: [] }));
  api.sources.mockResolvedValue(response({}));
  api.activation.mockResolvedValue(response({ generation: '9007199254740995', implementation: 'legacy' }));
  api.candidate.mockResolvedValue(response({ definition: baseline(), diagnostics: [], candidateOnly: true }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('renders empty registry → server candidate → explicit create, without implicit persistence/publication', async () => {
  const f = family(); api.create.mockResolvedValue(response(f));
  page(); await screen.findByText(/Шаблонів ще немає/);
  click('Створити шаблон на основі Magento v1'); await screen.findByText('Новий кандидат — ще не збережено');
  expect(api.create).not.toHaveBeenCalled();
  choose('Назва шаблону', 'Новий шаблон'); choose('Сталий ключ (латиниця, цифри, _ або -)', 'pr4-form');
  click('Створити й зберегти чернетку'); await screen.findByText(/Чернетка · ревізія/);
  expect(api.create).toHaveBeenCalledWith({ key: 'pr4-form', displayName: 'Новий шаблон', definition: baseline() });
  expect(api.publish).not.toHaveBeenCalled(); expect(api.select).not.toHaveBeenCalled();
});
it('unchanged rendered editor saves exact definition/hash and transport-safe revision', async () => {
  const f = family(); api.list.mockResolvedValue(response({ templates: [{ ...f, draft_revision: f.draft.revision }] })); api.get.mockResolvedValue(response(f)); api.save.mockResolvedValue(response(f.draft));
  page(); await screen.findByLabelText('Шаблон'); choose('Шаблон', f.id); await screen.findByText(/Чернетка · ревізія/);
  click('Зберегти чернетку'); await waitFor(() => expect(api.save).toHaveBeenCalled());
  const body = api.save.mock.calls[0][1]; expect(body.expectedRevision).toBe('9007199254740993');
  expect(hashJsonData(body.definition)).toBe(f.draft.definitionHash); expect(body.definition).toEqual(f.draft.definition);
});
it('literal, shared table and local name interpolation edits preserve unrelated bindings and sparse EN', () => {
  const original = baseline(); render(<Editor initial={original} />);
  choose('Колонка', 'meta_title'); choose('Значення', '  Новий SEO\n');
  expect(lastDefinition.groups[0].rows[0].cells.meta_title.value).toBe('  Новий SEO\n');
  choose('Колонка', 'name'); click('Створити локальну копію правила BR.nameUa');
  choose('Текст із підстановками', 'Новий {material} виріб {sku}');
  expect(lastDefinition.bindings).toEqual(original.bindings);
  expect(Object.hasOwn(lastDefinition.groups[0].rows[1].cells, 'price')).toBe(false);
  click('Редагувати спільну таблицю materialUa');
  expect(screen.getByText(/Спільна зміна вплине на:/).textContent).toContain('NM / база / name');
  choose('ID 1', ' особливий ');
  expect(lastDefinition.tables.materialUa['1']).toBe(' особливий ');
  expect(lastDefinition.tables.materialEn).toEqual(original.tables.materialEn);
});
it('conditions, category fallback and ordered columns are editable via actual controls', () => {
  render(<Editor />);
  click('Відкрити спільне правило BR.nameUa');
  // The condition is itself shared; opening it must not overwrite the name.
  click('Відкрити спільне правило BR.nameValid');
  choose('Допустимі значення 1', '2');
  expect(lastDefinition.bindings.find((b) => b.id === 'BR.nameValid').value.values).toEqual(['2', '2']);
  choose('Спільне правило', 'BR.category.material');
  const fallback = screen.getByText('Запасне значення · Постійне значення').closest('fieldset');
  fireEvent.change(within(fallback).getByLabelText('Значення', { exact: true }), { target: { value: 'невідомо' } });
  expect(lastDefinition.bindings.find((b) => b.id === 'BR.category.material').value.otherwise.value).toBe('невідомо');
  choose('Розділ редактора', 'columns');
  const before = [...lastDefinition.groups[0].columns]; const rows = structuredClone(lastDefinition.groups[0].rows);
  click('Перемістити колонку вище');
  expect(lastDefinition.groups[0].columns.indexOf('name')).toBe(before.indexOf('name') - 1);
  expect([...lastDefinition.groups[0].columns].sort()).toEqual([...before].sort());
  expect(lastDefinition.groups[0].rows).toEqual(rows);
  expect(Object.hasOwn(lastDefinition.groups[0].rows[1].cells, 'price')).toBe(false);
});
it('numeric bands, null boundary and required contract controls retain scalar types', () => {
  render(<Editor />); choose('Група', '1'); choose('Розділ редактора', 'bindings'); choose('Спільне правило', 'NM.dovzhyna_namysta');
  const mins = screen.getAllByLabelText('Нижня межа', { exact: true }); fireEvent.change(mins[0], { target: { value: '18' } });
  expect(lastDefinition.bindings.find((b) => b.id === 'NM.dovzhyna_namysta').value.bands[0].min).toBe(18);
  choose('Розділ редактора', 'contracts');
  const contract = screen.getByText('NM.raw_type · необов’язкове').closest('details');
  fireEvent.change(within(contract).getByLabelText('Обов’язкове', { exact: true }), { target: { value: 'true' } });
  expect(lastDefinition.questionContracts['NM.raw_type'].required).toBe(true);
});
it('protects identity, preserves unsupported future nodes and exact null/zero/string/table-key forms', () => {
  const initial = baseline(); initial.groups[0].rows[0].cells.name = { op: 'futureNode', value: [null, 0, '0', ' '] };
  render(<Editor initial={initial} />);
  expect(screen.getByText(/Непідтримувана операція/)).toBeTruthy(); expect(lastDefinition).toEqual(initial);
  choose('Колонка', 'sku'); expect(screen.getByText('Захищене ідентифікаційне поле: sku.')).toBeTruthy();
  choose('Розділ редактора', 'tables'); choose('Спільна таблиця', 'svStoneProcessing');
  choose('ID 0', '  нуль  '); expect(lastDefinition.tables.svStoneProcessing['0']).toBe('  нуль  ');
  expect(lastDefinition.groups[0].rows[0].cells.name).toEqual(initial.groups[0].rows[0].cells.name);
  expect(lastDefinition.sources['SV.2'].key).toBe('2');
});
it('revision conflict retains unsaved form and does not fetch or overwrite the newer draft', async () => {
  const f = family(); api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f));
  api.save.mockRejectedValue({ response: { status: 409, data: { code: 'TEMPLATE_DRAFT_CONFLICT' } } });
  page(); await screen.findByLabelText('Шаблон'); choose('Шаблон', f.id); await screen.findByLabelText('Колонка');
  choose('Колонка', 'meta_title'); choose('Значення', 'Локальні зміни'); click('Зберегти чернетку');
  await screen.findByText(/На сервері вже новіша чернетка/); expect(screen.getByLabelText('Значення', { exact: true }).value).toBe('Локальні зміни');
  expect(api.get).toHaveBeenCalledTimes(1); expect(api.save).toHaveBeenCalledTimes(1);
});
it('reversed family loads cannot replace a newer selection', async () => {
  const first = deferred(); const second = deferred(); api.list.mockResolvedValue(response({ templates: [family('a'), family('b')] }));
  api.get.mockImplementation((id) => id === 'a' ? first.promise : second.promise);
  page(); await screen.findByLabelText('Шаблон'); choose('Шаблон', 'a'); choose('Шаблон', 'b');
  await act(async () => second.resolve(response(family('b'))));
  await act(async () => first.resolve(response(family('a'))));
  expect(screen.getByText(/Шаблон b · Чернетка/)).toBeTruthy(); expect(screen.queryByText(/Шаблон a · Чернетка/)).toBeNull();
});
it('edits invalidate late validation and draft preview; publication sends only exact saved revision/hash', async () => {
  const f = family(); const validation = deferred(); api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f)); api.validate.mockReturnValue(validation.promise);
  page(); await screen.findByLabelText('Шаблон'); choose('Шаблон', f.id); await screen.findByLabelText('Колонка');
  click('Перевірити збережену ревізію'); choose('Колонка', 'meta_title'); choose('Значення', 'Пізніші зміни');
  await act(async () => validation.resolve(response({ valid: true, revision: f.draft.revision })));
  expect(screen.queryByText(/Сервер перевірив ревізію/)).toBeNull();
  expect(screen.getByRole('button', { name: `Опублікувати ревізію ${f.draft.revision}` }).disabled).toBe(true);
  click('Відкинути локальні зміни');
  api.publish.mockResolvedValue(response({ id: 'version', versionNumber: '1', sourceDraftRevision: f.draft.revision, definition: f.draft.definition }));
  click(`Опублікувати ревізію ${f.draft.revision}`); await waitFor(() => expect(api.publish).toHaveBeenCalledWith(f.id, { expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash }));
});
it('published view is read-only and clones with existing revision, selection uses exact generation', async () => {
  const f = family(); f.versions = [{ id: 'version', versionNumber: '2', definition: f.draft.definition, definitionHash: f.draft.definitionHash }];
  api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f)); api.clone.mockResolvedValue(response({ ...f.draft, revision: '9007199254740994' }));
  page(); await screen.findByLabelText('Шаблон'); choose('Шаблон', f.id); await screen.findByLabelText('Версія'); choose('Версія', 'version');
  choose('Колонка', 'meta_title'); expect(screen.getByLabelText('Значення', { exact: true }).closest('fieldset').disabled).toBe(false); // enclosing fieldset owns disabled inheritance
  expect(screen.getByLabelText('Значення', { exact: true }).matches(':disabled')).toBe(true);
  api.select.mockResolvedValue(response({ generation: '9007199254740996', implementation: 'template', templateVersionId: 'version' }));
  click('Вибрати відкриту публікацію v2'); await waitFor(() => expect(api.select).toHaveBeenCalledWith({ expectedGeneration: '9007199254740995', implementation: 'template', templateVersionId: 'version' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Копіювати публікацію в чернетку' }).disabled).toBe(false));
  click('Копіювати публікацію в чернетку'); await waitFor(() => expect(api.clone).toHaveBeenCalledWith(f.id, { expectedRevision: '9007199254740993', versionId: 'version' }));
});
it('direct forbidden navigation issues no definition/source requests; delegated view+publish works independently', async () => {
  const view = page(['exports.view', 'export_templates.manage']); expect(screen.getByText(/Немає дозволу/)).toBeTruthy(); expect(api.list).not.toHaveBeenCalled(); expect(api.sources).not.toHaveBeenCalled();
  view.unmount(); const f = family(); api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f));
  const allowed = page(['export_templates.view', 'export_templates.publish']); await screen.findByLabelText('Шаблон'); choose('Шаблон', f.id); await screen.findByLabelText('Колонка');
  expect(screen.queryByRole('button', { name: 'Зберегти чернетку' })).toBeNull(); expect(screen.getByRole('button', { name: `Опублікувати ревізію ${f.draft.revision}` }).disabled).toBe(false);
  allowed.rerender(<AuthContext.Provider value={{ permissions: [] }}><ExportTemplatesPage /></AuthContext.Provider>);
  expect(screen.getByText(/Немає дозволу/)).toBeTruthy(); expect(api.list).toHaveBeenCalledTimes(1);
});
it('draft preview validates explicit ID list, displays server diagnostics and never creates a snapshot token', async () => {
  const f = family(); api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f));
  api.preview.mockResolvedValue(response({ revision: f.draft.revision, draftOnly: true, result: { representedCount: 1, readyCount: 0, errors: [{ sku: '<script>', fields: [{ field: 'name', message: 'Потрібна назва' }] }] } }));
  page(); await screen.findByLabelText('Шаблон'); choose('Шаблон', f.id); await screen.findByLabelText('Колонка');
  choose('ID товарів (1–100, через кому або пробіл)', '1,1'); click('Переглянути тестовий результат'); await screen.findByRole('alert'); expect(api.preview).not.toHaveBeenCalled();
  choose('ID товарів (1–100, через кому або пробіл)', '1'); click('Переглянути тестовий результат'); await screen.findByText(/Тест чернетки — лише читання/);
  expect(api.preview).toHaveBeenCalledWith(f.id, { expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash, productIds: [1] });
  expect(screen.getByText(/<script>: name: Потрібна назва/)).toBeTruthy(); expect(document.querySelector('script')).toBeNull();
});
it('API adapter forwards actual endpoints and bodies without coercing counters', async () => {
  const client = { get: vi.fn(), put: vi.fn(), post: vi.fn() }; const adapter = createExportTemplatesApi(client);
  const payload = { expectedRevision: '9007199254740999', expectedDefinitionHash: 'a'.repeat(64) };
  adapter.candidate(); adapter.preview('id', { ...payload, productIds: [1] }); adapter.save('id', { expectedRevision: payload.expectedRevision, definition: {} });
  expect(client.get).toHaveBeenCalledWith('/admin/export-templates/candidate');
  expect(client.post).toHaveBeenCalledWith('/admin/export-templates/id/test-preview', { ...payload, productIds: [1] });
  expect(client.put).toHaveBeenCalledWith('/admin/export-templates/id/draft', { expectedRevision: payload.expectedRevision, definition: {} });
});

it('category interpolation and visibility conditions have form controls and associated validation errors', () => {
  render(<Editor />); choose('Колонка', 'categories'); click('Відкрити спільне правило BR.categories');
  const path = screen.getAllByLabelText('Текст із підстановками', { exact: true }).find((input) => input.value.includes('{style}'));
  fireEvent.change(path, { target: { value: 'Default/PR4/{style}' } });
  expect(lastDefinition.bindings.find((b) => b.id === 'BR.categories').value.items.some((item) => item.template === 'Default/PR4/{style}')).toBe(true);
  fireEvent.change(path, { target: { value: 'Default/{unknown}' } });
  expect(path.getAttribute('aria-invalid')).toBe('true'); expect(screen.getByRole('alert').textContent).toContain('оголошені слоти');
  fireEvent.change(path, { target: { value: 'Default/PR4/{style}' } });
  choose('Розділ редактора', 'contracts');
  const contract = screen.getByText('BR.raw_type · необов’язкове').closest('details');
  fireEvent.change(within(contract).getByLabelText('Джерело нової умови'), { target: { value: 'BR.processing' } });
  fireEvent.click(within(contract).getByRole('button', { name: 'Додати умову видимості' }));
  expect(lastDefinition.questionContracts['BR.raw_type'].rule).toEqual({ 'BR.processing': null });
  fireEvent.change(within(contract).getByLabelText('Тип: Видимість: BR.processing'), { target: { value: 'number' } });
  expect(lastDefinition.questionContracts['BR.raw_type'].rule['BR.processing']).toBe(0);
});
it('late save cannot replace a newer loaded family, and late draft preview cannot validate newer edits', async () => {
  const f = family('a'); const other = family('b'); const saved = deferred(); const latePreview = deferred();
  api.list.mockResolvedValue(response({ templates: [f, other] })); api.get.mockImplementation(async (id) => response(id === 'a' ? f : other));
  api.save.mockReturnValue(saved.promise); api.preview.mockReturnValue(latePreview.promise);
  page(); await screen.findByLabelText('Шаблон'); choose('Шаблон', 'a'); await screen.findByLabelText('Колонка');
  click('Зберегти чернетку'); choose('Шаблон', 'b'); await screen.findByText(/Шаблон b · Чернетка/);
  await act(async () => saved.resolve(response({ ...f.draft, revision: '999' })));
  expect(screen.getByText(/Шаблон b · Чернетка/).textContent).not.toContain('999');
  choose('ID товарів (1–100, через кому або пробіл)', '1'); click('Переглянути тестовий результат');
  choose('Колонка', 'meta_title'); choose('Значення', 'Змінено під час тесту');
  await act(async () => latePreview.resolve(response({ revision: other.draft.revision, result: { representedCount: 1, readyCount: 1 } })));
  expect(screen.queryByText(/Тест чернетки — лише читання/)).toBeNull();
  expect(screen.getByRole('button', { name: `Опублікувати ревізію ${other.draft.revision}` }).disabled).toBe(true);
});
it('manage without exports.view cannot issue draft previews; permission denial does not retry', async () => {
  const f = family(); api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f));
  api.save.mockRejectedValue({ response: { status: 403, data: { code: 'INSUFFICIENT_PERMISSION', error: 'Недостатньо прав' } } });
  page(['export_templates.view', 'export_templates.manage']); await screen.findByLabelText('Шаблон'); choose('Шаблон', f.id); await screen.findByLabelText('Колонка');
  expect(screen.queryByRole('button', { name: 'Переглянути тестовий результат' })).toBeNull();
  click('Зберегти чернетку'); await screen.findByText('Недостатньо прав'); expect(api.save).toHaveBeenCalledTimes(1); expect(api.preview).not.toHaveBeenCalled();
});
it('separate lookup copy affects only the explicitly detached consumer; source selection edits only that node', () => {
  const original = baseline(); render(<Editor initial={original} />);
  click('Створити локальну копію правила BR.nameUa'); click('Редагувати спільну таблицю materialUa');
  click('Створити окрему копію таблиці'); choose('ID 1', 'Локальний матеріал');
  expect(lastDefinition.tables.materialUa).toEqual(original.tables.materialUa);
  expect(lastDefinition.tables['materialUa.copy1']['1']).toBe('Локальний матеріал');
  choose('Розділ редактора', 'columns'); choose('Таблиця відповідностей', 'materialUa.copy1');
  expect(lastDefinition.groups[0].rows[0].cells.name.then.slots.material.table).toBe('materialUa.copy1');
  expect(lastDefinition.bindings).toEqual(original.bindings);
  // Pure server evaluation of the form-produced definition, with identical facts.
  // This is not browser-authoritative evaluation or a persisted integration test.
  const before = compileDefinition(original); const after = compileDefinition(lastDefinition);
  for (const group of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']) {
    const facts = product(group); const factsBefore = structuredClone(facts);
    const oldOutput = evaluateProduct(before, facts); const newOutput = evaluateProduct(after, facts);
    expect(newOutput.errors).toEqual([]);
    if (group === 'BR') {
      expect(newOutput.base.name).toBe('Браслет з Локальний матеріал бурштину. Арт: BR-SYNTH-001');
      expect(newOutput).toEqual({ ...oldOutput, base: { ...oldOutput.base, name: newOutput.base.name } });
    } else expect(newOutput).toEqual(oldOutput);
    expect(facts).toEqual(factsBefore);
  }
  expect(lastDefinition.questionContracts).toEqual(original.questionContracts);
  expect(lastDefinition.sources).toEqual(original.sources);
  expect(Object.keys(lastDefinition.tables['materialUa.copy1'])).toEqual(Object.keys(original.tables.materialUa));
  choose('Колонка', 'price'); click('Відкрити спільне правило BR.price'); choose('Джерело', 'weight');
  expect(lastDefinition.bindings.find((b) => b.id === 'BR.price').value.input.id).toBe('weight');
  expect(lastDefinition.bindings.find((b) => b.id === 'NM.price')).toEqual(original.bindings.find((b) => b.id === 'NM.price'));
});

it('KL local composition adds mapped color, renames references and removes explicitly without changing material, SKU or shared consumers', () => {
  const original = baseline(); render(<Editor initial={original} />);
  choose('Група', '2'); click('Створити локальну копію правила KL.nameUa');
  const originalName = original.bindings.find((b) => b.id === 'KL.nameUa').value;
  expect(Object.keys(originalName.then.slots)).toEqual(['material', 'sku']);
  expect(original.sources['KL.color']).toMatchObject({ kind: 'semantic', category: 'KL', key: 'color' });
  choose('Назва нової підстановки', 'color');
  choose('Вираз нової підстановки', 'lookup');
  choose('Джерело нової підстановки', 'KL.color'); choose('Таблиця нової підстановки', 'klColor');
  click('Додати підстановку');
  const local = () => lastDefinition.groups[2].rows[0].cells.name;
  expect(local().then.slots.material).toEqual(originalName.then.slots.material);
  expect(local().then.slots.sku).toEqual(originalName.then.slots.sku);
  expect(local().then.slots.color.input.input.id).toBe('KL.color');
  choose('Текст із підстановками', 'Кулон з {material} бурштину, {color}. Арт: {sku}');
  const text = screen.getByLabelText('Текст із підстановками', { exact: true });
  expect(text.checkValidity()).toBe(true);
  const result = evaluateProduct(compileDefinition(lastDefinition), product('KL'));
  expect(result.base.name).toContain(', ');
  expect(screen.getByRole('button', { name: 'Вилучити підстановку color' }).disabled).toBe(true);
  choose('Нова назва підстановки color', 'shade'); click('Перейменувати color та оновити посилання в тексті');
  expect(local().then.template).toContain('{shade}');
  expect(evaluateProduct(compileDefinition(lastDefinition), product('KL'))).toEqual(result);
  expect(lastDefinition.bindings).toEqual(original.bindings);
  expect(lastDefinition.sources).toEqual(original.sources);
  expect(lastDefinition.tables).toEqual(original.tables);
  choose('Текст із підстановками', originalName.then.template);
  click('Вилучити підстановку shade');
  expect(text.checkValidity()).toBe(true);
  expect(local()).toEqual(originalName);
});

it('dirty router navigation supports Stay, failed Save, Discard and history back', async () => {
  const f = family(); api.list.mockResolvedValue(response({ templates: [{ ...f, draft_revision: f.draft.revision }] })); api.get.mockResolvedValue(response(f));
  const { router } = page(); await screen.findByLabelText('Шаблон'); choose('Шаблон', f.id); await screen.findByText(/Чернетка · ревізія/);
  choose('Колонка', 'meta_title'); choose('Значення', '  unsaved exact\n');
  fireEvent.click(screen.getByText('Інший розділ')); await screen.findByRole('dialog'); click('Залишитися');
  expect(screen.getByLabelText('Значення', { exact: true }).value).toBe('  unsaved exact\n');
  api.save.mockRejectedValue({ response: { data: { code: 'TEMPLATE_DRAFT_CONFLICT' } } });
  fireEvent.click(screen.getByText('Інший розділ')); click('Зберегти й перейти');
  await screen.findByText(/На сервері вже новіша чернетка/); expect(router.state.location.pathname).toBe('/');
  expect(screen.getByRole('dialog')).toBeTruthy(); click('Відкинути й перейти'); await screen.findByText('Інший екран');
  await act(async () => router.navigate(-1)); await screen.findByLabelText('Шаблон');
});

it('successful save completes blocked navigation with exact draft', async () => {
  const f = family(); api.list.mockResolvedValue(response({ templates: [{ ...f, draft_revision: f.draft.revision }] })); api.get.mockResolvedValue(response(f));
  api.save.mockImplementation(async (_id, body) => response({ ...f.draft, revision: '9007199254740994', definition: body.definition }));
  page(); await screen.findByLabelText('Шаблон'); choose('Шаблон', f.id); await screen.findByText(/Чернетка · ревізія/);
  choose('Колонка', 'meta_title'); choose('Значення', 'exact'); fireEvent.click(screen.getByText('Інший розділ')); click('Зберегти й перейти');
  await screen.findByText('Інший екран'); expect(api.save.mock.calls[0][1].definition.groups[0].rows[0].cells.meta_title.value).toBe('exact');
});
