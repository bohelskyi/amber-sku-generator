import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import AttentionPage from '../src/pages/AttentionPage.jsx';
import { correctionsApi } from '../src/api/corrections-api.js';
import { useMagentoSummary } from '../src/hooks/useMagentoSummary.js';

vi.mock('../src/api/corrections-api.js', () => ({ correctionsApi: { listRequestPage: vi.fn() } }));

const auth = (permissions) => ({
  permissions, identity: { name: 'Оператор' }, principalLifetime: { valid: true }, logout: vi.fn(),
});
const renderPage = (permissions = ['corrections.view', 'products.view']) => render(
  <AuthContext.Provider value={auth(permissions)}><MemoryRouter><AttentionPage /></MemoryRouter></AuthContext.Provider>
);

beforeEach(() => {
  vi.restoreAllMocks();
  correctionsApi.listRequestPage.mockResolvedValue({ data: { items: [], summary: { active: 4 } } });
  vi.spyOn(api, 'get').mockResolvedValue({ data: { items: [], pageInfo: { total: 0 }, categories: [] } });
});
afterEach(cleanup);

it('turns repeated history diagnostics into one starting task without losing other exact repairs', async () => {
  const hold = { code: 'AMBER_SYNC_ELIGIBILITY_UNRESOLVED', resolution: 'lifecycle_reconciliation',
    message: 'Потрібне підтвердження історії доставки', eligibilityIssue: { ancestorProductIds: [1368] } };
  const category = { code: 'CATEGORY_IDENTITIES_REVIEW_REQUIRED', resolution: 'integration_configuration',
    message: 'Категорія Magento існує, але зв’язок ще не підтверджено.', path: 'Default Category/Кулони' };
  api.get.mockResolvedValue({ data: { items: [{ productId: 7, article: 'KL2/11131121007-001', category: 'KL',
    problems: [hold, { code: 'data_or_binding', resolution: 'integration_configuration', message: 'Перевірте правила' }, hold, category, hold] }], pageInfo: { total: 1 } } });
  const post = vi.spyOn(api, 'post');
  renderPage(['products.view', 'exports.reconcile', 'export_templates.view']);
  const start = await screen.findByRole('region', { name: 'З чого почати' });
  expect(start.querySelector('h3').textContent).toBe('Потрібне підтвердження історії доставки');
  expect(start.querySelector('button').textContent).toBe('Перевірити товар у Magento');
  expect(screen.getAllByRole('heading', { name: 'Потрібне підтвердження історії доставки' })).toHaveLength(1);
  const categoryLink = screen.getByRole('link', { name: 'Перевірити відповідність категорії' });
  expect(categoryLink.getAttribute('href')).toContain('path=Default+Category%2F');
  expect(categoryLink.getAttribute('href')).toContain('view=placement');
  expect(categoryLink.getAttribute('href')).not.toContain('tab=placement');
  expect(start.compareDocumentPosition(categoryLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Інші перешкоди' })).toBeTruthy();
  expect(screen.queryByText('1368')).toBeNull();
  fireEvent.click(screen.getByText('Дані для підтримки'));
  expect(screen.getByText(/1368/)).toBeTruthy();
  expect(api.get.mock.calls.every(([url]) => url === '/magento/problems/page')).toBe(true);
  expect(post).not.toHaveBeenCalled();
});

it('opens the real product problem queue without reading legacy corrections', async () => {
  api.get.mockResolvedValue({ data: { items: [{ productId: 7, article: 'AG-000007', category: 'SV',
    problems: [{ code: 'PRODUCT_EVALUATION_NOT_READY', resolution: 'product', message: 'Перевірте дані',
      issueFields: ['kamin_obrobka'], evaluationIssues: [{ field: 'kamin_obrobka', message: 'Оберіть обробку каменю.' }] }] }], pageInfo: { total: 1 } } });
  renderPage();
  await screen.findByRole('heading', { name: /AG-000007/ });
  expect(screen.getAllByText(/Оберіть обробку каменю/).length).toBeGreaterThan(0);
  expect(screen.queryByText('Запити на виправлення')).toBeNull();
  expect(correctionsApi.listRequestPage).not.toHaveBeenCalled();
  expect(api.get).toHaveBeenCalledWith('/magento/problems/page', expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it('a viewer receives a concrete handoff rather than advice to click an unavailable recovery button', async () => {
  api.get.mockResolvedValue({ data: { items: [{ productId: 7, article: 'AG-000007', problems: [
    { code: 'reconciliation_required', resolution: 'administrator', message: 'Результат доставки не підтверджено.' },
  ] }], pageInfo: { total: 1 } } });
  renderPage(['products.view']);
  await screen.findByRole('region', { name: 'З чого почати' });
  expect(screen.getByText(/Скопіюйте опис проблеми та передайте йому/)).toBeTruthy();
  expect(screen.queryByText(/^Відкрийте перевірку доставки/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Відкрити перевірку доставки' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Копіювати опис проблеми' })).toBeTruthy();
});

it('optional Magento comparison mounts on demand and still requires an explicit check', async () => {
  api.get.mockResolvedValue({ data: { items: [{ productId: 7, article: 'AG-000007', category: 'SV', problems: [
    { code: 'CATEGORY_PATH_MISSING', resolution: 'integration_preparation', message: 'Категорії немає' },
  ] }], pageInfo: { total: 1 } } });
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { productId: 7, article: 'AG-000007', sendable: true } });
  renderPage(['products.view', 'export_templates.manage', 'exports.view']);
  await screen.findByRole('region', { name: 'З чого почати' });
  expect(screen.queryByRole('button', { name: 'Перевірити дані та очікувані зміни' })).toBeNull();
  fireEvent.click(screen.getByText('Додаткова перевірка даних у Magento'));
  const check = screen.getByRole('button', { name: 'Перевірити дані та очікувані зміни' });
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(check);
  await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/magento-integration/product-preview', { productId: 7 }, expect.any(Object)));
});

it('does not present an unavailable read as an empty queue', async () => {
  api.get.mockRejectedValue(new Error('unavailable'));
  renderPage();
  await screen.findByText('Не вдалося оновити проблеми доставки.');
  expect(screen.queryByText('Зафіксованих проблем немає')).toBeNull();
});

it('does not expose synchronization evidence through legacy correction permissions', () => {
  renderPage(['corrections.view']);
  expect(screen.getByText(/Перегляд проблем синхронізації недоступний/)).toBeTruthy();
  expect(api.get).not.toHaveBeenCalled();
  expect(correctionsApi.listRequestPage).not.toHaveBeenCalled();
});

it('selected off-page product stays exact and a failed detail never falls back to the first row', async () => {
  api.get.mockImplementation(async (url) => ({ data: url === '/magento/problems/page'
    ? { items: [{ productId: 1, article: 'AG-000001', problems: [{ code: 'configuration', message: 'Інша проблема' }] }], pageInfo: { total: 1 } }
    : { productId: 99, article: 'AG-000099', state: 'pending', problems: [] } }));
  render(<AuthContext.Provider value={auth(['products.view'])}><MemoryRouter initialEntries={['/attention?problem=99&search=AG-1']}><AttentionPage /></MemoryRouter></AuthContext.Provider>);
  await screen.findByRole('heading', { name: /AG-000099/ });
  expect(screen.queryByRole('heading', { name: /AG-000001/ })).toBeNull();
  expect(screen.getByText(/Поточна зміна очікує завершення доставки/)).toBeTruthy();
  api.get.mockRejectedValue(new Error('unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
  await screen.findByText('Не вдалося прочитати стан вибраного товару. Оновіть дані.');
  expect(screen.queryByRole('heading', { name: /AG-000001/ })).toBeNull();
});

it('search and filters are submitted as bounded server reads', async () => {
  renderPage();
  await screen.findByText('Зафіксованих проблем немає');
  fireEvent.change(screen.getByLabelText('Артикул'), { target: { value: 'AG-000008' } });
  fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'product' } });
  fireEvent.click(screen.getByRole('button', { name: 'Знайти' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/magento/problems/page', expect.objectContaining({
    params: expect.objectContaining({ search: 'AG-000008', reason: 'product', limit: 20, offset: 0 }),
  })));
});

