import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ExportSessionsPage from '../src/pages/ExportSessionsPage';
import { AuthContext } from '../src/auth/auth-context';
import { exportSessionsApi as api } from '../src/api/export-sessions-api';
import { exportsApi } from '../src/api/exports-api';
import { downloadBlob } from '../src/lib/download';
vi.mock('../src/api/export-sessions-api', () => ({ exportSessionsApi: Object.fromEntries(['list','create','get','save','preview','prepare','generate','recipients','invite','membership'].map((k) => [k, vi.fn()])) }));
vi.mock('../src/api/exports-api', () => ({ exportsApi: Object.fromEntries(['getTemplateOptions','getSnapshot','downloadMagentoArtifact','confirmSnapshot'].map((k) => [k, vi.fn()])) }));
vi.mock('../src/lib/download', () => ({ downloadBlob: vi.fn() }));
const response = (data) => ({ data, headers: {} });
const settings = { requestContract: 'template-v1', mode: 'new', selection: { mode: 'active' } };
const own = { id: 'session-a', title: 'Сесія A', settings, configurationRevision: '1', accessEpoch: 'owner', isOwner: true, ownerName: 'Олена', participants: [], currentAttemptId: null, snapshotId: null };
const attempt = { id: 'attempt-a', state: 'prepared', preview: { mode: 'new', representedCount: 1, readyCount: 1, errors: [], artifacts: [] } };
const snapshot = { id: 'snapshot-a', sessionId: 'session-a', accessEpoch: 'owner', status: 'generated', artifacts: [{ groupCode: 'BR', fileName: 'stored.csv', rowCount: 2, productCount: 1 }] };
const deferred = () => { let resolve; let reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise,resolve,reject }; };
const click = (name) => fireEvent.click(screen.queryByRole('button', { name }) || screen.getByRole('link', { name }));
function page(id = 1, path = '/exports/sessions') {
  const auth = { applicationUser: { id }, permissions: ['exports.view','exports.create'], principalLifetime: { id, valid: true } };
  const router = createMemoryRouter([{ path: '/exports/*', element: <Routes><Route path="sessions/:sessionId?" element={<ExportSessionsPage />} /><Route path="new/template" element={<ExportSessionsPage create />} /><Route path="invitations" element={<ExportSessionsPage scope="invitations" />} /><Route path="shared" element={<ExportSessionsPage scope="shared" />} /><Route index element={<p>Legacy workspace</p>} /></Routes> }], { initialEntries: [path] });
  return { ...render(<AuthContext.Provider value={auth}><RouterProvider router={router} /></AuthContext.Provider>), auth, router };
}
beforeEach(() => {
  for (const mock of [...Object.values(api), ...Object.values(exportsApi)]) mock.mockReset();
  api.list.mockResolvedValue(response({ items: [own], next: null })); api.get.mockResolvedValue(response(own));
  exportsApi.getTemplateOptions.mockResolvedValue(response({ versions: [], activeVersionId: null }));
  exportsApi.getSnapshot.mockResolvedValue(response(snapshot)); exportsApi.downloadMagentoArtifact.mockResolvedValue(response('stored CSV'));
  exportsApi.confirmSnapshot.mockResolvedValue(response({ success: true }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('definitive creation validation failure allows correction, while unknown outcome retries the exact descriptor', async () => {
  api.create.mockRejectedValueOnce({ response: { status: 422, data: { error: 'invalid saved range' } } })
    .mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(response(own));
  page(); await screen.findByText('Сесія A'); click('Створити свій експорт');
  fireEvent.change(screen.getByLabelText('Назва експорту'), { target: { value: 'Initial title' } }); click('Створити приватний експорт');
  await screen.findByText('invalid saved range');
  expect(screen.getByLabelText('Назва експорту').closest('fieldset').disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Назва експорту'), { target: { value: 'Corrected title' } }); click('Створити приватний експорт');
  await screen.findByText(/lost response/); expect(screen.getByLabelText('Назва експорту').closest('fieldset').disabled).toBe(true);
  click('Повторити створення цього експорту'); await screen.findByRole('heading', { name: 'Сесія A' });
  expect(api.create.mock.calls[1][0]).toEqual(api.create.mock.calls[2][0]);
  expect(api.create.mock.calls[0][0].creationKey).not.toBe(api.create.mock.calls[1][0].creationKey);
});

it('explicit private create persists before prepare/generate and a remount resumes exact stored result without automatic mutation', async () => {
  api.create.mockResolvedValue(response(own)); api.prepare.mockResolvedValue(response(attempt));
  api.generate.mockImplementation(async () => { api.get.mockResolvedValue(response({ ...own, currentAttemptId: attempt.id, attempt: { ...attempt, state: 'succeeded' }, snapshotId: snapshot.id })); throw new Error('lost response'); });
  const first = page(); await screen.findByText('Сесія A'); click('Створити свій експорт');
  fireEvent.change(screen.getByLabelText('Назва експорту'), { target: { value: 'Приватний' } }); click('Створити приватний експорт');
  await screen.findByRole('heading', { name: 'Сесія A' }); expect(api.create.mock.calls[0][0].title).toBe('Приватний'); expect(api.generate).not.toHaveBeenCalled();
  api.get.mockResolvedValue(response({ ...own, currentAttemptId: attempt.id, attempt }));
  click('Підготувати збережену спробу'); await screen.findByText(/Підготовлено — очікує/); click('Створити файли цієї спроби'); await screen.findByText('lost response');
  expect(api.generate.mock.calls[0]).toEqual(['session-a', { expectedRevision: '1', expectedAccessEpoch: 'owner', attemptId: 'attempt-a' }]);
  first.unmount(); page(); await screen.findByText('Сесія A'); expect(exportsApi.getSnapshot).not.toHaveBeenCalled();
  click('Відкрити / продовжити Сесія A'); await screen.findByText(/Файли Magento готові/);
  expect(exportsApi.getSnapshot).toHaveBeenCalledWith('snapshot-a'); expect(api.generate).toHaveBeenCalledTimes(1); expect(exportsApi.confirmSnapshot).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it('explicitly discarding an uncertain new form starts an independent workspace without resurrecting its descriptor', async () => {
  api.create.mockRejectedValueOnce(new Error('unknown first result')).mockResolvedValueOnce(response(own));
  page(); await screen.findByText('Сесія A'); click('Створити свій експорт');
  fireEvent.change(screen.getByLabelText('Назва експорту'), { target: { value: 'First operation' } }); click('Створити приватний експорт');
  await screen.findByText(/unknown first result/); click('Створити свій експорт'); await screen.findByRole('dialog'); click('Відкинути й перейти');
  expect(screen.getByLabelText('Назва експорту').value).toBe(''); expect(screen.getByLabelText('Назва експорту').closest('fieldset').disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Назва експорту'), { target: { value: 'Deliberate independent operation' } }); click('Створити приватний експорт');
  await screen.findByRole('heading', { name: 'Сесія A' });
  expect(api.create.mock.calls[1][0].creationKey).not.toBe(api.create.mock.calls[0][0].creationKey);
  expect(api.create.mock.calls[1][0].title).toBe('Deliberate independent operation');
});

it('invitation explicitly joins the same export, does not clone or generate, and shows existing capabilities', async () => {
  const invite = { id: own.id, title: own.title, ownerName: 'Олена', accessEpoch: '1' };
  api.list.mockImplementation(async (scope) => response({ items: scope === 'invitations' ? [invite] : [], next: null }));
  api.membership.mockResolvedValue(response({ state: 'accepted', epoch: '2' })); api.get.mockResolvedValue(response({ ...own, isOwner: false, accessEpoch: '2' }));
  page(2); fireEvent.click(screen.getByRole('link', { name: 'Запрошення' }));
  await screen.findByText('Сесія A'); expect(api.get).not.toHaveBeenCalled(); expect(screen.getByText(/Ваші поточні права/)).toBeTruthy();
  click('Приєднатися до експорту користувача Олена'); await screen.findByRole('heading', { name: 'Сесія A' });
  expect(api.membership).toHaveBeenCalledWith('session-a', { action: 'accept', expectedAccessEpoch: '1' }); expect(api.create).not.toHaveBeenCalled(); expect(api.generate).not.toHaveBeenCalled();
});

it('dirty session conflict preserves exact fields and Stay/Discard protect opening another workspace', async () => {
  page(); await screen.findByText('Сесія A'); click('Відкрити / продовжити Сесія A'); await screen.findByLabelText('Назва експорту');
  fireEvent.change(screen.getByLabelText('Назва експорту'), { target: { value: '  local title ' } });
  api.save.mockRejectedValue({ response: { status: 409, data: { error: 'revision conflict', code: 'EXPORT_SESSION_CONFLICT' } } });
  fireEvent.click(screen.getByRole('link', { name: 'Новий експорт' })); await screen.findByRole('dialog'); click('Зберегти й перейти');
  await screen.findByText('revision conflict'); expect(screen.getByRole('dialog')).toBeTruthy();
  // The form registers its settled busy state with the navigation guard in an effect.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Залишитися' }).disabled).toBe(false));
  click('Залишитися');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByLabelText('Назва експорту').value).toBe('  local title ');
  click('Створити свій експорт'); await screen.findByRole('dialog'); click('Відкинути й перейти'); await screen.findByRole('heading', { name: 'Створити свій експорт' });
});

it('revoked membership clears data on authoritative refresh and fences a late create response', async () => {
  const pending = deferred(); api.get.mockResolvedValue(response({ ...own, currentAttemptId: attempt.id, attempt })); api.generate.mockReturnValue(pending.promise);
  page(); await screen.findByText('Сесія A'); click('Відкрити / продовжити Сесія A'); await screen.findByText(/Підготовлено — очікує/); click('Створити файли цієї спроби');
  api.get.mockRejectedValue({ response: { status: 404, data: { error: 'not found' } } });
  // A refresh already in flight can receive denial while creation's outcome is unknown.
  fireEvent.focus(window);
  // Busy operations suppress polling; settle failure, then authoritative focus read.
  await act(async () => pending.reject(new Error('unknown'))); fireEvent.focus(window);
  await screen.findByText(/Доступ до цього експорту втрачено/); expect(screen.queryByLabelText('Назва експорту')).toBeNull(); expect(exportsApi.getSnapshot).not.toHaveBeenCalled();
});

it('deep link requires explicit current-user opening and known snapshot reading never confirms', async () => {
  page(2, '/exports/sessions/session-a'); await screen.findByRole('button', { name: 'Відкрити експорт із посилання через мій обліковий запис' }); expect(api.get).not.toHaveBeenCalled();
  click('Відкрити експорт із посилання через мій обліковий запис'); await screen.findByRole('heading', { name: 'Сесія A' });
  fireEvent.change(screen.getByLabelText('ID збереженого знімка'), { target: { value: 'historical-id' } }); click('Прочитати знімок без підтвердження');
  await screen.findByText(/Файли Magento готові/); expect(exportsApi.getSnapshot).toHaveBeenCalledWith('historical-id'); expect(exportsApi.confirmSnapshot).not.toHaveBeenCalled();
});

it('principal switch during stored download discards bytes, and B must explicitly open through B requests', async () => {
  api.get.mockResolvedValue(response({ ...own, snapshotId: snapshot.id })); const late = deferred(); exportsApi.downloadMagentoArtifact.mockReturnValue(late.promise);
  const first = page(); await screen.findByText('Сесія A'); click('Відкрити / продовжити Сесія A'); await screen.findByText(/Файли Magento готові/);
  click(/Завантажити/); await waitFor(() => expect(exportsApi.downloadMagentoArtifact).toHaveBeenCalled());
  first.auth.principalLifetime.valid = false;
  first.rerender(<AuthContext.Provider value={{ applicationUser: { id: 2 }, permissions: ['exports.view','exports.create'], principalLifetime: { id: 2, valid: true } }}><RouterProvider router={first.router} /></AuthContext.Provider>);
  await act(async () => late.resolve(response('private bytes'))); expect(downloadBlob).not.toHaveBeenCalled(); expect(screen.queryByText(/Файли Magento готові/)).toBeNull();
  expect(api.get).toHaveBeenCalledTimes(1); await screen.findByRole('button', { name: 'Відкрити експорт із посилання через мій обліковий запис' }); click('Відкрити експорт із посилання через мій обліковий запис'); await screen.findByText(/Файли Magento готові/); expect(api.get).toHaveBeenCalledTimes(2);
});

const gridArtifact = { groupCode: 'BR', rowCount: 2, productCount: 1, csvContent: 'sku,store_view_code,synthetic_target\r\nS,,Original\r\nS,en,English\r\n' };
it('prepared session reload requires a matching authoritative table and mismatched preview cannot generate', async () => {
  const saved = { ...attempt, preview: { ...attempt.preview, tableFingerprint: 'original', artifacts: [{ ...gridArtifact, csvContent: undefined }] } };
  api.get.mockResolvedValue(response({ ...own, currentAttemptId: saved.id, attempt: saved }));
  api.preview.mockResolvedValueOnce(response({ ...saved.preview, configurationRevision: '1', artifacts: [gridArtifact] }))
    .mockResolvedValueOnce(response({ ...saved.preview, tableFingerprint: 'changed', configurationRevision: '1', artifacts: [{ ...gridArtifact, csvContent: gridArtifact.csvContent.replace('Original','Changed') }] }));
  page(); await screen.findByText('Сесія A'); click('Відкрити / продовжити Сесія A');
  const create = await screen.findByRole('button', { name: 'Створити файли цієї спроби' });
  expect(create.disabled).toBe(true);
  click('Перевірити збережений діапазон (лише читання)');
  await screen.findByText('Original');
  await waitFor(() => expect(create.disabled).toBe(false));
  click('Перевірити збережений діапазон (лише читання)');
  await screen.findByText('Changed');
  expect(create.disabled).toBe(true); expect(api.generate).not.toHaveBeenCalled();
  expect(screen.getByText(/Таблиця застаріла/)).toBeTruthy();
});

it('uncertain session recovery keeps the original attempt despite a newer displayed preview', async () => {
  const saved = { ...attempt, state: 'interrupted', preview: { ...attempt.preview, tableFingerprint: 'original', artifacts: [] } };
  api.get.mockResolvedValue(response({ ...own, currentAttemptId: saved.id, attempt: saved }));
  api.preview.mockResolvedValue(response({ ...saved.preview, tableFingerprint: 'newer', configurationRevision: '1', artifacts: [gridArtifact] }));
  api.generate.mockResolvedValue(response(snapshot));
  page(); await screen.findByText('Сесія A'); click('Відкрити / продовжити Сесія A');
  await screen.findByRole('button', { name: 'Повторити ту саму спробу' });
  click('Перевірити збережений діапазон (лише читання)'); await screen.findByText('Original');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Повторити ту саму спробу' }).disabled).toBe(false));
  click('Повторити ту саму спробу');
  await waitFor(() => expect(api.generate).toHaveBeenCalledWith('session-a', { expectedRevision: '1', expectedAccessEpoch: 'owner', attemptId: 'attempt-a' }));
  expect(api.prepare).not.toHaveBeenCalled();
});
