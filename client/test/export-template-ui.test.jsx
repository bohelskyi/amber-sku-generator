import { createRequire } from 'node:module';
import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, Link } from 'react-router-dom';
import { AdvancedDefinitionEditor as DefinitionEditor } from '../src/components/export-templates/AdvancedDefinitionEditor';
import { DefinitionEditor as FieldEditor } from '../src/components/export-templates/DefinitionEditor';
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
const { evaluateProduct, evaluateBatch } = require('../../server/src/services/export-templates/evaluate');
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
  const router = createMemoryRouter([{ path: '*', element: <><Link to="/elsewhere">Інший розділ</Link><ExportTemplatesPage /></> }, { path: '/elsewhere', element: <p>Інший екран</p> }], { initialEntries: ['/admin/export-templates'] });
  return { ...render(<AuthContext.Provider value={{ permissions }}><RouterProvider router={router} /></AuthContext.Provider>), router };
}
const choose = (label, value) => {
  if (label === 'Шаблон') {
    const back = screen.queryByRole('button', { name: '← До шаблонів' }); if (back) fireEvent.click(back);
    fireEvent.click(screen.getByRole('link', { name: 'Відкрити Шаблон ' + value })); return;
  }
  if (label === 'Колонка' && !screen.queryByLabelText('Колонка', { exact: true })) {
    const fields = screen.queryByRole('link', { name: 'Поля експорту', exact: true }); if (fields) fireEvent.click(fields);
    fireEvent.click(screen.getByRole('button', { name: 'Налаштувати колонку ' + value, exact: true })); return;
  }
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
};
const click = (name) => {
  const mapped = ({ 'Створити шаблон на основі Magento v1': 'Створити шаблон', 'Перевірити збережену ревізію': 'Перевірити шаблон',
    'Переглянути тестовий результат': 'Переглянути результат', 'Копіювати публікацію в чернетку': 'Створити чернетку з цієї версії' })[name] || (name.startsWith('Опублікувати ревізію') ? 'Опублікувати версію' : name);
  const tab = ['Перевірити шаблон', 'Переглянути результат'].includes(mapped) ? 'Перевірка' : mapped.startsWith('Опублікувати') || mapped.startsWith('Вибрати відкриту') ? 'Версії' : null;
  if (tab) fireEvent.click(screen.getByRole('link', { name: tab, exact: true }));
  fireEvent.click(screen.queryByRole('button', { name: mapped, exact: true }) || screen.getByRole('link', { name: mapped, exact: true }));
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const method of Object.keys(api)) vi.spyOn(api, method).mockResolvedValue(response({}));
  api.list.mockResolvedValue(response({ templates: [] }));
  api.sources.mockResolvedValue(response({}));
  api.sourceDetails.mockResolvedValue(response({ current: [], historical: [], truncated: false }));
  api.searchSamples.mockResolvedValue(response({ products: [], nextOffset: null }));
  api.activation.mockResolvedValue(response({ generation: '9007199254740995', implementation: 'legacy' }));
  api.candidate.mockResolvedValue(response({ definition: baseline(), diagnostics: [], candidateOnly: true }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const officeDiagnostics = [
  { sourceId: 'KL.exact_size', category: 'KL', key: 'exact_size', code: 'SOURCE_REFERENCE_UNRESOLVED',
    requirement: 'current_non_sku_question', message: 'Current non-SKU question metadata required' },
  { sourceId: 'NM.extra', category: 'NM', key: 'extra', code: 'SOURCE_REFERENCE_UNRESOLVED',
    requirement: 'historical_sku_or_current_non_sku_value_ids', unresolvedValueIds: ['0'], currentValueIds: ['0', '1', '2'], historicalValueIds: ['1', '2'], message: 'Unverified semantic value IDs: NM.extra: 0' },
  { sourceId: 'AR.size', category: 'AR', key: 'size', code: 'SOURCE_REFERENCE_UNRESOLVED',
    requirement: 'historical_sku_or_current_non_sku_value_ids', unresolvedValueIds: ['29', '30', '31'], currentValueIds: ['29', '30', '31'], historicalValueIds: ['28'], message: 'Unverified semantic value IDs: AR.size: 29, 30, 31' },
];
function officeCandidate() {
  api.candidate.mockResolvedValue(response({ definition: baseline(), diagnostics: officeDiagnostics }));
  api.sources.mockResolvedValue(response({ references: { questions: [{ category_code: 'NM', key: 'extra', label: 'Додатково' }] } }));
}
it('OFFICE same source diagnostics disable empty name only; valid name submits exact draft and reopens', async () => {
  officeCandidate(); const f = family(); api.create.mockResolvedValue(response(f)); api.get.mockResolvedValue(response(f));
  page(); await screen.findByText(/Шаблонів ще немає/); click('Створити шаблон'); await screen.findByText('Новий шаблон');
  expect(screen.getByRole('button', { name: 'Створити й зберегти чернетку' }).disabled).toBe(true);
  choose('Назва шаблону', 'Office template regression');
  expect(screen.getByRole('button', { name: 'Створити й зберегти чернетку' }).disabled).toBe(false);
  const key = screen.getByLabelText('Сталий ключ (латиниця, цифри, _ або -)').value;
  choose('Сталий ключ (латиниця, цифри, _ або -)', 'Invalid key');
  expect(screen.getByRole('button', { name: 'Створити й зберегти чернетку' }).disabled).toBe(true);
  expect(screen.getByText(/Ключ має починатися/)).toBeTruthy();
  choose('Сталий ключ (латиниця, цифри, _ або -)', key);
  click('Створити й зберегти чернетку'); await screen.findByText(/Збережено · ревізія/);
  expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Office template regression', definition: baseline() }));
  click('← До шаблонів'); click('Відкрити Шаблон family'); await screen.findByText(/Збережено · ревізія/);
  expect(screen.getByText(/Готовність до публікації не підтверджено/)).toBeTruthy();
  api.validate.mockRejectedValue({ response: { data: { code: 'TEMPLATE_SOURCE_INVALID', details: { diagnostics: officeDiagnostics } } } });
  click('Перевірити шаблон'); await screen.findByText(/Шаблон не готовий до публікації/);
  expect(screen.getByText('Непідтверджені value_id: 29, 30, 31')).toBeTruthy();
  expect(api.publish).not.toHaveBeenCalled(); expect(api.select).not.toHaveBeenCalled();
});
it('OFFICE source diagnostics group Ukrainian fields and expose exact failed evidence separately from name', async () => {
  officeCandidate(); page(); await screen.findByText(/Шаблонів ще немає/); click('Створити шаблон'); await screen.findByText('Новий шаблон');
  expect(screen.getByText('Чернетку можна зберегти. Перед публікацією потрібно перевірити 3 джерела.')).toBeTruthy();
  for (const label of ['Кулони — розмір', 'Намиста — Додатково', 'Картини — розмір']) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText('Непідтверджені value_id: 0')).toBeTruthy();
  expect(screen.getByText('Непідтверджені value_id: 29, 30, 31')).toBeTruthy();
  expect(screen.getAllByText('Технічні подробиці')).toHaveLength(3);
  choose('Назва шаблону', 'Office template regression');
  const key = screen.getByLabelText('Сталий ключ (латиниця, цифри, _ або -)').value;
  api.create.mockRejectedValue({ response: { data: { code: 'TEMPLATE_KEY_CONFLICT' } } });
  click('Створити й зберегти чернетку'); await screen.findByText(/Ключ уже зайнятий/);
  expect(screen.getByLabelText('Назва шаблону').value).toBe('Office template regression');
  expect(screen.getByLabelText('Сталий ключ (латиниця, цифри, _ або -)').value).toBe(key);
});

it('renders empty registry → server candidate → explicit create, without implicit persistence/publication', async () => {
  const f = family(); api.create.mockResolvedValue(response(f));
  page(); await screen.findByText(/Шаблонів ще немає/);
  click('Створити шаблон на основі Magento v1'); await screen.findByText('Новий шаблон');
  expect(api.create).not.toHaveBeenCalled();
  choose('Назва шаблону', 'Новий шаблон'); fireEvent.click(screen.getByText('Додаткові налаштування')); choose('Сталий ключ (латиниця, цифри, _ або -)', 'pr4-form');
  click('Створити й зберегти чернетку'); await screen.findByText(/Збережено · ревізія/);
  expect(api.create).toHaveBeenCalledWith({ key: 'pr4-form', displayName: 'Новий шаблон', definition: baseline() });
  expect(api.publish).not.toHaveBeenCalled(); expect(api.select).not.toHaveBeenCalled();
});
it('unchanged rendered editor saves exact definition/hash and transport-safe revision', async () => {
  const f = family(); api.list.mockResolvedValue(response({ templates: [{ ...f, draft_revision: f.draft.revision }] })); api.get.mockResolvedValue(response(f)); api.save.mockResolvedValue(response(f.draft));
  page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); await screen.findByText(/Збережено · ревізія/);
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
  page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); await screen.findByLabelText('Категорія');
  choose('Колонка', 'meta_title'); choose('Значення', 'Локальні зміни'); click('Зберегти чернетку');
  await screen.findByText(/На сервері вже новіша чернетка/); expect(screen.getByLabelText('Значення', { exact: true }).value).toBe('Локальні зміни');
  expect(api.get).toHaveBeenCalledTimes(1); expect(api.save).toHaveBeenCalledTimes(1);
});
it('reversed family loads cannot replace a newer selection', async () => {
  const first = deferred(); const second = deferred(); api.list.mockResolvedValue(response({ templates: [family('a'), family('b')] }));
  api.get.mockImplementation((id) => id === 'a' ? first.promise : second.promise);
  page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', 'a'); choose('Шаблон', 'b');
  await act(async () => second.resolve(response(family('b'))));
  await act(async () => first.resolve(response(family('a'))));
  expect(screen.getByText(/Шаблон b/)).toBeTruthy(); expect(screen.queryByText(/Шаблон a/)).toBeNull();
});
it('edits invalidate late validation and draft preview; publication sends only exact saved revision/hash', async () => {
  const f = family(); const validation = deferred(); api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f)); api.validate.mockReturnValue(validation.promise);
  page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); await screen.findByLabelText('Категорія');
  click('Перевірити збережену ревізію'); choose('Колонка', 'meta_title'); choose('Значення', 'Пізніші зміни');
  await act(async () => validation.resolve(response({ valid: true, revision: f.draft.revision })));
  expect(screen.queryByText(/Сервер перевірив ревізію/)).toBeNull();
  click('Версії'); expect(screen.getByRole('button', { name: 'Опублікувати версію' }).disabled).toBe(true);
  click('Відкинути локальні зміни');
  api.publish.mockResolvedValue(response({ id: 'version', versionNumber: '1', sourceDraftRevision: f.draft.revision, definition: f.draft.definition }));
  click(`Опублікувати ревізію ${f.draft.revision}`); await waitFor(() => expect(api.publish).toHaveBeenCalledWith(f.id, { expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash }));
});
it('published view is read-only and clones with existing revision, selection uses exact generation', async () => {
  const f = family(); f.versions = [{ id: 'version', versionNumber: '2', definition: f.draft.definition, definitionHash: f.draft.definitionHash }];
  api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f)); api.clone.mockResolvedValue(response({ ...f.draft, revision: '9007199254740994' }));
  page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); click('Версії'); await screen.findByLabelText('Версія'); choose('Версія', 'version');
  choose('Колонка', 'meta_title'); expect(screen.getByLabelText('Значення', { exact: true }).closest('fieldset').disabled).toBe(true);
  expect(screen.getByLabelText('Значення', { exact: true }).matches(':disabled')).toBe(true);
  api.select.mockResolvedValue(response({ generation: '9007199254740996', implementation: 'template', templateVersionId: 'version' }));
  click('Вибрати відкриту публікацію v2'); await waitFor(() => expect(api.select).toHaveBeenCalledWith({ expectedGeneration: '9007199254740995', implementation: 'template', templateVersionId: 'version' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Створити чернетку з цієї версії' }).disabled).toBe(false));
  click('Копіювати публікацію в чернетку'); await waitFor(() => expect(api.clone).toHaveBeenCalledWith(f.id, { expectedRevision: '9007199254740993', versionId: 'version' }));
});
it('direct forbidden navigation issues no definition/source requests; delegated view+publish works independently', async () => {
  const view = page(['exports.view', 'export_templates.manage']); expect(screen.getByText(/Немає дозволу/)).toBeTruthy(); expect(api.list).not.toHaveBeenCalled(); expect(api.sources).not.toHaveBeenCalled();
  view.unmount(); const f = family(); api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f));
  const allowed = page(['export_templates.view', 'export_templates.publish']); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); await screen.findByLabelText('Категорія');
  expect(screen.queryByRole('button', { name: 'Зберегти чернетку' })).toBeNull(); expect(api.sources).not.toHaveBeenCalled(); click('Версії'); expect(screen.getByRole('button', { name: 'Опублікувати версію' }).disabled).toBe(false);
  allowed.rerender(<AuthContext.Provider value={{ permissions: [] }}><ExportTemplatesPage /></AuthContext.Provider>);
  expect(screen.getByText(/Немає дозволу/)).toBeTruthy(); expect(api.list).toHaveBeenCalledTimes(1);
});
it('draft preview validates explicit ID list, displays server diagnostics and never creates a snapshot token', async () => {
  const f = family(); api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f));
  api.preview.mockResolvedValue(response({ revision: f.draft.revision, draftOnly: true, result: { representedCount: 1, readyCount: 0, errors: [{ sku: '<script>', fields: [{ field: 'name', message: 'Потрібна назва' }] }] } }));
  page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); await screen.findByLabelText('Категорія');
  click('Перевірка'); choose('ID товарів (1–100, через кому або пробіл)', '1,1'); click('Переглянути тестовий результат'); await screen.findByRole('alert'); expect(api.preview).not.toHaveBeenCalled();
  click('Перевірка'); choose('ID товарів (1–100, через кому або пробіл)', '1'); click('Переглянути тестовий результат'); await screen.findByText(/Результат перевірки · ревізія/);
  expect(api.preview).toHaveBeenCalledWith(f.id, { expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash, productIds: [1] });
  expect(screen.getByText(/<script>: name: Потрібна назва/)).toBeTruthy(); expect(document.querySelector('script')).toBeNull();
});