it('shows the linked category after its options arrive asynchronously and preserves the filter on submit', async () => {
  api.get.mockResolvedValue({ data: { items: [], pageInfo: { total: 0 }, categories: [{ code: 'KL', name: 'Кулони' }] } });
  render(<AuthContext.Provider value={auth(['products.view'])}><MemoryRouter initialEntries={['/attention?category=KL']}><AttentionPage /></MemoryRouter></AuthContext.Provider>);
  await screen.findByText('За цими умовами товарів немає');
  expect(screen.getByLabelText('Категорія').value).toBe('KL');
  fireEvent.click(screen.getByRole('button', { name: 'Знайти' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/magento/problems/page', expect.objectContaining({ params: expect.objectContaining({ category: 'KL' }) })));
});

it('does not expose a previous principal summary while the next principal is loading', async () => {
  let resolveNext;
  api.get
    .mockResolvedValueOnce({ data: { problemCount: 3 } })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve; }));
  const firstPrincipal = { id: 'first', valid: true };
  const secondPrincipal = { id: 'second', valid: true };
  const Probe = () => {
    const state = useMagentoSummary();
    return <span>{state.loading ? 'loading' : state.summary?.problemCount ?? 'none'}</span>;
  };
  const show = (principal) => <AuthContext.Provider value={{ ...auth(['products.view']), principalLifetime: principal }}><Probe /></AuthContext.Provider>;
  const view = render(show(firstPrincipal));

  await screen.findByText('3');
  view.rerender(show(secondPrincipal));
  expect(screen.queryByText('3')).toBeNull();
  await screen.findByText('loading');
  await act(async () => resolveNext({ data: { problemCount: 7 } }));
  await screen.findByText('7');
});

