import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoFirstSyncFields from '../src/components/attention/MagentoFirstSyncFields.jsx';

vi.mock('../src/lib/api.js', () => ({ api: { post: vi.fn() } }));
const auth = { roles: [{ key: 'administrator' }], principalLifetime: { id: '1', valid: true } };
const token = 'a'.repeat(64);
const known = (value) => ({ known: true, present: true, value });
const empty = { known: true, present: false };
const field = (overrides = {}) => ({ target: 'weight', scope: 'all', status: 'conflict', reason: 'POPULATED_VALUES_DIFFER', local: known('12'), remote: known('15'), canAcceptRemote: true, canKeepLocal: true, ...overrides });
const plan = (fields = [field()], overrides = {}) => ({ mode: 'first', sku: 'SV1', previewToken: token, fields, blockers: [], coverage: { fullProductAdoption: false }, readyForOutbound: false, complete: false, ...overrides });
const receipt = (overrides = {}) => ({ sku: 'SV1', target: 'weight', scope: 'all', choice: 'accept_remote', receipt: { sessionId: 'edcd2e97-8708-4e06-9c2b-55bdbf61a3e2', revision: '1', state: 'imported', alreadyApplied: false }, readyForOutbound: false, complete: false, ...overrides });
const shell = (props = {}, principal = auth) => <AuthContext.Provider value={principal}><MagentoFirstSyncFields sku="SV1" bindingRevisionId="binding-id" {...props} /></AuthContext.Provider>;
const read = () => fireEvent.click(screen.getByRole('button', { name: 'Перевірити актуальні поля' }));
const accept = () => fireEvent.click(screen.getByRole('button', { name: 'Отримати значення Magento: Вага · UA / основний магазин' }));
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Зберегти рішення цього поля' }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('performs no reads, decisions or outward dispatch on mount; preview is an explicit separate read', async () => {
  api.post.mockResolvedValue({ data: plan() });
  render(shell()); expect(api.post).not.toHaveBeenCalled(); read();
  await screen.findByRole('region', { name: 'Вага · UA / основний магазин' });
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/first-sync/preview', { sku: 'SV1', bindingRevisionId: 'binding-id' }, { signal: expect.any(AbortSignal) });
  expect(screen.queryByRole('button', { name: /передати|синхронізувати/i })).toBeNull();
});

it('distinguishes unknown from empty and renders zero and false without a fallback', async () => {
  api.post.mockResolvedValue({ data: plan([
    field({ target: 'weight', status: 'unknown', reason: 'REMOTE_READ_UNKNOWN', local: empty, remote: { known: false }, canAcceptRemote: false, canKeepLocal: false }),
    field({ target: 'price', local: known(0), remote: known(false), reason: 'REMOTE_BOOLEAN_INVALID', canAcceptRemote: false }),
  ]) });
  render(shell()); read();
  const weight = await screen.findByRole('region', { name: 'Вага · UA / основний магазин' });
  expect(within(weight).getByText('Не заповнено')).toBeTruthy();
  expect(within(weight).getAllByText('Дані не підтверджено')).toHaveLength(2);
  expect(within(weight).getByRole('button', { name: /Отримати/ }).disabled).toBe(true);
  const price = screen.getByRole('region', { name: 'Ціна · UA / основний магазин' });
  expect(within(price).getByText('0')).toBeTruthy(); expect(within(price).getByText('false')).toBeTruthy();
  expect(within(price).getByText('Логічне значення має непідтримуваний формат у Magento.')).toBeTruthy();
});

it('shows invalid presence literally rather than disguising an existing zero as empty', async () => {
  api.post.mockResolvedValue({ data: plan([field({ local: { known: true, present: false, value: 0 }, reason: 'LOCAL_PRESENCE_VALUE_MISMATCH', canAcceptRemote: false, canKeepLocal: false })]) });
  render(shell()); read(); await screen.findByText('Позначено як порожнє; фактичне значення: 0');
  expect(screen.getByText('Позначка заповнення суперечить значенню у Amber.')).toBeTruthy();
});