it('independent BR sample proceeds after full source rejection and keeps publication blockers visibly separate', async () => {
  const f = family(); f.draft.revision = '5';
  const blockers = officeDiagnostics.slice(1);
  api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f));
  api.validate.mockRejectedValue({ response: { data: { code: 'TEMPLATE_SOURCE_INVALID', details: { diagnostics: blockers } } } });
  api.preview.mockResolvedValue(response({ revision: '5', definitionHash: f.draft.definitionHash, draftOnly: true, publicationReady: false,
    sampleProducts: [{ productId: 42, category: 'BR', sku: 'BR-SYNTH' }], globalSourceDiagnostics: blockers,
    result: { representedCount: 1, readyCount: 1, errors: [], artifacts: [{ groupCode: 'BR', groupName: 'Браслети', rowCount: 2, csvContent: '[ТЕСТ] Браслет з натурального бурштину. Колір: Світлий. Арт: BR-SYNTH' }] } }));
  page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); await screen.findByLabelText('Категорія');
  click('Перевірити шаблон'); await screen.findByText(/Шаблон не готовий до публікації/);
  choose('ID товарів (1–100, через кому або пробіл)', '42');
  expect(screen.getByRole('button', { name: 'Переглянути результат', exact: true }).disabled).toBe(false);
  click('Переглянути результат'); await screen.findByText(/Результат перевірки · ревізія 5/);
  const full = screen.getByRole('region', { name: 'Повна перевірка шаблону' });
  expect(within(full).getByText('Непідтверджені value_id: 29, 30, 31')).toBeTruthy();
  const sample = screen.getByRole('region', { name: 'Тест чернетки' });
  expect(within(sample).getByText(/публікація заблокована/)).toBeTruthy();
  expect(within(sample).getByText(/42 · BR · BR-SYNTH/)).toBeTruthy();
  expect(screen.queryByText(/Сервер перевірив ревізію/)).toBeNull();
  expect(api.publish).not.toHaveBeenCalled(); expect(api.select).not.toHaveBeenCalled();
  choose('ID товарів (1–100, через кому або пробіл)', '43');
  expect(within(sample).getByText(/Застарілий результат/)).toBeTruthy();
});

