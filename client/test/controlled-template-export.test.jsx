import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Link, Route, Routes } from 'react-router-dom';
import { useProductExportController } from '../src/hooks/product/useProductExportController';
import { ExportWorkflowProvider } from '../src/hooks/product/export-workflow-context';
import { ExportTools } from '../src/components/app/ExportTools';
import { AuthContext, useAuth } from '../src/auth/auth-context';
import { AuthProvider } from '../src/auth/AuthProvider';
import { AuthGate } from '../src/auth/AuthGate';
import { useExportWorkflow } from '../src/hooks/product/useExportWorkflow';
import { exportsApi } from '../src/api/exports-api';
import { downloadBlob } from '../src/lib/download';
vi.mock('../src/api/exports-api', () => ({ exportsApi: Object.fromEntries(['previewPrices', 'getPriceSnapshot', 'readPriceArtifact', 'readMagentoArtifact', 'getSnapshot', 'getStatus', 'getTemplateOptions', 'getPriceStatus', 'preview', 'createSnapshot', 'confirmSnapshot', 'downloadMagentoArtifact', 'createPriceSnapshot', 'downloadPriceSnapshot', 'confirmPriceSnapshot'].map((key) => [key, vi.fn()])) }));
vi.mock('../src/lib/download', () => ({ downloadBlob: vi.fn() }));
const response = (data) => ({ data, headers: {} });
const template = { versionId: 'version-a', templateId: 'family-a', definitionHash: 'a'.repeat(64) };
const preview = (extra = {}) => ({ mode: 'new', representedCount: 1, readyCount: 1, errors: [], range: { fromSku: 'BR-A', toSku: 'BR-A' }, artifacts: [], ...extra });
const snapshot = { id: 'snapshot-a', status: 'generated', template, artifacts: [{ groupCode: 'BR', groupName: 'Браслети', rowCount: 2, productCount: 1, fileName: 'stored.csv' }] };
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; };
let controller;
// Exercise the retained direct PR3/legacy controller independently of the new
// durable-session product UI, which has its own server-backed lifecycle suite.
function ExportsPage() {
  const workflow = useExportWorkflow();
  const { permissions } = useAuth();
  return <ExportTools {...workflow} canArchive={false} canViewExport canCreateExport={permissions.includes('exports.create')}
    onPreviewExport={workflow.handlePreviewExport} onCreateSnapshot={workflow.handleCreateSnapshot}
    onDownloadMagentoArtifact={workflow.handleDownloadMagentoArtifact} onConfirmSnapshot={workflow.handleConfirmSnapshot}
    onPriceExportCsv={workflow.handlePriceExportCsv} />;
}
function Harness() {
  const current = useProductExportController();
  useEffect(() => { controller = current; }, [current]);
  return <ExportTools {...current} canArchive={false} canActivateTemplate
    onPreviewExport={current.handlePreviewExport} onCreateSnapshot={current.handleCreateSnapshot}
    onDownloadMagentoArtifact={current.handleDownloadMagentoArtifact} onConfirmSnapshot={current.handleConfirmSnapshot}
    onPriceExportCsv={current.handlePriceExportCsv} />;
}
const click = (name) => fireEvent.click(screen.getByRole('button', { name }));
const optIn = () => fireEvent.click(screen.getByRole('checkbox', { name: /Контрольований експорт/ }));
async function start() { click(/Перевірити 1 новий товар/); await screen.findByRole('button', { name: /Створити файли/ }); }
beforeEach(() => {
  vi.clearAllMocks(); for (const mock of Object.values(exportsApi)) mock.mockReset();
  exportsApi.getStatus.mockResolvedValue(response({ countSinceLastExport: 1, activation: { implementation: 'template', templateVersionId: 'selected' } }));
  exportsApi.getPriceStatus.mockResolvedValue(response({ pendingCount: 0 }));
  exportsApi.getTemplateOptions.mockResolvedValue(response({ activeVersionId: 'version-a', versions: [{ versionId: 'version-a', templateId: 'family-a', displayName: 'Кандидат A', versionNumber: '2' }] }));
  exportsApi.preview.mockImplementation(async (intent) => response(preview(intent.requestContract ? { requestContract: 'template-v1', intent, template, previewToken: 'opaque-token' } : {})));
  exportsApi.createSnapshot.mockResolvedValue(response(snapshot));
  exportsApi.getSnapshot.mockResolvedValue(response(snapshot));
  exportsApi.readMagentoArtifact.mockResolvedValue(response('sku,store_view_code,name\nBR1,,Stored'));
  exportsApi.previewPrices.mockResolvedValue(response({ rowCount: 1, csvContent: 'sku,price\nBR1,123' }));
  exportsApi.readPriceArtifact.mockResolvedValue(response('sku,price\nBR1,123'));
  exportsApi.getPriceSnapshot.mockResolvedValue(response({ id: 'price-a', status: 'generated', stream: 'price', artifacts: [] }));
  exportsApi.downloadMagentoArtifact.mockResolvedValue(response('stored csv'));
  exportsApi.confirmSnapshot.mockResolvedValue(response({ status: 'confirmed' }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('legacy is default despite selection metadata and retains legacy new-range anchors', async () => {
  render(<Harness />); await screen.findByText(/1 новий товар очікує/); await start();
  expect(exportsApi.preview).toHaveBeenCalledWith({ mode: 'new' }); expect(screen.getByRole('checkbox').checked).toBe(false);
  click(/Створити файли/); await waitFor(() => expect(exportsApi.createSnapshot).toHaveBeenCalled());
  expect(exportsApi.createSnapshot.mock.calls[0][0]).toEqual({ mode: 'new', fromSku: 'BR-A', toSku: 'BR-A' });
});
it('opt-in active preview binds creation to original intent and opaque token, never resolved anchors', async () => {
  render(<Harness />); await screen.findByText(/1 новий товар очікує/); optIn(); await start();
  expect(screen.getByText('Версія: version-a')).toBeTruthy();
  click(/Створити файли/); await waitFor(() => expect(exportsApi.createSnapshot).toHaveBeenCalled());
  expect(exportsApi.createSnapshot.mock.calls[0][0]).toEqual({ mode: 'new', requestContract: 'template-v1', selection: { mode: 'active' }, previewToken: 'opaque-token' });
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});
it('explicit choice is sent exactly, unavailable selection has no legacy fallback', async () => {
  render(<Harness />); await screen.findByText(/1 новий товар очікує/); optIn();
  fireEvent.change(screen.getByLabelText('Вибір публікації'), { target: { value: 'explicit' } });
  fireEvent.change(screen.getByLabelText('ID сімейства шаблону'), { target: { value: 'family-b' } });
  fireEvent.change(screen.getByLabelText('ID опублікованої версії'), { target: { value: 'version-b' } });
  exportsApi.preview.mockRejectedValue({ response: { status: 422, data: { code: 'EXPORT_TEMPLATE_NOT_SELECTED', error: 'Публікація недоступна' } } });
  click(/Перевірити 1 новий товар/); await screen.findByText('Публікація недоступна');
  expect(exportsApi.preview).toHaveBeenCalledTimes(1);
  expect(exportsApi.preview.mock.calls[0][0].selection).toEqual({ mode: 'explicit', templateId: 'family-b', versionId: 'version-b' });
  expect(exportsApi.createSnapshot).not.toHaveBeenCalled();
});
it('uncertain create retains same key/token after selection changes, double clicks and elapsed expiry', async () => {
  const first = deferred(); exportsApi.createSnapshot.mockReturnValueOnce(first.promise).mockResolvedValueOnce(response(snapshot));
  render(<Harness />); await screen.findByText(/1 новий товар очікує/); optIn(); await start();
  click(/Створити файли/); await act(async () => controller.handleCreateSnapshot()); expect(exportsApi.createSnapshot).toHaveBeenCalledTimes(1);
  const original = exportsApi.createSnapshot.mock.calls[0];
  optIn(); // does not replace pending descriptor
  await act(async () => first.reject(new Error('network lost')));
  expect(screen.getByText(/Є незавершена операція/)).toBeTruthy();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600000);
  click('Повторити початкове створення'); await screen.findByText(/ЗБЕРЕЖЕНІ ФАЙЛИ/);
  expect(exportsApi.createSnapshot.mock.calls[1]).toEqual(original);
  expect(exportsApi.preview).toHaveBeenCalledTimes(1);
});
it.each(['EXPORT_PREVIEW_STALE', 'EXPORT_PREVIEW_EXPIRED'])('%s requires explicit fresh preview and a separate new operation', async (code) => {
  exportsApi.createSnapshot.mockRejectedValueOnce({ response: { status: 409, data: { code, error: code } } }).mockResolvedValueOnce(response(snapshot));
  render(<Harness />); await screen.findByText(/1 новий товар очікує/); optIn(); await start(); click(/Створити файли/);
  await screen.findByText(new RegExp(`${code} Оновіть перевірку`)); expect(controller.pendingCreate).toBeNull();
  expect(exportsApi.preview).toHaveBeenCalledTimes(1); await start(); click(/Створити файли/); await screen.findByText(/ЗБЕРЕЖЕНІ ФАЙЛИ/);
  expect(exportsApi.createSnapshot.mock.calls[1][1]).not.toBe(exportsApi.createSnapshot.mock.calls[0][1]);
});
it('ambiguous 5xx and idempotency conflict do not get blanket 409 refresh or replacement keys', async () => {
  exportsApi.createSnapshot.mockRejectedValueOnce({ response: { status: 500, data: { error: 'Unknown' } } })
    .mockRejectedValueOnce({ response: { status: 409, data: { code: 'EXPORT_IDEMPOTENCY_CONFLICT', error: 'Conflict' } } });
  render(<Harness />); await screen.findByText(/1 новий товар очікує/); optIn(); await start(); click(/Створити файли/);
  await screen.findByText(/Unknown Результат/); click('Повторити початкове створення'); await screen.findByText(/Conflict Результат/);
  expect(exportsApi.createSnapshot.mock.calls[1]).toEqual(exportsApi.createSnapshot.mock.calls[0]); expect(exportsApi.preview).toHaveBeenCalledTimes(1);
});
it('late preview after selector edit cannot bind a new create to stale evidence', async () => {
  const late = deferred(); exportsApi.preview.mockReturnValue(late.promise);
  render(<Harness />); await screen.findByText(/1 новий товар очікує/); optIn(); click(/Перевірити 1 новий товар/); optIn();
  await act(async () => late.resolve(response(preview({ previewToken: 'old', template }))));
  expect(controller.exportPreview).toBeNull(); await act(async () => controller.handleCreateSnapshot()); expect(exportsApi.createSnapshot).not.toHaveBeenCalled();
});
it('stored download and failed confirmation retry use snapshot ID after mode/selection changes', async () => {
  exportsApi.confirmSnapshot.mockRejectedValueOnce(new Error('confirmation lost')).mockResolvedValueOnce(response({ status: 'confirmed' }));
  render(<Harness />); await screen.findByText(/1 новий товар очікує/); optIn(); await start(); click(/Створити файли/); await screen.findByText(/ЗБЕРЕЖЕНІ ФАЙЛИ/);
  expect(screen.queryByRole('checkbox')).toBeNull(); await act(async () => controller.setTemplateSelection({ mode: 'explicit', templateId: 'other', versionId: 'other' }));
  await act(async () => controller.handleDownloadMagentoArtifact('BR'));
  expect(exportsApi.downloadMagentoArtifact).toHaveBeenCalledWith('snapshot-a', 'BR'); expect(downloadBlob).toHaveBeenCalled(); expect(exportsApi.confirmSnapshot).not.toHaveBeenCalled();
  click('Завершити експорт'); click('Підтвердити збережений експорт'); await screen.findByText('confirmation lost'); exportsApi.getSnapshot.mockResolvedValue(response({ ...snapshot, status: 'confirmed' })); click('Завершити експорт'); click('Підтвердити збережений експорт'); await screen.findByText('Експорт завершено');
  expect(exportsApi.confirmSnapshot.mock.calls).toEqual([['snapshot-a'], ['snapshot-a']]); expect(exportsApi.createSnapshot).toHaveBeenCalledTimes(1);
});
it('uncertain creation survives route navigation in the mounted workflow provider', async () => {
  exportsApi.createSnapshot.mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(response(snapshot));
  render(<AuthContext.Provider value={{ permissions: ['exports.view', 'exports.create'] }}><MemoryRouter initialEntries={['/exports']}><ExportWorkflowProvider>
    <Link to="/elsewhere">Інший розділ</Link><Link to="/exports">Повернутися</Link><Routes><Route path="/exports" element={<ExportsPage />} /><Route path="/elsewhere" element={<p>Інший екран</p>} /></Routes>
  </ExportWorkflowProvider></MemoryRouter></AuthContext.Provider>);
  await screen.findByText(/1 новий товар очікує/); optIn(); await start(); click(/Створити файли/); await screen.findByText(/lost Результат/);
  fireEvent.click(screen.getByText('Інший розділ')); await screen.findByText('Інший екран'); fireEvent.click(screen.getByText('Повернутися'));
  click('Повторити початкове створення'); await screen.findByText(/ЗБЕРЕЖЕНІ ФАЙЛИ/);
  expect(exportsApi.createSnapshot.mock.calls[1]).toEqual(exportsApi.createSnapshot.mock.calls[0]);
});
it('view-only exporters can preview without admin definition calls, create/activation controls remain disabled', async () => {
  render(<AuthContext.Provider value={{ permissions: ['exports.view'] }}><ExportWorkflowProvider><ExportsPage /></ExportWorkflowProvider></AuthContext.Provider>);
  await screen.findByText(/1 новий товар очікує/); optIn(); click(/Перевірити 1 новий товар/); await screen.findByText('ПОПЕРЕДНІЙ ПЕРЕГЛЯД');
  expect(screen.queryByRole('option', { name: 'Явно вказана опублікована версія' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Створити файли/ })).toBeNull(); expect(exportsApi.createSnapshot).not.toHaveBeenCalled();
});
it('dedicated price commands retain their own identity and never confirm on creation/download', async () => {
  exportsApi.createPriceSnapshot.mockResolvedValue(response({ id: 'price-a', rowCount: 1 }));
  exportsApi.downloadPriceSnapshot.mockResolvedValue(response('sku,price'));
  exportsApi.confirmPriceSnapshot.mockResolvedValue(response({}));
  render(<Harness />); await screen.findByText(/1 новий товар очікує/); optIn();
  await act(async () => controller.priceWorkflow.check());
  await act(async () => controller.priceWorkflow.create());
  expect(exportsApi.confirmPriceSnapshot).not.toHaveBeenCalled(); expect(exportsApi.downloadPriceSnapshot).not.toHaveBeenCalled();
  await act(async () => controller.priceWorkflow.download()); expect(exportsApi.confirmPriceSnapshot).not.toHaveBeenCalled();
  await act(async () => controller.priceWorkflow.confirm());
  expect(exportsApi.confirmPriceSnapshot).toHaveBeenCalledWith('price-a');
  expect(exportsApi.downloadPriceSnapshot).toHaveBeenCalledWith('price-a'); expect(exportsApi.createPriceSnapshot.mock.calls[0]).toHaveLength(1); expect(exportsApi.createSnapshot).not.toHaveBeenCalled();
});
it('a delayed correction refresh handler uses the current mode and range, without stale closure binding', async () => {
  render(<Harness />); await screen.findByText(/1 новий товар очікує/);
  const earlierRefresh = controller.handlePreviewExport;
  optIn();
  await act(async () => { controller.setExportFromSku('br-new'); controller.setExportToSku('br-last'); });
  await act(async () => earlierRefresh('manual'));
  expect(exportsApi.preview).toHaveBeenCalledWith({ fromSku: 'BR-NEW', toSku: 'BR-LAST', requestContract: 'template-v1', selection: { mode: 'active' } });
});

// Component lifecycle evidence only: these tests do not run browser reload or OIDC.
let observedAuth;
let observedWorkflow;
function AuthObserver() {
  const auth = useAuth();
  useEffect(() => { observedAuth = auth; }, [auth]);
  return null;
}
function WorkflowObserver() {
  const workflow = useExportWorkflow();
  useEffect(() => { observedWorkflow = workflow; }, [workflow]);
  return <ExportsPage />;
}
const session = (id) => ({ identity: { issuer: 'https://example.test', sub: `subject-${id}` },
  applicationUser: { id, status: 'active' }, roles: [], permissions: ['exports.view', 'exports.create'], csrfToken: `test-csrf-${id}` });
function authenticatedWorkflow(apiClient, bindApiAuth, locationObject) {
  return <AuthProvider apiClient={apiClient} bindApiAuth={bindApiAuth} locationObject={locationObject}>
    <AuthObserver /><AuthGate><MemoryRouter><ExportWorkflowProvider><WorkflowObserver /></ExportWorkflowProvider></MemoryRouter></AuthGate>
  </AuthProvider>;
}

it.each(['uncertain', 'known'])('full workflow unmount/remount loses %s operation state without automatically creating another export', async (outcome) => {
  if (outcome === 'uncertain') exportsApi.createSnapshot.mockRejectedValueOnce(new Error('response lost'));
  const apiClient = { get: vi.fn().mockResolvedValue(response(session(1))), post: vi.fn() };
  const bindApiAuth = () => () => {};
  const locationObject = { pathname: '/exports', assign: vi.fn() };
  const first = render(authenticatedWorkflow(apiClient, bindApiAuth, locationObject));
  await screen.findByText(/1 новий товар очікує/); optIn(); await start(); click(/Створити файли/);
  await screen.findByText(outcome === 'uncertain' ? /response lost Результат/ : /ЗБЕРЕЖЕНІ ФАЙЛИ/);
  if (outcome === 'uncertain') expect(observedWorkflow.pendingCreate.idempotencyKey).toBe(exportsApi.createSnapshot.mock.calls[0][1]);
  else await waitFor(() => expect(observedWorkflow.exportSnapshot?.id).toBe('snapshot-a'));
  first.unmount();
  render(authenticatedWorkflow(apiClient, bindApiAuth, locationObject));
  await screen.findByText(/1 новий товар очікує/);
  expect(observedWorkflow.pendingCreate).toBeNull();
  expect(observedWorkflow.exportSnapshot).toBeNull();
  expect(observedWorkflow.exportPreview).toBeNull();
  expect(screen.queryByRole('button', { name: 'Повторити початкове створення' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Завершити експорт' })).toBeNull();
  expect(screen.getByRole('checkbox').checked).toBe(false);
  expect(exportsApi.createSnapshot).toHaveBeenCalledTimes(1);
  expect(exportsApi.preview).toHaveBeenCalledTimes(1);
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it.each([1, 2])('successful logout clears pending state; later user %s cannot receive the old late snapshot response', async (nextUser) => {
  const retry = deferred();
  exportsApi.createSnapshot.mockRejectedValueOnce(new Error('response lost')).mockReturnValueOnce(retry.promise);
  const apiClient = { get: vi.fn().mockResolvedValue(response(session(1))), post: vi.fn().mockResolvedValue(response({})) };
  let authHandlers;
  const bindApiAuth = (handlers) => { authHandlers = handlers; return () => {}; };
  const locationObject = { pathname: '/exports', assign: vi.fn() };
  render(authenticatedWorkflow(apiClient, bindApiAuth, locationObject));
  await screen.findByText(/1 новий товар очікує/); optIn(); await start(); click(/Створити файли/);
  await screen.findByText(/response lost Результат/);
  const original = exportsApi.createSnapshot.mock.calls[0];
  click('Повторити початкове створення');
  expect(exportsApi.createSnapshot.mock.calls[1]).toEqual(original);
  await act(async () => observedAuth.logout());
  expect(apiClient.post).toHaveBeenCalledWith('/auth/logout');
  expect(locationObject.assign).toHaveBeenCalledWith('/');
  expect(screen.getByText('Вхід до системи')).toBeTruthy();
  expect(screen.queryByText(/Ключ для звірки/)).toBeNull();
  expect(observedAuth.identity).toBeNull(); expect(observedAuth.csrfToken).toBeNull();
  expect(authHandlers.getCsrfToken()).toBeNull();
  apiClient.get.mockResolvedValue(response(session(nextUser)));
  await act(async () => observedAuth.refresh()); // simulated authenticated /me, not a real login
  await screen.findByText(/1 новий товар очікує/);
  expect(observedAuth.applicationUser.id).toBe(nextUser);
  await act(async () => retry.resolve(response(snapshot)));
  expect(observedWorkflow.pendingCreate).toBeNull(); expect(observedWorkflow.exportSnapshot).toBeNull();
  expect(observedWorkflow.exportPreview).toBeNull();
  expect(screen.queryByText(/ЗБЕРЕЖЕНІ ФАЙЛИ/)).toBeNull();
  expect(exportsApi.createSnapshot).toHaveBeenCalledTimes(2);
  expect(exportsApi.preview).toHaveBeenCalledTimes(1);
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it('active-to-active session refresh clears the previous user pending operation', async () => {
  exportsApi.createSnapshot.mockRejectedValueOnce(new Error('response lost'));
  const apiClient = { get: vi.fn().mockResolvedValue(response(session(1))), post: vi.fn() };
  render(authenticatedWorkflow(apiClient, () => () => {}, { pathname: '/exports', assign: vi.fn() }));
  await screen.findByText(/1 новий товар очікує/); optIn(); await start(); click(/Створити файли/);
  await screen.findByText(/response lost Результат/);
  const firstOperation = observedWorkflow.pendingCreate;
  apiClient.get.mockResolvedValue(response(session(2)));
  await act(async () => observedAuth.refresh());
  expect(observedAuth.applicationUser.id).toBe(2);
  expect(observedWorkflow.pendingCreate).toBeNull();
  expect(screen.queryByText(`Ключ для звірки: ${firstOperation.idempotencyKey}`)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Повторити початкове створення' })).toBeNull();
  expect(exportsApi.createSnapshot).toHaveBeenCalledTimes(1);
});

it('A → B → A never revives the first lifetime, including stale actions and late download/confirm responses', async () => {
  const late = deferred(); exportsApi.downloadMagentoArtifact.mockReturnValue(late.promise);
  const apiClient = { get: vi.fn().mockResolvedValue(response(session(1))), post: vi.fn() };
  render(authenticatedWorkflow(apiClient, () => () => {}, { pathname: '/exports', assign: vi.fn() }));
  await screen.findByText(/1 новий товар очікує/); await start(); click(/Створити файли/); await screen.findByText(/ЗБЕРЕЖЕНІ ФАЙЛИ/);
  const first = observedWorkflow;
  let downloading; await act(async () => { downloading = first.handleDownloadMagentoArtifact('BR'); });
  for (const id of [2,1]) { apiClient.get.mockResolvedValue(response(session(id))); await act(async () => observedAuth.refresh()); }
  await act(async () => { first.handlePreviewExport(); first.handleCreateSnapshot(); first.handleConfirmSnapshot(); first.handlePriceExportCsv(); first.handleDownloadMagentoArtifact('BR'); first.setExportFromSku('PRIVATE'); });
  expect(exportsApi.preview).toHaveBeenCalledTimes(1); expect(exportsApi.createSnapshot).toHaveBeenCalledTimes(1);
  expect(exportsApi.confirmSnapshot).not.toHaveBeenCalled(); expect(exportsApi.createPriceSnapshot).not.toHaveBeenCalled(); expect(exportsApi.downloadMagentoArtifact).toHaveBeenCalledTimes(1);
  await act(async () => { late.resolve(response('old CSV')); await downloading; });
  expect(downloadBlob).not.toHaveBeenCalled(); expect(observedWorkflow.exportSnapshot).toBeNull(); expect(observedWorkflow.exportFromSku).toBe('');
});

it('same-user refresh keeps pending identity; permission loss clears it and fences old dispatch', async () => {
  exportsApi.createSnapshot.mockRejectedValueOnce(new Error('lost'));
  const apiClient = { get: vi.fn().mockResolvedValue(response(session(1))), post: vi.fn() };
  render(authenticatedWorkflow(apiClient, () => () => {}, { pathname: '/exports', assign: vi.fn() }));
  await screen.findByText(/1 новий товар очікує/); optIn(); await start(); click(/Створити файли/); await screen.findByText(/lost Результат/);
  const first = observedWorkflow; const descriptor = first.pendingCreate;
  apiClient.get.mockResolvedValue(response({ ...session(1), csrfToken: 'changed', identity: { sub: 'profile-change', name: 'New name' } }));
  await act(async () => observedAuth.refresh()); expect(observedWorkflow.pendingCreate).toBe(descriptor);
  apiClient.get.mockResolvedValue(response({ ...session(1), permissions: ['exports.view'] })); await act(async () => observedAuth.refresh());
  expect(observedWorkflow.pendingCreate).toBeNull(); await act(async () => first.handleCreateSnapshot()); expect(exportsApi.createSnapshot).toHaveBeenCalledTimes(1);
});
