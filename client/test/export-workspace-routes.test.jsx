import { createRequire } from 'node:module';
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workspace } from '../src/router';
import { AuthContext, useAuth } from '../src/auth/auth-context';
import { AuthProvider } from '../src/auth/AuthProvider';
import { AuthGate } from '../src/auth/AuthGate';
import { exportsApi as exports } from '../src/api/exports-api';
import { exportSessionsApi as sessions } from '../src/api/export-sessions-api';
import { exportTemplatesApi as templates } from '../src/api/export-templates-api';
import { productsApi } from '../src/api/products-api';

vi.mock('../src/api/exports-api', async (original) => {
  const module = await original(); return { ...module, exportsApi: Object.fromEntries(Object.keys(module.exportsApi).map((key) => [key, vi.fn()])) };
});
vi.mock('../src/api/export-sessions-api', async (original) => {
  const module = await original(); return { ...module, exportSessionsApi: Object.fromEntries(Object.keys(module.exportSessionsApi).map((key) => [key, vi.fn()])) };
});
vi.mock('../src/api/export-templates-api', async (original) => {
  const module = await original(); return { ...module, exportTemplatesApi: Object.fromEntries(Object.keys(module.exportTemplatesApi).map((key) => [key, vi.fn()])) };
});
vi.mock('../src/api/products-api', async (original) => {
  const module = await original(); return { ...module, productsApi: Object.fromEntries(Object.keys(module.productsApi).map((key) => [key, vi.fn()])) };
});
vi.mock('../src/lib/download', () => ({ downloadBlob: vi.fn() }));
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { catalog } = require('../../server/test/fixtures/magento-v1/contract');
const response = (data) => ({ data, headers: {} });
const exporter = ['exports.view', 'exports.create', 'products.view'];
const admin = [...exporter, 'export_templates.view', 'export_templates.manage', 'export_templates.publish', 'export_templates.activate'];
const session = { id: 'saved-a', title: 'Збережений каталог', settings: { requestContract: 'template-v1', mode: 'new', selection: { mode: 'active' } }, configurationRevision: '7', accessEpoch: 'owner', isOwner: true, ownerName: 'Олена', participants: [], snapshotId: null, currentAttemptId: null };
const preview = { mode: 'new', representedCount: 1, readyCount: 1, errors: [], range: { fromSku: 'BR-A', toSku: 'BR-A' }, artifacts: [] };
const snapshot = { id: 'stored-a', status: 'generated', artifacts: [] };
let family;
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const button = (name) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
const link = (name, nav) => fireEvent.click((nav ? within(screen.getByRole('navigation', { name: nav })) : screen).getByRole('link', { name, exact: true }));
const navigate = async (router, to) => { await act(async () => { await router.navigate(to); }); };
function mount(path = '/exports', permissions = exporter) {
  const auth = { applicationUser: { id: 1 }, principalLifetime: { id: '1', valid: true }, permissions };
  const router = createMemoryRouter([{ path: '*', element: <Workspace /> }], { initialEntries: [path] });
  return { router, auth, ...render(<AuthContext.Provider value={auth}><RouterProvider router={router} /></AuthContext.Provider>) };
}
function noMutations() {
  for (const key of ['createSnapshot', 'confirmSnapshot', 'createPriceSnapshot', 'confirmPriceSnapshot']) expect(exports[key]).not.toHaveBeenCalled();
  for (const key of ['create', 'save', 'prepare', 'generate', 'invite', 'membership']) expect(sessions[key]).not.toHaveBeenCalled();
  for (const key of ['create', 'save', 'clone', 'upgrade', 'applySupport', 'publish', 'select']) expect(templates[key]).not.toHaveBeenCalled();
}
beforeEach(() => {
  for (const api of [exports, sessions, templates, productsApi]) for (const mock of Object.values(api)) mock.mockReset().mockResolvedValue(response({}));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  productsApi.getConfig.mockResolvedValue(response({ categories: {}, questions: {}, options: {} }));
  productsApi.getRecent.mockResolvedValue(response([]));
  exports.getStatus.mockResolvedValue(response({ countSinceLastExport: 1 }));
  exports.getPriceStatus.mockResolvedValue(response({ pendingCount: 1 }));
  exports.getTemplateOptions.mockResolvedValue(response({ versions: [], activeVersionId: null }));
  exports.preview.mockResolvedValue(response(preview));
  exports.createSnapshot.mockResolvedValue(response(snapshot));
  exports.getSnapshot.mockResolvedValue(response(snapshot));
  sessions.list.mockImplementation(async (scope) => response({ items: scope === 'invitations' ? [{ id: session.id, title: session.title, ownerName: session.ownerName, accessEpoch: '2' }] : [session], next: null }));
  sessions.get.mockResolvedValue(response(session));
  family = { id: 'family-a', display_name: 'Каталог A', draft: { revision: '9', definitionHash: 'saved-hash', definition: materializeMagentoV1(catalog()) }, versions: [] };
  templates.list.mockResolvedValue(response({ templates: [family] }));
  templates.get.mockResolvedValue(response(family));
  templates.sources.mockResolvedValue(response({}));
  templates.activation.mockResolvedValue(response({ implementation: 'legacy', generation: '3' }));
  templates.system.mockResolvedValue(response({ definition: family.draft.definition }));
  templates.candidate.mockResolvedValue(response({ definition: family.draft.definition, diagnostics: [] }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('mounts every export destination without commands or admin reads, with native active navigation', async () => {
  const { router } = mount(); await screen.findByText(/1 новий товар очікує/);
  for (const [title, path] of [['Мої експорти', '/exports/sessions'], ['Спільні зі мною', '/exports/shared'], ['Запрошення', '/exports/invitations'], ['Оновлення цін', '/exports/prices'], ['Новий експорт', '/exports']]) {
    const item = within(screen.getByRole('navigation', { name: 'Розділи експорту' })).getByRole('link', { name: title });
    item.focus(); expect(document.activeElement).toBe(item); expect(item.tabIndex).toBe(0);
    fireEvent.click(item); await waitFor(() => expect(router.state.location.pathname).toBe(path));
    expect(item.getAttribute('aria-current')).toBe('page');
  }
  link('Експорт за опублікованим шаблоном'); await screen.findByLabelText('Назва експорту');
  expect(router.state.location.pathname).toBe('/exports/new/template');
  noMutations(); for (const mock of Object.values(templates)) expect(mock).not.toHaveBeenCalled();
  expect(screen.queryByText('Історія файлів')).toBeNull();
});

it('keeps the real product ExportTools and original uncertain operation through product → exports → product', async () => {
  exports.createSnapshot.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(response(snapshot));
  const { router } = mount('/'); await screen.findByRole('heading', { name: 'Експорт товарів у Magento' }, { timeout: 10000 });
  button('Перевірити 1 новий товар'); await screen.findByRole('button', { name: 'Створити файли Magento' });
  button('Створити файли Magento'); await screen.findByText(/response lost/);
  const original = exports.createSnapshot.mock.calls[0];
  link('Експорт', 'Основна навігація'); await screen.findByRole('navigation', { name: 'Розділи експорту' });
  expect(screen.getByRole('button', { name: 'Повторити початкове створення' })).toBeTruthy();
  await navigate(router, -1); await screen.findByRole('heading', { name: 'Amber SKU Manager' });
  expect(exports.createSnapshot).toHaveBeenCalledTimes(1); expect(exports.preview).toHaveBeenCalledTimes(1);
  button('Повторити початкове створення'); await screen.findByText('Файли Magento готові');
  expect(exports.createSnapshot.mock.calls[1]).toEqual(original);
  expect(exports.getStatus).toHaveBeenCalledTimes(1);
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it('list → session → list → same session rereads server state and keeps its URL without prepare/generate', async () => {
  const { router } = mount('/exports/sessions'); await screen.findByText(session.title);
  link('Відкрити / продовжити ' + session.title); await screen.findByLabelText('Назва експорту');
  expect(router.state.location.pathname).toBe('/exports/sessions/saved-a');
  await navigate(router, -1); await screen.findByText(session.title);
  sessions.get.mockResolvedValue(response({ ...session, title: 'Змінено на сервері', configurationRevision: '8' }));
  await navigate(router, 1); await screen.findByRole('heading', { name: 'Змінено на сервері' });
  expect(screen.getByLabelText('Назва експорту').value).toBe('Змінено на сервері');
  expect(sessions.get.mock.calls).toEqual([['saved-a'], ['saved-a']]); noMutations();
});

it('old session permalink still requires explicit current-account opening; invitations disclose only minimal metadata', async () => {
  const { router } = mount('/exports/sessions/saved-a');
  await screen.findByRole('button', { name: 'Відкрити експорт із посилання через мій обліковий запис' });
  expect(sessions.get).not.toHaveBeenCalled(); noMutations();
  button('Відкрити експорт із посилання через мій обліковий запис'); await screen.findByLabelText('Назва експорту');
  await navigate(router, '/exports/invitations'); await screen.findByText(session.title);
  expect(screen.queryByLabelText('Назва експорту')).toBeNull();
  expect(screen.queryByText(/Ревізія 7/)).toBeNull(); expect(screen.queryByText('Учасники')).toBeNull();
  expect(sessions.get).toHaveBeenCalledTimes(1); noMutations();
});

it('view-only exporter can preview/read but cannot create or confirm; direct admin deep links issue no reads', async () => {
  const { router } = mount('/exports', ['exports.view']); await screen.findByText(/1 новий товар очікує/);
  button('Перевірити 1 новий товар'); const create = await screen.findByRole('button', { name: 'Створити файли Magento' }); expect(create.disabled).toBe(true);
  await navigate(router, '/exports/prices'); expect(screen.getByRole('button', { name: 'Експортувати зміни цін' }).disabled).toBe(true);
  await navigate(router, '/exports/new/template'); await screen.findByText(/Немає дозволу на створення/);
  for (const path of ['/admin/export-templates', '/admin/export-templates/system', '/admin/export-templates/family-a/check']) {
    await navigate(router, path); await screen.findByText('Немає дозволу на перегляд шаблонів експорту');
  }
  for (const mock of Object.values(templates)) expect(mock).not.toHaveBeenCalled(); noMutations();
});

it('template URLs open table/check/versions and system read-only without publish/activation on mount', async () => {
  const { router } = mount('/admin/export-templates/family-a/check', admin);
  await screen.findByRole('heading', { name: 'Перевірка шаблону' });
  link('Версії', 'Розділи шаблону'); await screen.findByRole('heading', { name: 'Версії шаблону' });
  await navigate(router, -1); expect(screen.getByRole('link', { name: 'Перевірка', exact: true }).getAttribute('aria-current')).toBe('page');
  await navigate(router, 1); await navigate(router, '/admin/export-templates/system'); await screen.findByText('Magento — поточний системний');
  expect(templates.get).toHaveBeenCalledTimes(1); expect(templates.system).toHaveBeenCalledTimes(1); noMutations();
});

it.each(['publish', 'activate'])('%s-only template capability retains independent controls on direct versions URL', async (capability) => {
  family.versions = [{ id: 'v1', versionNumber: '1', definition: family.draft.definition }];
  mount('/admin/export-templates/family-a/versions' + (capability === 'activate' ? '?version=v1' : ''), ['export_templates.view', 'export_templates.' + capability]);
  await screen.findByRole('heading', { name: 'Версії шаблону' });
  expect(templates.sources).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Зберегти чернетку' })).toBeNull();
  if (capability === 'publish') {
    expect(screen.getByRole('button', { name: 'Опублікувати версію' }).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Скасувати вибір шаблону' })).toBeNull();
  } else {
    expect(screen.getByRole('button', { name: 'Вибрати відкриту публікацію v1' }).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Опублікувати версію' })).toBeNull();
  }
  noMutations();
});

it('dirty draft survives local back/forward; Stay, failed Save, successful Save and Discard guard definition changes', async () => {
  const { router } = mount('/admin/export-templates/family-a', admin);
  await screen.findByLabelText('Категорія'); button('Налаштувати колонку meta_title');
  fireEvent.change(screen.getByLabelText('Значення', { exact: true }), { target: { value: '  точний текст\n' } });
  link('Перевірка', 'Розділи шаблону'); link('Версії', 'Розділи шаблону');
  await navigate(router, -1); await navigate(router, -1); await navigate(router, 1); await navigate(router, -1);
  expect(screen.getByLabelText('Значення', { exact: true }).value).toBe('  точний текст\n');
  const leave = screen.getByRole('link', { name: 'Експорт', exact: true }); leave.focus(); fireEvent.click(leave);
  const dialog = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  const background = leave.closest('.app-shell').parentElement;
  expect(background.inert).toBe(true);
  let inertOnRestore;
  leave.addEventListener('focus', () => { inertOnRestore = Boolean(background.inert); }, { once: true });
  button('Залишитися'); expect(inertOnRestore).toBe(false);
  expect(document.activeElement).toBe(leave); expect(router.state.location.pathname).toBe('/admin/export-templates/family-a');
  templates.save.mockRejectedValueOnce(new Error('save conflict'));
  fireEvent.click(leave); button('Зберегти й перейти'); await screen.findByText('save conflict');
  expect(router.state.location.pathname).toBe('/admin/export-templates/family-a');
  button('Залишитися');
  templates.save.mockImplementation(async (_id, body) => response({ ...family.draft, definition: body.definition, revision: '10' }));
  fireEvent.click(leave); button('Зберегти й перейти'); await screen.findByRole('navigation', { name: 'Розділи експорту' });
  expect(templates.save.mock.calls[1][1].definition.groups[0].rows[0].cells.meta_title.value).toBe('  точний текст\n');
  await navigate(router, -1); await screen.findByLabelText('Категорія'); button('Налаштувати колонку meta_title');
  fireEvent.change(screen.getByLabelText('Значення', { exact: true }), { target: { value: 'discard this' } });
  await navigate(router, 1); await screen.findByRole('dialog'); button('Відкинути й перейти');
  await screen.findByRole('navigation', { name: 'Розділи експорту' }); expect(templates.save).toHaveBeenCalledTimes(2);
  expect(templates.publish).not.toHaveBeenCalled(); expect(templates.select).not.toHaveBeenCalled();
});

it('pending column input blocks local deep links and browser back without losing the inspector', async () => {
  const { upgradeColumns } = require('../../server/src/services/export-templates/column-contract');
  family.draft.definition = upgradeColumns(family.draft.definition);
  const { router } = mount('/admin/export-templates/family-a', admin);
  await screen.findByLabelText('Категорія');
  link('Перевірка', 'Розділи шаблону'); link('Поля експорту', 'Розділи шаблону'); button('+ Колонка');
  fireEvent.change(screen.getByLabelText('Код колонки CSV'), { target: { value: 'pending_note' } });
  await navigate(router, -1); await screen.findByRole('dialog', { name: 'Незбережені зміни' }); button('Залишитися');
  expect(screen.getByLabelText('Код колонки CSV').value).toBe('pending_note');
  await navigate(router, '/admin/export-templates/family-a/versions'); button('Зберегти й перейти');
  await screen.findByText(/Спочатку застосуйте або скасуйте/); expect(templates.save).not.toHaveBeenCalled();
  button('Залишитися'); expect(screen.getByLabelText('Код колонки CSV').value).toBe('pending_note');
  await navigate(router, '/admin/export-templates/family-a/check'); button('Відкинути й перейти');
  await screen.findByRole('heading', { name: 'Перевірка шаблону' }); noMutations();
});

it('dirty session navigation keeps revision and fields until explicit Save or Discard', async () => {
  const { router } = mount('/exports/sessions'); await screen.findByText(session.title);
  link('Відкрити / продовжити ' + session.title); await screen.findByLabelText('Назва експорту');
  fireEvent.change(screen.getByLabelText('Назва експорту'), { target: { value: '  local session  ' } });
  await navigate(router, -1); await screen.findByRole('dialog'); button('Залишитися');
  expect(screen.getByLabelText('Назва експорту').value).toBe('  local session  ');
  sessions.save.mockResolvedValue(response({ ...session, title: '  local session  ', configurationRevision: '8' }));
  link('Спільні зі мною', 'Розділи експорту'); button('Зберегти й перейти');
  await waitFor(() => expect(router.state.location.pathname).toBe('/exports/shared'));
  expect(sessions.save).toHaveBeenCalledWith('saved-a', { title: '  local session  ', settings: session.settings, expectedRevision: '7', expectedAccessEpoch: 'owner' });
  expect(sessions.prepare).not.toHaveBeenCalled(); expect(sessions.generate).not.toHaveBeenCalled();
});

it('saving a new session at the dirty guard follows the requested destination and creates metadata only', async () => {
  sessions.create.mockResolvedValue(response(session));
  const { router } = mount('/exports/new/template'); await screen.findByLabelText('Назва експорту');
  fireEvent.change(screen.getByLabelText('Назва експорту'), { target: { value: 'Explicit saved draft' } });
  link('Мої експорти', 'Розділи експорту'); await screen.findByRole('dialog'); button('Зберегти й перейти');
  await waitFor(() => expect(router.state.location.pathname).toBe('/exports/sessions'));
  expect(sessions.create).toHaveBeenCalledTimes(1); expect(sessions.get).not.toHaveBeenCalled();
  expect(sessions.prepare).not.toHaveBeenCalled(); expect(sessions.generate).not.toHaveBeenCalled();
});

it('view-only session result can be reopened, but confirmation remains disabled', async () => {
  sessions.get.mockResolvedValue(response({ ...session, snapshotId: snapshot.id }));
  mount('/exports/sessions/saved-a', ['exports.view']);
  await screen.findByRole('button', { name: 'Відкрити експорт із посилання через мій обліковий запис' });
  button('Відкрити експорт із посилання через мій обліковий запис');
  await screen.findByText('Файли Magento готові');
  expect(screen.getByRole('button', { name: 'Завершити експорт' }).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Створити свій експорт' })).toBeNull(); noMutations();
});

it('export denied routes fetch no status, private session or template metadata', async () => {
  const { router } = mount('/exports/sessions/saved-a', []); await screen.findByText('Немає дозволу на перегляд експорту');
  await navigate(router, '/exports/invitations'); await navigate(router, '/exports');
  for (const api of [exports, sessions, templates]) for (const mock of Object.values(api)) expect(mock).not.toHaveBeenCalled();
});

let observedAuth;
function ObserveAuth() { const auth = useAuth(); useEffect(() => { observedAuth = auth; }, [auth]); return null; }
const authSession = (id, permissions = exporter) => ({ identity: { issuer: 'test', sub: 'subject-' + id }, applicationUser: { id, status: 'active' }, csrfToken: 'csrf-' + id, permissions, roles: [] });
function authenticated() {
  const client = { get: vi.fn().mockResolvedValue(response(authSession(1))) };
  const router = createMemoryRouter([{ path: '*', element: <Workspace /> }], { initialEntries: ['/exports'] });
  render(<AuthProvider apiClient={client} bindApiAuth={() => () => {}}><ObserveAuth /><AuthGate><RouterProvider router={router} /></AuthGate></AuthProvider>);
  return { client, router };
}
it('same-user refresh keeps the original pending request across subroutes; permission loss clears create authority', async () => {
  exports.createSnapshot.mockRejectedValueOnce(new Error('unknown')).mockResolvedValueOnce(response(snapshot));
  const { client, router } = authenticated(); await screen.findByText(/1 новий товар очікує/);
  button('Перевірити 1 новий товар'); await screen.findByRole('button', { name: 'Створити файли Magento' }); button('Створити файли Magento'); await screen.findByText(/unknown/);
  await navigate(router, '/exports/prices'); await act(async () => observedAuth.refresh()); await navigate(router, '/exports');
  button('Повторити початкове створення'); await screen.findByText('Файли Magento готові');
  expect(exports.createSnapshot.mock.calls[1]).toEqual(exports.createSnapshot.mock.calls[0]);
  client.get.mockResolvedValue(response(authSession(1, ['exports.view']))); await act(async () => observedAuth.refresh());
  expect(screen.queryByText('Файли Magento готові')).toBeNull(); noTemplateReads();
});
function noTemplateReads() { for (const mock of Object.values(templates)) expect(mock).not.toHaveBeenCalled(); }
it.each([{ ids: [2] }, { ids: [2, 1] }])('principal transition $ids fences a late operation across the new routes', async ({ ids }) => {
  const late = deferred(); exports.createSnapshot.mockReturnValueOnce(late.promise);
  const { client, router } = authenticated(); await screen.findByText(/1 новий товар очікує/);
  button('Перевірити 1 новий товар'); await screen.findByRole('button', { name: 'Створити файли Magento' }); button('Створити файли Magento');
  await navigate(router, '/exports/sessions');
  for (const id of ids) { client.get.mockResolvedValue(response(authSession(id))); await act(async () => observedAuth.refresh()); }
  await navigate(router, '/exports'); await act(async () => late.resolve(response(snapshot)));
  expect(screen.queryByText('Файли Magento готові')).toBeNull(); expect(screen.queryByRole('button', { name: 'Повторити початкове створення' })).toBeNull();
  expect(exports.createSnapshot).toHaveBeenCalledTimes(1); expect(exports.getSnapshot).not.toHaveBeenCalled(); noTemplateReads();
});