it('sample selection fences late results; a failed new sample cannot leave an old sample marked current', async () => {
  const f = family(); const late = deferred(); api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f));
  api.preview.mockReturnValue(late.promise);
  page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); await screen.findByLabelText('Категорія');
  click('Перевірка'); choose('ID товарів (1–100, через кому або пробіл)', '42'); click('Переглянути результат');
  choose('ID товарів (1–100, через кому або пробіл)', '43');
  await act(async () => late.resolve(response({ revision: f.draft.revision, result: { representedCount: 1, readyCount: 1 } })));
  expect(screen.queryByRole('region', { name: 'Тест чернетки' })).toBeNull();
  api.preview.mockResolvedValueOnce(response({ revision: f.draft.revision, result: { representedCount: 1, readyCount: 1 } }));
  click('Переглянути результат'); await screen.findByRole('region', { name: 'Тест чернетки' });
  api.preview.mockRejectedValueOnce({ response: { data: { code: 'TEMPLATE_SOURCE_INVALID', details: { diagnostics: officeDiagnostics.slice(1) } } } });
  click('Переглянути результат'); await screen.findByText(/Шаблон не готовий до публікації/);
  expect(screen.queryByRole('region', { name: 'Тест чернетки' })).toBeNull();
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
  page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', 'a'); await screen.findByLabelText('Категорія');
  click('Зберегти чернетку'); choose('Шаблон', 'b'); await screen.findByText(/Шаблон b/);
  await act(async () => saved.resolve(response({ ...f.draft, revision: '999' })));
  expect(screen.getByText(/Шаблон b/).textContent).not.toContain('999');
  click('Перевірка'); choose('ID товарів (1–100, через кому або пробіл)', '1'); click('Переглянути тестовий результат');
  choose('Колонка', 'meta_title'); choose('Значення', 'Змінено під час тесту');
  await act(async () => latePreview.resolve(response({ revision: other.draft.revision, result: { representedCount: 1, readyCount: 1 } })));
  expect(screen.queryByText(/Результат перевірки · ревізія/)).toBeNull();
  click('Версії'); expect(screen.getByRole('button', { name: 'Опублікувати версію' }).disabled).toBe(true);
});
it('manage without exports.view cannot issue draft previews; permission denial does not retry', async () => {
  const f = family(); api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f));
  api.save.mockRejectedValue({ response: { status: 403, data: { code: 'INSUFFICIENT_PERMISSION', error: 'Недостатньо прав' } } });
  page(['export_templates.view', 'export_templates.manage']); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); await screen.findByLabelText('Категорія');
  expect(screen.queryByRole('button', { name: 'Переглянути результат' })).toBeNull();
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
  const { router } = page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); await screen.findByText(/Збережено · ревізія/);
  choose('Колонка', 'meta_title'); choose('Значення', '  unsaved exact\n');
  fireEvent.click(screen.getByText('Інший розділ')); await screen.findByRole('dialog'); click('Залишитися');
  expect(screen.getByLabelText('Значення', { exact: true }).value).toBe('  unsaved exact\n');
  api.save.mockRejectedValue({ response: { data: { code: 'TEMPLATE_DRAFT_CONFLICT' } } });
  fireEvent.click(screen.getByText('Інший розділ')); click('Зберегти й перейти');
  await screen.findByText(/На сервері вже новіша чернетка/); expect(router.state.location.pathname).toBe('/admin/export-templates/' + f.id);
  expect(screen.getByRole('dialog')).toBeTruthy(); click('Відкинути й перейти'); await screen.findByText('Інший екран');
  await act(async () => router.navigate(-1)); await screen.findByLabelText('Категорія');
  expect(router.state.location.pathname).toBe('/admin/export-templates/' + f.id);
});