it('shows per-language received name and unresolved EN without claiming the whole first sync is complete', async () => {
  api.post.mockResolvedValue({ data: plan([
    field({ target: 'name', status: 'equal', reason: 'NAME_ALREADY_RECEIVED_USE_ORDINARY_RECONCILIATION', received: true, local: known('Назва'), remote: known('Назва'), canAcceptRemote: false, canKeepLocal: false }),
    field({ target: 'name', scope: 'en', status: 'unknown', reason: 'REMOTE_READ_UNKNOWN', local: known('Name'), remote: { known: false }, canAcceptRemote: false, canKeepLocal: false }),
  ]) });
  render(shell()); read();
  const ua = await screen.findByRole('region', { name: 'Назва · UA / основний магазин' });
  expect(within(ua).getByText('Отримано один раз')).toBeTruthy();
  expect(within(ua).queryByRole('button', { name: /Отримати/ })).toBeNull();
  expect(screen.getByText(/Одноразове отримання ще не завершене/)).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Назва · EN' })).toBeTruthy();
});

it('displays unfamiliar reasons safely with their exact code in lazily opened technical evidence', async () => {
  api.post.mockResolvedValue({ data: plan([field({ reason: 'NEW_REASON_FROM_SERVER', status: 'new_status', canAcceptRemote: true })]) });
  render(shell()); read();
  const row = await screen.findByRole('region', { name: 'Вага · UA / основний магазин' });
  expect(within(row).getByText(/Причина потребує окремого технічного уточнення/)).toBeTruthy();
  expect(row.textContent).not.toContain('NEW_REASON_FROM_SERVER');
  expect(within(row).getByRole('button', { name: /Отримати/ }).disabled).toBe(true);
  fireEvent.click(within(row).getByText('Причина й підтвердження поля'));
  expect(row.textContent).toContain('NEW_REASON_FROM_SERVER');
});

