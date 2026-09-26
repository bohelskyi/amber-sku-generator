import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ExportSessionsPage from '../src/pages/ExportSessionsPage';
import ExportHistoryPage from '../src/pages/ExportHistoryPage';
import { AuthContext } from '../src/auth/auth-context';
import { exportSessionsApi as api } from '../src/api/export-sessions-api';
import { exportsApi } from '../src/api/exports-api';
import { ExportTools } from '../src/components/app/ExportTools';
import { useProductExportController } from '../src/hooks/product/useProductExportController';
import { sessionDisplayState } from '../src/lib/export-session-presentation';
import { ExportReview } from '../src/components/exports/ExportReview';
import { createExportViewMemory } from '../src/lib/export-view-memory';
import { notifyExportReviewChanged } from '../src/lib/export-review-events';

vi.mock('../src/api/export-sessions-api', () => ({ exportSessionsApi: Object.fromEntries(['list', 'create', 'get', 'save', 'preview', 'prepare', 'generate', 'recipients', 'invite', 'membership'].map((name) => [name, vi.fn()])) }));
vi.mock('../src/api/exports-api', async (original) => {
  const module = await original(); return { ...module, exportsApi: Object.fromEntries(Object.keys(module.exportsApi).map((name) => [name, vi.fn()])) };
});
const response = (data) => ({ data, headers: {} });
const settings = { requestContract: 'template-v1', mode: 'manual', fromSku: 'BR-01', toSku: 'SV-99', selection: { mode: 'active' } };
const template = { displayName: 'Вересневий каталог', versionNumber: '3' };
const own = { id: 'session-a', title: 'Каталог вересня', ownerUserId: '1', ownerName: 'Олена', isOwner: true, accessEpoch: 'owner', configurationRevision: '1',
  settings, template, participants: [], participantCount: 1, createdAt: '2026-09-25T10:00:00Z', lastRecordedActivityAt: '2026-09-25T11:00:00Z', currentAttemptId: null, snapshotId: null };
const artifact = { groupCode: 'BR', groupName: 'Браслети', fileName: 'stored.csv', rowCount: 2, productCount: 1, csvContent: 'sku,store_view_code,name\nBR-01,,Current\nBR-01,en,English' };
const preview = { tableFingerprint: 'original', configurationRevision: '1', representedCount: 1, readyCount: 1, errors: [], artifacts: [artifact], range: { fromSku: 'BR-01', toSku: 'BR-01' } };
const attempt = { id: 'attempt-original', state: 'prepared', preview: { ...preview, artifacts: [{ ...artifact, csvContent: undefined }] } };
const snapshot = { id: 'stored-a', stream: 'product', sessionId: own.id, accessEpoch: 'owner', status: 'generated', generatedAt: own.createdAt,
  productCount: 1, csvRowCount: 2, createdByUserId: null, artifacts: [{ ...artifact, csvContent: undefined }], capturedRange: preview.range, recipe: { kind: 'system', name: 'Системний профіль' } };