it('successful save completes blocked navigation with exact draft', async () => {
  const f = family(); api.list.mockResolvedValue(response({ templates: [{ ...f, draft_revision: f.draft.revision }] })); api.get.mockResolvedValue(response(f));
  api.save.mockImplementation(async (_id, body) => response({ ...f.draft, revision: '9007199254740994', definition: body.definition }));
  page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); await screen.findByText(/Збережено · ревізія/);
  choose('Колонка', 'meta_title'); choose('Значення', 'exact'); fireEvent.click(screen.getByText('Інший розділ')); click('Зберегти й перейти');
  await screen.findByText('Інший екран'); expect(api.save.mock.calls[0][1].definition.groups[0].rows[0].cells.meta_title.value).toBe('exact');
});

it('unfinished v2 column creation blocks dirty navigation and cannot be silently saved as a completed column', async () => {
  const { upgradeColumns } = require('../../server/src/services/export-templates/column-contract');
  const f = family('column-form', upgradeColumns(baseline()));
  api.list.mockResolvedValue(response({ templates: [{ ...f, draft_revision: f.draft.revision }] })); api.get.mockResolvedValue(response(f));
  const { router } = page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); await screen.findByText(/Збережено · ревізія/);
  click('+ Колонка'); choose('Код колонки CSV', 'pending_color');
  fireEvent.click(screen.getByText('Інший розділ'));
  await screen.findByRole('dialog', { name: 'Незбережені зміни' }); click('Залишитися');
  expect(screen.getByLabelText('Код колонки CSV').value).toBe('pending_color');
  fireEvent.click(screen.getByText('Інший розділ')); click('Зберегти й перейти');
  await screen.findByText(/Спочатку застосуйте або скасуйте/); expect(api.save).not.toHaveBeenCalled(); expect(router.state.location.pathname).toBe('/admin/export-templates/' + f.id);
  click('Залишитися'); click('Скасувати');
  expect(screen.getByText(/Збережено · ревізія/)).toBeTruthy();
  fireEvent.click(screen.getByText('Інший розділ')); await screen.findByText('Інший екран');
});