it('confirms the exact field, language and before/after then sends one scoped decision without automatic follow-up', async () => {
  const change = vi.fn();
  api.post.mockResolvedValueOnce({ data: plan([field({ scope: 'en' })]) }).mockResolvedValueOnce({ data: receipt({ scope: 'en' }) });
  render(shell({ onChange: change })); read();
  fireEvent.click(await screen.findByRole('button', { name: 'Отримати значення Magento: Вага · EN' }));
  const dialog = screen.getByRole('dialog', { name: 'Підтвердити поле: Вага · EN' });
  expect(dialog.textContent).toContain('SV1'); expect(dialog.textContent).toContain('12'); expect(dialog.textContent).toContain('15');
  expect(api.post).toHaveBeenCalledTimes(1); confirm();
  await screen.findByText(/Рішення для поля збережено/);
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(api.post.mock.calls[1][0]).toBe('/admin/magento-integration/first-sync/apply');
  expect(api.post.mock.calls[1][1]).toEqual({ sku: 'SV1', bindingRevisionId: 'binding-id', previewToken: token, target: 'weight', scope: 'en', choice: 'accept_remote' });
  expect(change).toHaveBeenCalledWith(receipt({ scope: 'en' }));
  expect(screen.getByText(/Стан доставки товару не підтверджено/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Перевірити поля після рішення' })).toBeTruthy();
});

it('cancel, Escape and Close do not save; cancel restores focus to the initiating field action', async () => {
  api.post.mockResolvedValue({ data: plan() }); render(shell()); read();
  const button = await screen.findByRole('button', { name: 'Отримати значення Magento: Вага · UA / основний магазин' });
  button.focus(); accept(); fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
  await waitFor(() => expect(document.activeElement).toBe(button)); expect(screen.queryByRole('dialog')).toBeNull();
  accept(); fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  accept(); fireEvent.click(screen.getByRole('button', { name: 'Закрити' })); expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('keep local remains pending outward confirmation and repeat clicks cannot create another decision', async () => {
  let finish;
  api.post.mockResolvedValueOnce({ data: plan() }).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const change = vi.fn(); render(shell({ onChange: change })); read();
  fireEvent.click(await screen.findByRole('button', { name: 'Залишити значення Amber: Вага · UA / основний магазин' }));
  const submit = screen.getByRole('button', { name: 'Зберегти рішення цього поля' }); fireEvent.click(submit); fireEvent.click(submit);
  expect(api.post).toHaveBeenCalledTimes(2); expect(api.post.mock.calls[1][1].choice).toBe('keep_local');
  const result = receipt({ choice: 'keep_local', receipt: { ...receipt().receipt, state: 'pending_outward_confirmation' } });
  await act(async () => finish({ data: result }));
  expect(screen.getByText(/Передачу в Magento ще потрібно виконати/)).toBeTruthy(); expect(change).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledTimes(2);
});

it.each([
  {}, receipt({ sku: 'FOREIGN' }), receipt({ target: 'price' }), receipt({ scope: 'en' }), receipt({ choice: 'keep_local' }),
  receipt({ receipt: { ...receipt().receipt, sessionId: 'not-a-session' } }),
  receipt({ receipt: { ...receipt().receipt, revision: 1 } }),
  receipt({ receipt: { ...receipt().receipt, state: 'pending_outward_confirmation' } }),
])('rejects malformed or foreign HTTP 200 receipt #%# without success or callback', async (bad) => {
  api.post.mockResolvedValueOnce({ data: plan() }).mockResolvedValueOnce({ data: bad });
  const change = vi.fn(); render(shell({ onChange: change })); read();
  await screen.findByRole('region', { name: 'Вага · UA / основний магазин' }); accept(); confirm();
  await screen.findByText(/Збереження поля не підтверджено квитанцією/);
  expect(change).not.toHaveBeenCalled(); expect(screen.queryByText(/Рішення для поля збережено/)).toBeNull();
  expect(screen.queryByRole('button', { name: /Отримати значення/ })).toBeNull();
});

it('preview failure clears all old choices and never claims success', async () => {
  api.post.mockResolvedValueOnce({ data: plan() }).mockRejectedValueOnce({ response: { data: { error: 'Змінилася історія товару' } } });
  render(shell()); read(); await screen.findByRole('region', { name: 'Вага · UA / основний магазин' }); read();
  await screen.findByText('Змінилася історія товару');
  expect(screen.queryByRole('button', { name: /Отримати значення/ })).toBeNull(); expect(screen.queryByText(/Рішення для поля збережено/)).toBeNull();
});

it('SKU change aborts and ignores an old unresolved preview even if its promise later resolves', async () => {
  let finish; api.post.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const view = render(shell()); read(); const signal = api.post.mock.calls[0][2].signal;
  view.rerender(shell({ sku: 'SV2' })); expect(signal.aborted).toBe(true);
  await act(async () => finish({ data: plan() }));
  expect(screen.getByRole('region', { name: 'Перше отримання полів SV2' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Вага · UA / основний магазин' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Перевірити актуальні поля' }).disabled).toBe(false);
});

it('actor replacement invalidates preview even for the same application user ID', async () => {
  let finish; api.post.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const view = render(shell()); read(); const signal = api.post.mock.calls[0][2].signal;
  view.rerender(shell({}, { ...auth, principalLifetime: { id: '1', valid: true } }));
  expect(signal.aborted).toBe(true); await act(async () => finish({ data: plan() }));
  expect(screen.queryByRole('region', { name: 'Вага · UA / основний магазин' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Перевірити актуальні поля' }).disabled).toBe(false);
});

it('does not show administrative controls or accept late apply success after role removal', async () => {
  let finish; api.post.mockResolvedValueOnce({ data: plan() }).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const change = vi.fn(); const view = render(shell({ onChange: change })); read();
  await screen.findByRole('region', { name: 'Вага · UA / основний магазин' }); accept(); confirm();
  view.rerender(shell({ onChange: change }, { ...auth, roles: [] }));
  await act(async () => finish({ data: receipt() }));
  expect(screen.queryByRole('region', { name: /Перше отримання/ })).toBeNull(); expect(change).not.toHaveBeenCalled();
});

it.each(['ordinary', 'create', 'review'])('mode %s shows its reason without an adoption or dispatch action', async (mode) => {
  api.post.mockResolvedValue({ data: plan([], { mode, previewToken: undefined, blockers: mode === 'review' ? [{ code: 'FIRST_SYNC_UNFINISHED_WORK' }] : [] }) });
  render(shell()); read();
  await waitFor(() => expect(screen.getAllByRole('status').length).toBeGreaterThan(0));
  expect(screen.queryByRole('button', { name: /Отримати значення|Залишити значення|передати/i })).toBeNull();
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('callback refresh failure retains a verified committed receipt instead of portraying a failed write', async () => {
  api.post.mockResolvedValueOnce({ data: plan() }).mockResolvedValueOnce({ data: receipt() });
  render(shell({ onChange: () => Promise.reject(new Error('refresh')) })); read();
  await screen.findByRole('region', { name: 'Вага · UA / основний магазин' }); accept(); confirm();
  await screen.findByText(/пов’язаний огляд не оновився/);
  expect(screen.getByText(/Рішення для поля збережено/)).toBeTruthy(); expect(api.post).toHaveBeenCalledTimes(2);
});

it('explicitly describes approved automatic empty-field imports without claiming preview has already saved them', async () => {
  api.post.mockResolvedValue({ data: plan([field({ status: 'imported', reason: 'EMPTY_LOCAL_VALID_REMOTE', local: empty })]) });
  render(shell()); read(); await screen.findByText(/Під час збереження порожні підтверджені поля/);
  expect(screen.getByText('Готове до отримання')).toBeTruthy(); expect(screen.queryByText(/Рішення для поля збережено/)).toBeNull();
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('accepts a committed once-only name receipt and reports an already-applied decision distinctly', async () => {
  const result = receipt({ target: 'name', scope: 'en', receipt: { ...receipt().receipt, state: 'name_received', alreadyApplied: true } });
  api.post.mockResolvedValueOnce({ data: plan([field({ target: 'name', scope: 'en', reason: 'FIRST_REMOTE_NAME_AUTHORITATIVE' })]) }).mockResolvedValueOnce({ data: result });
  const change = vi.fn(); render(shell({ onChange: change })); read();
  fireEvent.click(await screen.findByRole('button', { name: 'Отримати значення Magento: Назва · EN' })); confirm();
  await screen.findByText(/Це рішення вже було збережено/); expect(screen.getByText(/Назву цією мовою отримано один раз/)).toBeTruthy();
  expect(change).toHaveBeenCalledWith(result);
});

it('a rejected apply clears the preview token and cannot be retried as a stale decision', async () => {
  api.post.mockResolvedValueOnce({ data: plan() }).mockRejectedValueOnce({ response: { data: { error: 'Перевірка застаріла' } } });
  const change = vi.fn(); render(shell({ onChange: change })); read();
  await screen.findByRole('region', { name: 'Вага · UA / основний магазин' }); accept(); confirm(); await screen.findByText('Перевірка застаріла');
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('button', { name: /Отримати значення/ })).toBeNull();
  expect(change).not.toHaveBeenCalled(); expect(screen.queryByText(/Рішення для поля збережено/)).toBeNull();
});

it.each([plan([field(), field()]), plan([field()], { previewToken: 'invalid' }), plan([field()], { sku: 'FOREIGN' })])('fails closed on duplicate, stale-token or foreign preview #%#', async (bad) => {
  api.post.mockResolvedValue({ data: bad }); render(shell()); read();
  await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: /Отримати значення/ })).toBeNull();
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('does not let a delayed old callback refresh error overwrite the next fresh preview', async () => {
  let failRefresh; const refresh = new Promise((resolve, reject) => { failRefresh = reject; });
  api.post.mockResolvedValueOnce({ data: plan() }).mockResolvedValueOnce({ data: receipt() }).mockResolvedValueOnce({ data: plan([field({ local: known('15'), remote: known('15'), status: 'equal', reason: 'NORMALIZED_VALUES_EQUAL' })]) });
  render(shell({ onChange: () => refresh })); read(); await screen.findByRole('region', { name: 'Вага · UA / основний магазин' }); accept(); confirm();
  fireEvent.click(await screen.findByRole('button', { name: 'Перевірити поля після рішення' }));
  await screen.findByText('Підтверджені значення збігаються після нормалізації.');
  await act(async () => failRefresh(new Error('old refresh')));
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByText('Підтверджені значення збігаються після нормалізації.')).toBeTruthy();
});