it('successful repair retains the selected product when it leaves the attention queue without claiming delivery', async () => {
  let corrected = false;
  const item = { productId: 7, article: 'AG-000007', category: 'SV', productStatus: 'active', state: 'needs_attention', problems: [
    { code: 'PRODUCT_EVALUATION_NOT_READY', resolution: 'product', message: 'Заповніть розмір', issueFields: ['rozmir_suveniriv'] },
  ] };
  api.get.mockImplementation(async (url) => ({ data: url === '/magento/problems/page'
    ? { items: corrected ? [] : [item], pageInfo: { total: corrected ? 0 : 1 } }
    : { ...item, state: 'pending', problems: [] } }));
  vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/product-information/preview') return { data: { previewToken: 'reviewed-size', changes: [{ key: 'size', after: '12×8 см' }] } };
    if (url === '/product-information/apply') { corrected = true; return { data: { productId: 7 } }; }
    throw new Error('Unexpected mutation');
  });
  renderPage(['products.view', 'products.recount']);
  fireEvent.click(await screen.findByRole('button', { name: 'Заповнити розмір' }));
  fireEvent.change(screen.getByLabelText('Розмір'), { target: { value: '12×8 см' } });
  fireEvent.click(screen.getByRole('button', { name: 'Переглянути зміну' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Зберегти розмір' }));
  await screen.findByText('Дані виправлено в Amber. Результат доставки показано окремо у стані Magento.');
  await screen.findByText('Magento: Очікує синхронізації');
  expect(screen.getByRole('heading', { name: /AG-000007/ })).toBeTruthy();
  expect(screen.queryByText('Magento: Синхронізовано')).toBeNull();
  expect(api.get.mock.calls.some(([url]) => url === '/magento/problems/7')).toBe(true);
});

it('identity mismatch offers a read-only identity check and a handoff instead of a name choice', async () => {
  const item={productId:7,article:'AG-000007',category:'SV',problems:[{code:'NAME_REMOTE_IDENTITY_CHANGED',resolution:'name',message:'Ідентичність товару відрізняється.'}]};
  api.get.mockResolvedValue({data:{items:[item],pageInfo:{total:1}}});
  const post=vi.spyOn(api,'post').mockResolvedValue({data:{productId:7,article:'AG-000007',sendable:false,
    identity:{confirmedMagentoId:41,observedMagentoId:42,state:'found'},blockers:item.problems}});
  renderPage(['products.view','export_templates.manage','exports.view']);
  const check=await screen.findByRole('button',{name:'Перевірити ідентичність товару Magento'});
  expect(post).not.toHaveBeenCalled();
  expect(screen.queryByRole('button',{name:/Обрати назву|Підтвердити назву/})).toBeNull();
  fireEvent.click(check);
  await screen.findByText('№41');await screen.findByText('№42');
  expect(screen.getByText(/Зв’язок не збігається/)).toBeTruthy();
  expect(post.mock.calls.map(([url])=>url)).toEqual(['/admin/magento-integration/product-preview']);
  fireEvent.click(screen.getByText('Дані для підтримки'));
  expect(screen.getByRole('heading',{name:'Спостереження Magento'})).toBeTruthy();
  expect(screen.getAllByText('Дані для підтримки')).toHaveLength(1);
});

it('pending delivery polls without overlap then displays only the acknowledged timestamp and keeps selection until next is clicked', async () => {
  vi.useFakeTimers();
  try {
    let state='pending';let completeDetail;let hold=false;
    const date='2026-10-04T20:10:00.000Z';
    api.get.mockImplementation(async(url)=>{
      if(url==='/magento/problems/page')return {data:{items:[{productId:8,article:'AG-000008',problems:[{code:'configuration'}]}],pageInfo:{total:1}}};
      if(hold)await new Promise(resolve=>{completeDetail=resolve;});
      return {data:{productId:7,article:'AG-000007',state,confirmedAt:state==='synced'?date:undefined,observedAt:'2026-10-04T20:20:00Z',problems:[]}};
    });
    render(<AuthContext.Provider value={auth(['products.view'])}><MemoryRouter initialEntries={['/attention?problem=7']}><AttentionPage/></MemoryRouter></AuthContext.Provider>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
    expect(screen.getByText('Magento: Очікує синхронізації')).toBeTruthy();
    expect(screen.queryByText(/Підтверджено/)).toBeNull();
    hold=true;
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    const calls=api.get.mock.calls.length;
    await act(async()=>{window.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(20000);});
    expect(api.get.mock.calls).toHaveLength(calls);
    state='synced';hold=false;
    await act(async()=>{completeDetail();await vi.advanceTimersByTimeAsync(0);});
    expect(screen.getByText('Magento: Синхронізовано')).toBeTruthy();
    expect(document.querySelector('time').dateTime).toBe(date);
    expect(screen.getByRole('heading',{name:/AG-000007/})).toBeTruthy();
    expect(screen.getByRole('button',{name:'До наступного товару'})).toBeTruthy();
  } finally {cleanup();vi.useRealTimers();}
});

it.each(['GET', 'POST', 'ready'])('returning to the first queue item discards first-sync %s evidence and requires another explicit check', async (phase) => {
  const bindingRevisionId = 'fed6b54b-88ae-4bfb-ad52-bc84db493e34';
  const item = { productId: 1488, article: 'SV11500004', category: 'SV', state: 'needs_attention', problems: [
    { code: 'PRODUCT_EVALUATION_NOT_READY', resolution: 'product', issueFields: ['decor_weight'], message: 'Немає додатної ваги для Magento' },
  ] };
  const firstPreview = { mode: 'first', sku: item.article, previewToken: 'b'.repeat(64), complete: false, readyForOutbound: false, blockers: [], fields: [
    { target: 'weight', scope: 'all', status: 'conflict', reason: 'POPULATED_VALUES_DIFFER', local: { known: true, present: true, value: '132.300' },
      remote: { known: true, present: true, value: '140' }, canAcceptRemote: true, canKeepLocal: true },
  ] };
  let finish; const pending = new Promise((resolve) => { finish = resolve; }); let bindingReads = 0;
  api.get.mockImplementation((url) => {
    if (url === '/magento/problems/page') return Promise.resolve({ data: { items: [item], pageInfo: { total: 1, hasNext: false, hasPrevious: false } } });
    if (url === '/magento/problems/1488') return Promise.resolve({ data: item });
    if (url === '/integration-tasks') return Promise.resolve({ data: { items: [], nextOffset: null } });
    if (url === '/admin/magento-integration') {
      bindingReads += 1;
      return phase === 'GET' && bindingReads === 1 ? pending : Promise.resolve({ data: { currentPublishedId: bindingRevisionId } });
    }
    throw new Error(`Unexpected read: ${url}`);
  });
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: firstPreview });
  if (phase === 'POST') post.mockReturnValueOnce(pending);
  const administrator = { ...auth(['products.view', 'export_templates.view', 'export_templates.manage', 'export_templates.publish', 'exports.view']),
    roles: [{ key: 'administrator' }] };
  render(<AuthContext.Provider value={administrator}><MemoryRouter initialEntries={['/attention?problem=1488']}><AttentionPage /></MemoryRouter></AuthContext.Provider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Перевірити актуальні поля' }));
  if (phase === 'POST') await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  if (phase === 'ready') await screen.findByRole('button', { name: 'Отримати значення Magento: Вага · UA / основний магазин' });
  const signal = phase === 'GET' ? api.get.mock.calls.find(([url]) => url === '/admin/magento-integration')[1].signal
    : phase === 'POST' ? post.mock.calls[0][2].signal : null;

  fireEvent.click(screen.getByRole('button', { name: 'До списку товарів' }));
  if (signal) expect(signal.aborted).toBe(true);
  expect(screen.queryByRole('button', { name: 'До списку товарів' })).toBeNull();
  const queue = screen.getByRole('complementary', { name: 'Черга проблем доставки' });
  fireEvent.click(within(queue).getByRole('button', { name: /SV11500004/ }));
  await screen.findByRole('button', { name: 'До списку товарів' });
  if (phase !== 'ready') await act(async () => finish(phase === 'GET' ? { data: { currentPublishedId: bindingRevisionId } } : { data: firstPreview }));
  expect(screen.queryByRole('region', { name: 'Вага · UA / основний магазин' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Зберегти рішення цього поля' })).toBeNull();
  expect(bindingReads).toBe(1); expect(post).toHaveBeenCalledTimes(phase === 'GET' ? 0 : 1);

  fireEvent.click(screen.getByRole('button', { name: 'Перевірити актуальні поля' }));
  await screen.findByRole('region', { name: 'Вага · UA / основний магазин' });
  expect(bindingReads).toBe(2); expect(post).toHaveBeenCalledTimes(phase === 'GET' ? 1 : 2);
  expect(post.mock.calls.every(([url]) => url === '/admin/magento-integration/first-sync/preview')).toBe(true);
});