it('named creation prepares a technical key once, keeps conflicts editable and prevents duplicate submissions', async () => {
  const creating = deferred();
  api.create.mockReturnValueOnce(creating.promise).mockResolvedValueOnce(response(family()));
  page(); await screen.findByText(/Шаблонів ще немає/); click('Створити шаблон');
  await screen.findByLabelText('Назва шаблону'); choose('Назва шаблону', 'Мій каталог');
  expect(screen.queryByLabelText('Категорія')).toBeNull();
  click('Створити й зберегти чернетку'); click('Створити й зберегти чернетку');
  expect(api.create).toHaveBeenCalledTimes(1);
  const body = api.create.mock.calls[0][0]; expect(body.key).toMatch(/^template-[a-f0-9-]+$/);
  expect(body.displayName).toBe('Мій каталог'); expect(body.definition).toEqual(baseline());
  await act(async () => creating.reject({ response: { data: { code: 'TEMPLATE_KEY_CONFLICT', error: 'Ключ зайнятий' } } }));
  await screen.findByText(/Ключ уже зайнятий/); expect(screen.getByLabelText('Назва шаблону').value).toBe('Мій каталог');
  fireEvent.click(screen.getByText('Додаткові налаштування')); choose('Сталий ключ (латиниця, цифри, _ або -)', 'another-key');
  click('Створити й зберегти чернетку'); await screen.findByLabelText('Категорія');
  expect(api.publish).not.toHaveBeenCalled(); expect(api.select).not.toHaveBeenCalled();
});

it('ordinary KL name workflow adds mapped color, edits only this field, saves and inspects exact server revision without advanced rules', async () => {
  const f = family(); api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f));
  api.save.mockImplementation(async (_id, body) => response({ ...f.draft, revision: '9007199254740994', definition: body.definition, definitionHash: hashJsonData(body.definition) }));
  api.preview.mockResolvedValue(response({ revision: '9007199254740994', result: { representedCount: 1, readyCount: 1, errors: [], artifacts: [{ groupCode: 'KL', groupName: 'Кулони', rowCount: 2, csvContent: 'authoritative CSV from API' }] } }));
  page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); await screen.findByLabelText('Категорія');
  choose('Категорія', '2'); choose('Мова', '0'); choose('Колонка', 'name');
  expect(screen.getByRole('heading', { name: 'Назва товару' })).toBeTruthy();
  expect(screen.queryByLabelText('Розділ редактора')).toBeNull();
  expect(screen.getByLabelText('Текст у файлі').value).toContain('{material}');
  click('+ Додати характеристику'); choose('Характеристика', 'KL.color'); choose('Як записувати у файлі', 'klColor'); click('Вставити характеристику');
  choose('Текст у файлі', 'Кулон з {material} бурштину, {color}. Арт: {sku}');
  click('Колір {color}'); choose('Текст для ID 1', '  новий відтінок  ');
  click('Зберегти чернетку'); await screen.findByText('Збережено · ревізія 9007199254740994');
  const edited = api.save.mock.calls[0][1].definition;
  const local = edited.groups[2].rows[0].cells.name;
  expect(edited.tables.klColor).toEqual(f.draft.definition.tables.klColor);
  expect(edited.tables[local.then.slots.color.table]['1']).toBe('  новий відтінок  ');
  expect(edited.bindings).toEqual(f.draft.definition.bindings);
  expect(local.then.slots.material).toEqual(f.draft.definition.bindings.find((b) => b.id === 'KL.nameUa').value.then.slots.material);
  expect(local.then.slots.sku).toEqual({ op: 'ref', id: 'sku' });
  click('Перевірка'); choose('ID товарів (1–100, через кому або пробіл)', '42'); click('Переглянути результат');
  await screen.findByText(/Результат перевірки · ревізія 9007199254740994/);
  expect(api.preview).toHaveBeenCalledWith(f.id, { expectedRevision: '9007199254740994', expectedDefinitionHash: hashJsonData(edited), productIds: [42] });
  expect(screen.getByText(/Товари: 42/)).toBeTruthy(); expect(document.querySelector('pre').textContent).toBe('authoritative CSV from API');
  click('Поля експорту'); choose('Текст у файлі', '  Інший {material}, {color}. {sku}\n'); click('Перевірка');
  expect(screen.getByText(/Застарілий результат/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Переглянути результат', exact: true }).disabled).toBe(true);
  expect(api.publish).not.toHaveBeenCalled(); expect(api.select).not.toHaveBeenCalled();
});