const click = (name) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
const open = async () => { fireEvent.click(await screen.findByRole('link', { name: 'Відкрити / продовжити Каталог вересня' })); await screen.findByRole('heading', { name: own.title }); };
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function mount(path = '/exports/sessions', permissions = ['exports.view', 'exports.create']) {
  const auth = { applicationUser: { id: '1' }, permissions, principalLifetime: { valid: true } };
  const router = createMemoryRouter([{ path: '/exports/*', element: <Routes>
    <Route path="sessions/:sessionId?" element={<ExportSessionsPage />} /><Route path="shared" element={<ExportSessionsPage scope="shared" />} />
    <Route path="invitations" element={<ExportSessionsPage scope="invitations" />} /><Route path="history/:stream?/:snapshotId?" element={<ExportHistoryPage />} />
  </Routes> }], { initialEntries: [path] });
  const result = render(<AuthContext.Provider value={auth}><RouterProvider router={router} /></AuthContext.Provider>);
  return { ...result, auth, router, switchAuth: (next) => result.rerender(<AuthContext.Provider value={next}><RouterProvider router={router} /></AuthContext.Provider>) };
}
beforeEach(() => {
  for (const mock of [...Object.values(api), ...Object.values(exportsApi)]) mock.mockReset();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  api.list.mockResolvedValue(response({ items: [own], next: null })); api.get.mockResolvedValue(response(own));
  api.preview.mockResolvedValue(response(preview)); api.membership.mockResolvedValue(response({ state: 'accepted', epoch: '2' }));
  exportsApi.getTemplateOptions.mockResolvedValue(response({ versions: [], activeVersionId: null }));
  exportsApi.getSnapshot.mockResolvedValue(response(snapshot)); exportsApi.readMagentoArtifact.mockResolvedValue(response(artifact.csvContent));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['owned', 'shared'])('UX4 %s list has human identity, recorded activity, range and shared UX3 file status', async (scope) => {
  api.list.mockResolvedValue(response({ items: [{ ...own, participantCount: 3, snapshotId: snapshot.id, snapshot: { ...snapshot, status: 'confirmed' } }], next: null }));
  mount(scope === 'owned' ? '/exports/sessions' : '/exports/shared');
  await screen.findByText(own.title); expect(screen.getByText('Завершено')).toBeTruthy();
  expect(screen.getByText('Власник: Олена · Учасників: 3')).toBeTruthy(); expect(screen.getByText('Вересневий каталог · v3')).toBeTruthy();
  expect(screen.getByText('Обрано: BR-01 — SV-99')).toBeTruthy(); expect(screen.getByText(/Остання зафіксована дія:/)).toBeTruthy();
  expect(screen.queryByText(/Оновлено:/)).toBeNull(); expect(api.get).not.toHaveBeenCalled();
  const link = screen.getByRole('link', { name: /Відкрити \/ продовжити/ }); link.focus(); expect(document.activeElement).toBe(link);
});

it('UX4 invitations hide even supplied private metadata; decline never opens or creates a membership', async () => {
  api.list.mockResolvedValueOnce(response({ items: [{ ...own, state: 'pending', accessEpoch: '7', participants: [{ display_name: 'PRIVATE MEMBER' }], snapshot }], next: null }))
    .mockResolvedValue(response({ items: [], next: null }));
  mount('/exports/invitations', ['exports.view']); await screen.findByText(own.title);
  expect(screen.getByText('Ви приєднаєтесь до того самого експорту, а не створите копію.')).toBeTruthy();
  expect(screen.queryByText(/BR-01|SV-99|Вересневий каталог|PRIVATE MEMBER/)).toBeNull();
  expect(screen.queryByRole('table')).toBeNull(); click('Відхилити'); await screen.findByText(/Нових запрошень немає/);
  expect(api.membership).toHaveBeenCalledWith(own.id, { action: 'decline', expectedAccessEpoch: '7' });
  expect(api.get).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled(); expect(api.generate).not.toHaveBeenCalled();
});

it('UX4 exact recipient review, pending invitation, revoke confirmation and dialog focus restoration', async () => {
  const member = { user_id: '2', display_name: 'Ірина', preferred_username: 'iryna', state: 'pending', epoch: '5' };
  api.recipients.mockResolvedValue(response({ users: [{ id: '2', display_name: 'Ірина', preferred_username: 'iryna' }, { id: '3', display_name: 'Ірина', preferred_username: 'iryna.other' }] }));
  api.invite.mockImplementation(async () => { api.get.mockResolvedValue(response({ ...own, participants: [member] })); return response({ state: 'pending' }); });
  api.membership.mockImplementation(async () => { api.get.mockResolvedValue(response(own)); return response({ state: 'revoked', epoch: '6' }); });
  mount(); await open(); const share = screen.getByRole('button', { name: 'Поділитися' }); share.focus(); fireEvent.click(share);
  let dialog = screen.getByRole('dialog'); expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.change(screen.getByLabelText('Ім’я або логін одержувача'), { target: { value: 'Ірина' } }); click('Знайти користувача');
  await screen.findByLabelText('Одержувач'); expect(screen.getByRole('button', { name: 'Надіслати запрошення в застосунку' }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Одержувач'), { target: { value: '2' } }); expect(screen.getByText('Логін: iryna · Користувач №2')).toBeTruthy();
  click('Надіслати запрошення в застосунку'); await screen.findByText('Запрошено');
  expect(api.invite).toHaveBeenCalledWith(own.id, { userId: '2', expectedAccessEpoch: 'owner' });
  expect(screen.queryByRole('button', { name: 'Відкликати доступ: Олена' })).toBeNull();
  click('Відкликати доступ: Ірина'); dialog = screen.getByRole('dialog'); expect(dialog.textContent).toContain('Уже завантажені файли неможливо відкликати');
  expect(api.membership).not.toHaveBeenCalled(); click('Скасувати'); expect(api.membership).not.toHaveBeenCalled();
  click('Відкликати доступ: Ірина'); click('Підтвердити відкликання'); await screen.findByText('Доступ відкликано.');
  expect(api.membership).toHaveBeenCalledWith(own.id, { action: 'revoke', userId: '2', expectedAccessEpoch: 'owner', expectedMemberEpoch: '5' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Закрити' }).disabled).toBe(false));
  click('Закрити'); expect(document.activeElement).toBe(share);
});

it('UX4 view-only member reads stored result, has no create/confirm/invite and leaves only after confirmation', async () => {
  api.get.mockResolvedValue(response({ ...own, isOwner: false, accessEpoch: '8', snapshotId: snapshot.id, snapshot, participantCount: 2 }));
  mount('/exports/shared', ['exports.view']); await open(); await screen.findByText('ЗБЕРЕЖЕНІ ФАЙЛИ'); await screen.findByRole('table');
  expect(screen.queryByRole('button', { name: /Створити файли|Завершити експорт|Поділитися|Зберегти/ })).toBeNull(); expect(api.preview).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Завантажити CSV' })).toBeTruthy();
  click('Учасники'); expect(screen.queryByLabelText('Ім’я або логін одержувача')).toBeNull(); click('Вийти зі спільного експорту');
  expect(screen.getByRole('dialog').textContent).toContain('Сам експорт не буде видалено'); expect(api.membership).not.toHaveBeenCalled();
  click('Підтвердити вихід'); await screen.findByText(/Доступ до цього експорту втрачено|Експорт не знайдено/);
  expect(api.membership).toHaveBeenCalledWith(own.id, { action: 'leave', expectedAccessEpoch: '8' }); expect(screen.queryByRole('table')).toBeNull();
});

it.each([true, false])('UX4 held lock with generation=%s blocks replacement without inventing active creation', async (generation) => {
  api.get.mockResolvedValue(response({ ...own, executing: true, currentAttemptId: generation ? attempt.id : null, attempt: generation ? { ...attempt, state: 'executing' } : null }));
  mount(); await open(); expect(screen.getByText(generation ? 'Створюються файли' : 'Потрібна перевірка')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Замінити|Створити файли|Повторити створення/ })).toBeNull();
  expect(api.prepare).not.toHaveBeenCalled(); expect(api.generate).not.toHaveBeenCalled(); expect(api.preview).not.toHaveBeenCalled();
});

it('UX4 uncertain transport retry retains original revision and attempt after newer server and preview are displayed', async () => {
  api.get.mockResolvedValue(response({ ...own, currentAttemptId: attempt.id, attempt })); api.generate.mockRejectedValue(new Error('uncertain transport'));
  mount(); await open(); click('Перевірити товари'); await screen.findByText('Current'); click('Створити файли'); await screen.findByText('uncertain transport');
  const original = api.generate.mock.calls[0];
  api.get.mockResolvedValue(response({ ...own, configurationRevision: '2', currentAttemptId: 'attempt-new', attempt: { ...attempt, id: 'attempt-new' } }));
  click('Оновити стан із сервера'); await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  api.preview.mockResolvedValue(response({ ...preview, configurationRevision: '2', tableFingerprint: 'newer' }));
  click('Перевірити товари'); await screen.findByText('Current'); click('Повторити створення цього експорту');
  await waitFor(() => expect(api.generate).toHaveBeenCalledTimes(2)); expect(api.generate.mock.calls[1]).toEqual(original); expect(api.prepare).not.toHaveBeenCalled();
});

it('UX4 expired unused preparation requires an explicit check and explicit replacement even when rows match', async () => {
  api.get.mockResolvedValue(response({ ...own, currentAttemptId: attempt.id, attempt: { ...attempt, preparationIssue: 'expired' } }));
  api.prepare.mockResolvedValue(response({ ...attempt, id: 'replacement' }));
  mount(); await open(); expect(screen.getByText(/Термін збереженої перевірки минув/)).toBeTruthy();
  expect(api.preview).not.toHaveBeenCalled(); expect(api.prepare).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Створити файли' }).disabled).toBe(true);
  click('Перевірити товари'); await screen.findByText('Current');
  expect(screen.getByRole('button', { name: 'Створити файли' }).disabled).toBe(true);
  click('Оновити та замінити збережену перевірку'); expect(api.prepare).not.toHaveBeenCalled();
  click('Замінити перевірку'); await waitFor(() => expect(api.prepare).toHaveBeenCalledWith(own.id, {
    expectedRevision: '1', expectedAccessEpoch: 'owner', expectedPreviewFingerprint: 'original', supersedeAttemptId: attempt.id,
  }));
  expect(api.generate).not.toHaveBeenCalled();
});

it('UX3 display page survives a saved summary without rows and clamps only against the refreshed rows', () => {
  const memory = createExportViewMemory();
  const full = (identity, count) => ({ ...preview, tableFingerprint: identity, artifacts: [{ ...artifact,
    csvContent: 'sku,name\n' + Array.from({ length: count }, (_, i) => `BR-${i + 1},Name ${i + 1}`).join('\n'),
  }] });
  const result = render(<ExportReview preview={full('first', 105)} viewMemory={memory} />);
  click('Наступні рядки'); expect(screen.getByText('51–100 / 105 · порядок файлу')).toBeTruthy();
  result.rerender(<ExportReview preview={attempt.preview} viewMemory={memory} stale />);
  expect(memory.read().page).toBe(1);
  result.rerender(<ExportReview preview={full('second', 104)} viewMemory={memory} />);
  expect(screen.getByText('51–100 / 104 · порядок файлу')).toBeTruthy();
  result.rerender(<ExportReview preview={full('third', 1)} viewMemory={memory} />);
  expect(screen.getByText('1–1 / 1 · порядок файлу')).toBeTruthy(); expect(memory.read().page).toBe(0);
});

it('UX4 conflict keeps local input and shows newer saved fields separately', async () => {
  mount(); await open(); fireEvent.change(screen.getByLabelText('Назва експорту'), { target: { value: '  Моя локальна назва  ' } });
  api.get.mockResolvedValue(response({ ...own, title: 'Новіша серверна назва', configurationRevision: '2', settings: { ...settings, fromSku: 'BR-NEW' } }));
  click('Оновити стан із сервера'); await screen.findByText('Новіші збережені налаштування');
  expect(screen.getByLabelText('Назва експорту').value).toBe('  Моя локальна назва  ');
  expect(screen.getByText('BR-NEW — SV-99')).toBeTruthy();
  api.save.mockRejectedValue({ response: { status: 409, data: { error: 'conflict' } } }); click('Зберегти налаштування'); await screen.findByText('conflict');
  expect(api.save.mock.calls[0][1].expectedRevision).toBe('1');
});

it('UX4 A → B → A fences late directory data while same-user refresh preserves current sharing input', async () => {
  const result = mount(); await open(); click('Поділитися'); fireEvent.change(screen.getByLabelText('Ім’я або логін одержувача'), { target: { value: 'Ірина' } });
  result.switchAuth({ ...result.auth, applicationUser: { id: '1', displayName: 'Updated' }, csrfToken: 'fresh' });
  expect(screen.getByLabelText('Ім’я або логін одержувача').value).toBe('Ірина');
  const late = deferred(); api.recipients.mockReturnValue(late.promise); click('Знайти користувача'); await waitFor(() => expect(api.recipients).toHaveBeenCalled());
  result.auth.principalLifetime.valid = false;
  result.switchAuth({ ...result.auth, applicationUser: { id: '2' }, principalLifetime: { valid: true } });
  result.switchAuth({ ...result.auth, principalLifetime: { valid: true } });
  await act(async () => late.resolve(response({ users: [{ id: '9', display_name: 'PRIVATE LATE' }] })));
  expect(screen.queryByText('PRIVATE LATE')).toBeNull(); expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(1)); await screen.findByRole('heading', { name: own.title });
});

it('UX4 revocation during a pending table read clears private content and fences late bytes', async () => {
  const late = deferred(); exportsApi.readMagentoArtifact.mockReturnValue(late.promise);
  api.get.mockResolvedValue(response({ ...own, snapshotId: snapshot.id, snapshot })); mount(); await open(); await screen.findByText('ЗБЕРЕЖЕНІ ФАЙЛИ');
  await waitFor(() => expect(exportsApi.readMagentoArtifact).toHaveBeenCalled());
  api.get.mockRejectedValue({ response: { status: 404 } }); fireEvent.focus(window); await screen.findByText(/Доступ до цього експорту втрачено|Експорт не знайдено/);
  await act(async () => late.resolve(response('sku,name\nPRIVATE,LATE'))); expect(screen.queryByText('PRIVATE')).toBeNull(); expect(screen.queryByRole('table')).toBeNull();
});

it('UX4 denied focus review immediately clears private rows even before an older metadata read resolves', async () => {
  mount(); await open(); click('Перевірити товари'); await screen.findByText('Current');
  const late = deferred(); api.get.mockReturnValue(late.promise); api.preview.mockRejectedValue({ response: { status: 404 } });
  fireEvent.focus(window); await screen.findByText(/Доступ до цього експорту втрачено|Експорт не знайдено/);
  expect(screen.queryByRole('table')).toBeNull();
  await act(async () => late.resolve(response(own))); expect(screen.queryByRole('heading', { name: own.title })).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
});

it('UX4 history preserves unknown attribution and no-session historical identity, direct opening is read-only', async () => {
  const historical = { ...snapshot, id: 'historical', sessionId: undefined, artifacts: [], recipe: { kind: 'historical', name: 'Немає даних про профіль Magento' } };
  exportsApi.getHistory.mockResolvedValue(response({ items: [historical], next: null })); exportsApi.getSnapshot.mockResolvedValue(response(historical));
  mount('/exports/history', ['exports.view']); await screen.findByText('Автор невідомий'); expect(screen.getByText('Історичні файли Magento недоступні')).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: /Відкрити товари від/ })); await screen.findByText('ЗБЕРЕЖЕНІ ФАЙЛИ');
  expect(exportsApi.getHistory.mock.calls[0][0]).toEqual({ stream: 'all', scope: 'accessible', status: 'all', limit: 20 });
  expect(api.create).not.toHaveBeenCalled(); expect(api.get).not.toHaveBeenCalled(); expect(exportsApi.createSnapshot).not.toHaveBeenCalled();
});