it('SEO editing and column ordering stay in the ordinary inspector; tab and language changes preserve exact draft', async () => {
  const f = family(); api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f)); api.save.mockImplementation(async (_id, body) => response({ ...f.draft, definition: body.definition }));
  page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', f.id); await screen.findByLabelText('Категорія');
  choose('Колонка', 'meta_title'); choose('Значення', '  Точний SEO\n');
  fireEvent.click(screen.getByText('Порядок у файлі')); click('Перемістити колонку вище');
  click('Перевірка'); click('Версії'); click('Поля експорту');
  expect(screen.getByLabelText('Значення', { exact: true }).value).toBe('  Точний SEO\n');
  choose('Мова', '1'); choose('Мова', '0'); click('Зберегти чернетку'); await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
  const result = api.save.mock.calls[0][1].definition;
  expect(result.groups[0].rows[0].cells.meta_title.value).toBe('  Точний SEO\n');
  expect(result.groups[0].columns.indexOf('meta_title')).toBe(f.draft.definition.groups[0].columns.indexOf('meta_title') - 1);
  expect(result.groups[0].rows[1]).toEqual(f.draft.definition.groups[0].rows[1]);
  expect(result.groups.slice(1)).toEqual(f.draft.definition.groups.slice(1));
  expect(screen.queryByLabelText('Розділ редактора')).toBeNull();
});

it('focused tokens support rename, explicit removal and dangling-reference validation', () => {
  let current = baseline();
  function Focused() {
    const [definition, setDefinition] = useState(current);
    return <FieldEditor definition={definition} onChange={(next) => { current = next; setDefinition(next); }} />;
  }
  render(<Focused />); choose('Категорія', '2'); choose('Колонка', 'name'); click('+ Додати характеристику');
  choose('Характеристика', 'KL.color'); choose('Як записувати у файлі', 'klColor'); click('Вставити характеристику');
  expect(screen.getByLabelText('Текст у файлі').checkValidity()).toBe(true);
  click('Колір {color}'); fireEvent.click(screen.getByText('Назва та вилучення характеристики'));
  choose('Назва підстановки', 'shade'); click('Перейменувати й оновити текст');
  expect(screen.getByLabelText('Текст у файлі').value).toContain('{shade}');
  click('Вилучити характеристику та її позначки з тексту');
  expect(current.groups[2].rows[0].cells.name.then.slots.shade).toBeUndefined();
  expect(screen.getByLabelText('Текст у файлі').value).not.toContain('{shade}');
  choose('Текст у файлі', '{unknown}');
  expect(screen.getByLabelText('Текст у файлі').checkValidity()).toBe(false);
  expect(screen.getByRole('alert').textContent).toContain('невідомих назв');
});

it('changing principal discards old workspace and ignores a late family response', async () => {
  const pending = deferred(); api.list.mockResolvedValue(response({ templates: [family()] })); api.get.mockReturnValueOnce(pending.promise).mockRejectedValue(new Error('New principal read denied'));
  const view = page(); await screen.findAllByRole('link', { name: /^Відкрити Шаблон/ }); choose('Шаблон', 'family');
  view.rerender(<AuthContext.Provider value={{ permissions: all, applicationUser: { id: 'different-user' } }}><RouterProvider router={view.router} /></AuthContext.Provider>);
  await act(async () => pending.resolve(response(family())));
  expect(screen.queryByLabelText('Категорія')).toBeNull(); expect(screen.queryByRole('button', { name: 'Зберегти чернетку' })).toBeNull();
});

it('read-only fields allow inspecting characteristics and branches without edit actions or source requests', () => {
  const change = vi.fn(); const original = baseline();
  render(<FieldEditor definition={original} onChange={change} readOnly />);
  choose('Категорія', '2'); choose('Колонка', 'name'); click('Матеріал {material}');
  expect(screen.getByLabelText('Текст для ID 1').matches(':disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: '+ Додати характеристику' })).toBeNull();
  expect(screen.queryByLabelText('Область зміни')).toBeNull();
  click('Інакше');
  expect(screen.getByLabelText('Значення', { exact: true }).matches(':disabled')).toBe(true);
  expect(change).not.toHaveBeenCalled(); expect(api.sources).not.toHaveBeenCalled();
});

it('focused shared mapping warning names the actual consumers before an explicit shared edit', () => {
  let current = baseline();
  function Focused() {
    const [definition, setDefinition] = useState(current);
    return <FieldEditor definition={definition} onChange={(next) => { current = next; setDefinition(next); }} />;
  }
  const original = structuredClone(current); render(<Focused />);
  choose('Категорія', '2'); choose('Колонка', 'name'); choose('Область зміни', 'shared'); click('Матеріал {material}');
  const panel = screen.getByRole('region', { name: 'Налаштування характеристики' });
  expect(within(panel).getByText('Зміна вплине на: BR / база / name; NM / база / name; KL / база / name; CH / база / name.').getAttribute('role')).toBe('note');
  expect(current).toEqual(original);
  choose('Текст для ID 1', 'Спільний матеріал');
  expect(current.tables.materialUa['1']).toBe('Спільний матеріал'); expect(current.groups).toEqual(original.groups);
  expect(current.bindings).toEqual(original.bindings);
});

it('normal saved-draft task searches SKU, selects samples, reads server table and opens source diagnostics without losing edits', async () => {
  const d = baseline(); const name = d.bindings.find((b) => b.id === 'BR.nameUa').value.then;
  name.template = '[ТЕСТ] Браслет з {material} бурштину. Колір: {color}. Арт: {sku}';
  name.slots.color = { op: 'lookup', input: { op: 'semanticKey', input: { op: 'source', id: 'BR.color' } }, table: 'color4', otherwise: { op: 'literal', value: '' } };
  const f = family('fixture', d); f.draft.revision = '5';
  const products = [product('BR', { color: 1 }, { id: 42, full_sku: 'BR2/SYNTHETIC-001' }), product('BR', { color: 4 }, { id: 43, full_sku: 'BR2/SYNTHETIC-002' })];
  api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f));
  api.searchSamples.mockResolvedValue(response({ products: products.map((p) => ({ id: p.id, full_sku: p.full_sku, category: p.category, status: 'active' })), nextOffset: null }));
  const blockers = officeDiagnostics.filter((entry) => entry.sourceId !== 'KL.exact_size');
  api.validate.mockRejectedValue({ response: { data: { code: 'TEMPLATE_SOURCE_INVALID', details: { diagnostics: blockers } } } });
  api.preview.mockResolvedValue(response({ revision: '5', definitionHash: f.draft.definitionHash, draftOnly: true, publicationReady: false, globalSourceDiagnostics: blockers,
    sampleProducts: products.map((p) => ({ productId: p.id, sku: p.full_sku, category: p.category })), result: evaluateBatch(compileDefinition(d), products) }));
  page(); await screen.findByRole('link', { name: 'Відкрити Шаблон fixture' }); choose('Шаблон', f.id);
  await screen.findByLabelText('Категорія'); click('Перевірити шаблон'); await screen.findByRole('region', { name: 'Повна перевірка шаблону' });
  choose('Пошук за SKU', 'BR2/SYNTHETIC'); await screen.findByRole('button', { name: 'Обрати BR2/SYNTHETIC-001' });
  click('Обрати BR2/SYNTHETIC-001'); click('Обрати BR2/SYNTHETIC-002'); click('Переглянути результат');
  await screen.findByRole('region', { name: 'Таблиця результату BR' });
  expect(api.preview).toHaveBeenCalledWith(f.id, { expectedRevision: '5', expectedDefinitionHash: f.draft.definitionHash, productIds: [42, 43] });
  const table = within(screen.getByRole('region', { name: 'Таблиця результату BR' })).getAllByRole('table')[0];
  expect(table.textContent).toContain('[ТЕСТ] Браслет з натурального бурштину. Колір: Світлий. Арт: BR2/SYNTHETIC-001');
  expect(table.textContent).toContain('EN'); expect(screen.getByRole('region', { name: 'Повна перевірка шаблону' }).textContent).toContain('NM.extra');
  fireEvent.click(screen.getAllByRole('button', { name: 'Відкрити поле та джерело AR.size' })[0]);
  await screen.findByRole('heading', { name: 'Розмір картини' });
  expect(screen.getByLabelText('Категорія').value).toBe('4'); expect(screen.getByLabelText('Мова').value).toBe('0');
  expect(screen.getByText('Переглянути джерело').parentElement.open).toBe(true);
  choose('Текст для ID 1', 'Локальна зміна'); click('Перевірка');
  fireEvent.click(screen.getAllByRole('button', { name: 'Відкрити поле та джерело NM.extra' })[0]);
  expect(screen.getByRole('heading', { name: 'Додаткові характеристики намиста' })).toBeTruthy();
  choose('Категорія', '4'); choose('Колонка', 'rozmir_kartyny');
  expect(screen.getByLabelText('Текст для ID 1').value).toBe('Локальна зміна');
  expect(screen.queryByLabelText('Спільне правило')).toBeNull(); expect(api.save).not.toHaveBeenCalled();
});

it('empty registry exposes actual code-backed system tables without writes and explicit copy uses the draft API', async () => {
  api.system.mockResolvedValue(response({ definition: baseline(), kind: 'system' }));
  api.create.mockResolvedValue(response(family()));
  page(); await screen.findByRole('link', { name: 'Відкрити системний профіль' });
  click('Відкрити системний профіль');
  await screen.findByRole('button', { name: 'Створити редаговану копію' });
  expect(api.create).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled();
  expect(screen.getByRole('table').textContent).toContain('store_view_code');
  for (const group of baseline().groups) {
    fireEvent.click(within(screen.getByRole('group', { name: 'Категорії файлів' })).getByRole('button', { name: group.name, exact: true }));
    const table = screen.getByRole('table');
    expect([...table.querySelectorAll('thead code')].map((e) => e.textContent)).toEqual(group.columns);
  }
  click('Створити редаговану копію'); choose('Назва шаблону', 'Explicit synthetic copy');
  click('Створити й зберегти чернетку');
  await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Explicit synthetic copy', definition: baseline() })));
  expect(api.publish).not.toHaveBeenCalled(); expect(api.select).not.toHaveBeenCalled();
});