it('UX4 presentation states require authoritative evidence, not a prepared label or held lock alone', () => {
  expect(sessionDisplayState(own, { dirty: true })).toBe('Чернетка');
  expect(sessionDisplayState({ ...own, currentAttemptId: attempt.id, attempt })).toBe('Потрібна перевірка');
  expect(sessionDisplayState(own, { preview, tableAvailable: true })).toBe('Перевірено · перевірку не збережено');
  expect(sessionDisplayState({ ...own, attempt }, { preview, tableAvailable: true, preparationMatches: true })).toBe('Готовий до створення файлів');
  expect(sessionDisplayState({ ...own, executing: true })).toBe('Потрібна перевірка');
  expect(sessionDisplayState({ ...own, attempt: { state: 'executing' } })).toBe('Потрібна увага');
  expect(sessionDisplayState({ ...own, attempt }, { preview, tableAvailable: true, preparationMatches: true, stale: true })).toBe('Потрібна перевірка');
});

function ReviewHarness() {
  const workflow = useProductExportController();
  return <ExportTools {...workflow} canArchive={false} canViewExport canCreateExport surface="products" onPreviewExport={workflow.handlePreviewExport} onCreateSnapshot={workflow.handleCreateSnapshot} />;
}
it('UX5: confirmed correction automatically rechecks, preserving attention/file/search/language/width and the next actionable issue', async () => {
  const issue = { code: 'manual_name_required', field: 'name', target: { kind: 'column', column: 'name' } };
  const row = (id, ready = false) => ({ ordinal: id, productId: id, sku: `SV-${id}`, language: 'main', readiness: ready ? 'ready' : 'attention',
    issues: ready ? [] : [issue], cells: [{ state: 'final', value: `SV-${id}` }, { state: ready ? 'final' : 'not-evaluated', value: ready ? 'Fixed name' : null }] });
  const review = (fixed = false) => ({ mode: 'new', tableFingerprint: fixed ? 'new' : 'old', representedCount: 2, readyCount: fixed ? 1 : 0, errors: [issue],
    review: { files: [{ groupCode: 'BR', groupName: 'Браслети', headers: ['sku', 'name'], rows: [] }, { groupCode: 'SV', groupName: 'Сувеніри', headers: ['sku', 'name'], rows: [row(1, fixed), row(2)] }] } });
  exportsApi.getStatus.mockResolvedValue(response({ countSinceLastExport: 2 })); exportsApi.getPriceStatus.mockResolvedValue(response({ pendingCount: 0 }));
  exportsApi.preview.mockResolvedValueOnce(response(review())).mockResolvedValue(response(review(true)));
  exportsApi.previewMagentoName.mockResolvedValue(response({ previewToken: 'name-proof' }));
  const savedName = deferred();
  exportsApi.applyMagentoName.mockImplementation(() => { notifyExportReviewChanged({ kind: 'product' }); return savedName.promise; });
  render(<ReviewHarness />); await screen.findByText(/2 нові товари очікують/); click('Перевірити 2 нові товари'); await screen.findByRole('tab', { name: 'Сувеніри' });
  fireEvent.click(screen.getByRole('tab', { name: 'Сувеніри' })); fireEvent.change(screen.getByLabelText('Пошук SKU'), { target: { value: 'SV-' } });
  fireEvent.change(screen.getByLabelText('Готовність'), { target: { value: 'attention' } }); fireEvent.change(screen.getByLabelText('Мова рядка'), { target: { value: 'main' } });
  click('Ширина колонок'); fireEvent.change(screen.getByLabelText('Ширина, px'), { target: { value: '420' } }); click('Готово');
  click('Значення name, рядок 1, потребує уваги'); click('Заповнити назву');
  fireEvent.change(screen.getByLabelText('Українська назва'), { target: { value: 'Назва' } }); fireEvent.change(screen.getByLabelText('English name'), { target: { value: 'Name' } });
  click('Зберегти назви'); await screen.findByText(/Дані товару змінено. Попередній перегляд застарів/);
  expect(screen.getByRole('dialog')).toBeTruthy(); expect(exportsApi.preview).toHaveBeenCalledTimes(1);
  await act(async () => savedName.resolve(response({})));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(exportsApi.preview).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText(/Дані товару змінено. Попередній перегляд застарів/)).toBeNull());
  expect(screen.getByLabelText('Готовність').value).toBe('attention'); expect(screen.getByLabelText('Пошук SKU').value).toBe('SV-'); expect(screen.getByLabelText('Мова рядка').value).toBe('main');
  expect(screen.getByRole('tab', { name: 'Сувеніри' }).getAttribute('aria-selected')).toBe('true'); expect(document.querySelector('colgroup col:nth-child(2)').style.width).toBe('420px');
  expect(screen.queryByText('Fixed name')).toBeNull(); expect(screen.queryByRole('button', { name: 'Значення name, рядок 1, потребує уваги' })).toBeNull();
  click('Значення name, рядок 2, потребує уваги'); click('Заповнити назву'); expect(within(screen.getByRole('dialog')).getByText('Назва для SV-2')).toBeTruthy();
  expect(exportsApi.preview.mock.calls).toEqual([[{ mode: 'new' }], [{ mode: 'new' }]]); expect(exportsApi.createSnapshot).not.toHaveBeenCalled();
});