it('SUPPORT prepares detached HOME v2 changes; cancel is read-only and explicit apply preserves exact columns and invalidates preview', async () => {
  const { homeDefinition, officeEvidence } = require('../../server/test/fixtures/export-source-support');
  const { upgradeSourceSupport } = require('../../server/src/services/export-templates/source-support');
  const d = homeDefinition(); const f = family('support', d);
  const next = upgradeSourceSupport(d, officeEvidence());
  const proposal = { expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash, preparationHash: 'a'.repeat(64),
    definition: next, definitionHash: hashJsonData(next), changed: true, changes: next.sourceSupport.sources, diagnostics: [] };
  api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f));
  api.prepareSupport.mockResolvedValue(response(proposal));
  api.applySupport.mockResolvedValue(response({ ...f.draft, revision: '9007199254740994', definition: next, definitionHash: proposal.definitionHash }));
  api.preview.mockResolvedValue(response({ revision: f.draft.revision, result: evaluateBatch(compileDefinition(d), [product('BR')]) }));
  page(); await screen.findByRole('link', { name: 'Відкрити Шаблон support' }); choose('Шаблон', f.id);
  await screen.findByText(/Збережено · ревізія/); click('Перевірка'); choose('ID товарів (1–100, через кому або пробіл)', '1'); click('Переглянути результат');
  await screen.findByRole('region', { name: 'Тест чернетки' });
  click('Підготувати оновлення підтримки джерел'); await screen.findByText(/Чернетку ще не змінено/);
  expect(api.prepareSupport).toHaveBeenCalledWith(f.id, { expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash });
  expect(api.save).not.toHaveBeenCalled(); expect(api.applySupport).not.toHaveBeenCalled();
  click('Скасувати оновлення'); expect(screen.queryByText(/Чернетку ще не змінено/)).toBeNull();
  click('Підготувати оновлення підтримки джерел'); await screen.findByText(/Чернетку ще не змінено/);
  click('Застосувати оновлення підтримки джерел'); await screen.findByText(/Збережено · ревізія 9007199254740994/);
  expect(api.applySupport).toHaveBeenCalledWith(f.id, { expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash, preparationHash: proposal.preparationHash });
  expect(screen.queryByRole('region', { name: 'Тест чернетки' })).toBeNull();
  click('Поля експорту');
  expect([...screen.getByRole('table').querySelectorAll('thead code')].map((e) => e.textContent)).toEqual(d.groups[0].columns);
  expect(screen.getByRole('table').textContent).toContain('test_export_note');
  expect(api.publish).not.toHaveBeenCalled(); expect(api.select).not.toHaveBeenCalled();
});

it('SUPPORT conflicts retain saved v2 input; local pending column work disables preparation', async () => {
  const { homeDefinition, officeEvidence } = require('../../server/test/fixtures/export-source-support');
  const { upgradeSourceSupport } = require('../../server/src/services/export-templates/source-support');
  const d = homeDefinition(); const f = family('support', d); const next = upgradeSourceSupport(d, officeEvidence());
  api.list.mockResolvedValue(response({ templates: [f] })); api.get.mockResolvedValue(response(f));
  api.prepareSupport.mockResolvedValue(response({ expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash, preparationHash: 'a'.repeat(64), changed: true, changes: next.sourceSupport.sources }));
  api.applySupport.mockRejectedValue({ response: { data: { code: 'TEMPLATE_DRAFT_CONFLICT' } } });
  page(); await screen.findByRole('link', { name: 'Відкрити Шаблон support' }); choose('Шаблон', f.id);
  await screen.findByText(/Збережено · ревізія/); click('Перевірка');
  click('Підготувати оновлення підтримки джерел'); await screen.findByText(/Чернетку ще не змінено/); click('Застосувати оновлення підтримки джерел');
  await screen.findByText(/На сервері вже новіша чернетка/);
  expect(api.save).not.toHaveBeenCalled(); expect(screen.getByText(/Збережено · ревізія/).textContent).toContain(f.draft.revision);
  click('Поля експорту'); choose('Колонка', 'test_export_note');
  const value = screen.getByDisplayValue('ПЕРЕВІРКА'); fireEvent.change(value, { target: { value: 'ЛОКАЛЬНЕ' } });
  expect(api.save).not.toHaveBeenCalled();
  // Opening the check tab is protected by the existing local-panel navigation guard.
  click('Перевірка');
  expect(api.prepareSupport).toHaveBeenCalledTimes(1);
  expect(screen.getByDisplayValue('ЛОКАЛЬНЕ')).toBeTruthy();
});

it('SUPPORT new candidate policy is explicit and read-only; the name survives the selection', async () => {
  const { officeEvidence } = require('../../server/test/fixtures/export-source-support');
  const { upgradeSourceSupport } = require('../../server/src/services/export-templates/source-support');
  const next = upgradeSourceSupport(baseline(), officeEvidence());
  api.candidate.mockImplementation((policy) => Promise.resolve(response({ definition: policy ? next : baseline(), diagnostics: [] })));
  page(); await screen.findByText(/Шаблонів ще немає/); click('Створити шаблон'); await screen.findByText('Новий шаблон');
  choose('Назва шаблону', 'Synthetic explicit policy');
  const checkbox = screen.getByRole('checkbox', { name: /Історична підтримка NM/ });
  expect(checkbox.checked).toBe(false); fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.checked).toBe(true));
  expect(api.candidate).toHaveBeenLastCalledWith('historical-source-support-v1');
  expect(screen.getByLabelText('Назва шаблону').value).toBe('Synthetic explicit policy');
  expect(api.create).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled();
});
