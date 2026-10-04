import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoPublicationActions from '../src/components/workspace/MagentoPublicationActions.jsx';
import MagentoControlledActions from '../src/components/workspace/MagentoControlledActions.jsx';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const permissions = ['export_templates.manage', 'export_templates.publish', 'exports.view', 'exports.create'];
const revision = { id: 'draft', revision: '3', state: 'draft' };
const proof = { previewToken: 'proof', totalProducts: 3, affected: [{ productId: 1, article: 'AG-000003', reason: 'unblocked' }],
  lostRoutes: [], lostProducts: [], preservedNames: [], checked: [], blockers: [] };
const roles = [{key:'administrator'}];
const shell = (props = {}, grants = permissions, assignedRoles = roles) => render(<AuthContext.Provider value={{ permissions: grants, roles: assignedRoles }}><MemoryRouter><MagentoPublicationActions revision={revision} currentPublishedId="current" onPublished={vi.fn()} {...props} /></MemoryRouter></AuthContext.Provider>);
const controlledShell = (props = {}, grants = permissions, assignedRoles = roles) => render(<AuthContext.Provider value={{ permissions: grants, roles: assignedRoles }}><MemoryRouter><MagentoControlledActions revision={{...revision,id:'current',state:'published'}} currentPublishedId="current" kind="broader_resync" {...props} /></MemoryRouter></AuthContext.Provider>);
function openDetails(label) {fireEvent.click(screen.getByText(label).closest('summary'));}
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
it('recovery handoff verifies and selects only the exact eligible product without dispatching or widening the selection', async () => {
  const product = (productId, blocked = false) => ({ productId, article: `AG-${productId}`, before: { all: 'Товар' }, blockers: blocked ? ['RECONCILIATION_REQUIRED'] : [] });
  api.get.mockResolvedValue({ data: { products: [product(21), product(22)], nextCursor: 22 } });
  render(<AuthContext.Provider value={{ permissions, roles }}><MemoryRouter initialEntries={['/admin/magento/administrator?productId=21&action=broader_resync&returnTo=%2Fattention%3Fproblem%3D21']}><Link to="/admin/magento/administrator?productId=22">Інший товар</Link><MagentoControlledActions revision={{ ...revision, id: 'current', state: 'published' }} currentPublishedId="current" kind="broader_resync" /></MemoryRouter></AuthContext.Provider>);
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Повернутися до проблеми товару' }).getAttribute('href')).toBe('/attention?problem=21');
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товари для контрольованої дії' }));
  expect((await screen.findByLabelText(/AG-21/)).checked).toBe(true);
  expect(screen.queryByLabelText(/AG-22/)).toBeNull();
  expect(api.get).toHaveBeenCalledWith('/admin/magento-integration/bindings/current/controlled-products', { params: { after: 20, search: '' } });
  expect(screen.getByRole('button', { name: 'Наступні товари' }).disabled).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link', { name: 'Інший товар' }));
  expect(screen.queryByLabelText(/AG-21/)).toBeNull(); expect(api.get).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товари для контрольованої дії' }));
  expect((await screen.findByLabelText(/AG-22/)).checked).toBe(true);
  expect(api.get).toHaveBeenLastCalledWith('/admin/magento-integration/bindings/current/controlled-products', { params: { after: 21, search: '' } });
  expect(api.post).not.toHaveBeenCalled();
});

it('recovery handoff never selects a dispatched unconfirmed product', async () => {
  api.get.mockResolvedValue({ data: { products: [{ productId: 21, article: 'AG-21', before: {}, blockers: ['RECONCILIATION_REQUIRED'] }], nextCursor: null } });
  render(<AuthContext.Provider value={{ permissions, roles }}><MemoryRouter initialEntries={['/admin/magento/administrator?productId=21']}><MagentoControlledActions revision={{ ...revision, id: 'current', state: 'published' }} currentPublishedId="current" kind="broader_resync" /></MemoryRouter></AuthContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товари для контрольованої дії' }));
  const checkbox = await screen.findByLabelText(/AG-21/); expect(checkbox.checked).toBe(false); expect(checkbox.disabled).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});
it('controlled product picker can reach later pages and preserves the exact cross-page selection',async()=>{
  const product=(id)=>({productId:id,article:`AG-${id}`,before:{all:`Назва ${id}`},after:{all:`Нова ${id}`},changed:true,blockers:[]});
  api.get.mockImplementation((path,options)=>Promise.resolve({data:path.endsWith('/handoffs')?[]: options.params.after===0
    ? {products:[product(1)],nextCursor:100} : {products:[product(101)],nextCursor:null}}));
  api.post.mockResolvedValue({data:{previewToken:'selection-proof',products:[product(1),product(101)],blockers:[]}});
  controlledShell();
  fireEvent.click(screen.getByRole('button',{name:'Перевірити товари для контрольованої дії'}));
  await screen.findByLabelText(/AG-1 ·/);fireEvent.click(screen.getByLabelText(/AG-1 ·/));
  fireEvent.click(screen.getByRole('button',{name:'Наступні товари'}));
  await screen.findByLabelText(/AG-101 ·/);fireEvent.click(screen.getByLabelText(/AG-101 ·/));
  expect(screen.getByText(/вибрано 2 \/ 100/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Попередні товари'}));
  expect((await screen.findByLabelText(/AG-1 ·/)).checked).toBe(true);
  fireEvent.change(screen.getByLabelText('Пояснення контрольованої дії'),{target:{value:'Точний вибір із двох сторінок'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити вибрану дію'}));
  expect(screen.getByRole('button',{name:'Очистити вибір'}).disabled).toBe(true);
  expect(screen.getByLabelText('Пошук за артикулом').disabled).toBe(true);
  await screen.findByText('Вибрано товарів: 2.');
  expect(api.post.mock.calls[0][1].productIds).toEqual([1,101]);
});
it('complete affected and lost sets paginate locally without new HTTP snapshot pages',async()=>{
  const products=Array.from({length:101},(_,i)=>({productId:i+1,article:`ARTICLE-${i+1}`,routeKey:'XG:all',reason:'unblocked'}));
  api.post.mockResolvedValueOnce({data:{...proof,totalProducts:3323,affected:products,lostProducts:products,lostRoutes:['XG:all']}});
  shell();fireEvent.click(screen.getByRole('button',{name:'Перевірити вплив публікації'}));
  await screen.findByText(/Перевірено поточних товарів: 3323/);
  expect(screen.queryByText('ARTICLE-1 · Готовність відновлено')).toBeNull();
  openDetails('Точний перелік товарів для доставки');
  const {within}=await import('@testing-library/react');
  const pager=screen.getByRole('navigation',{name:'Товари для доставки'});
  fireEvent.click(within(pager).getByRole('button',{name:'Далі'}));
  expect(screen.queryByText('ARTICLE-101 · Готовність відновлено')).toBeNull();
  fireEvent.click(within(pager).getByRole('button',{name:'Далі'}));
  expect(screen.getByText('ARTICLE-101 · Готовність відновлено')).toBeTruthy();
  expect(api.post).toHaveBeenCalledTimes(1);expect(api.get).not.toHaveBeenCalled();
});
it('publication requires an explicit impact preview and reuses exact representative inputs', async () => {
  const published = vi.fn(), input = { product: { categoryCode: 'XX', answers: {}, weight: '2' } };
  api.post.mockResolvedValueOnce({ data: proof }).mockResolvedValueOnce({ data: { revision: { id: 'published' } } });
  shell({ representatives: [{ routeKey: 'XX:all', input }], onPublished: published });
  expect(screen.queryByRole('button', { name: 'Опублікувати відповідності' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити вплив публікації' }));
  await screen.findByText(/До синхронізації буде передано: 1/);
  fireEvent.click(screen.getByRole('button', { name: 'Опублікувати відповідності' }));
  await vi.waitFor(() => expect(published).toHaveBeenCalledWith({ id: 'published' }));
  expect(api.post.mock.calls[1]).toEqual(['/admin/magento-integration/publication/apply', { bindingRevisionId: 'draft', expectedRevision: '3', expectedCurrentId: 'current', representatives: [input], previewToken: 'proof' }]);
});
it('exact route/product loss requires acknowledgement and explanation; stale apply clears review', async () => {
  api.post.mockResolvedValueOnce({ data: { ...proof, lostRoutes: ['SV:normal'], lostProducts: [{ productId: 2, article: 'AG-000004', routeKey: 'SV:normal' }] } })
    .mockRejectedValueOnce({ response: { data: { error: 'Дані змінилися' } } });
  shell(); fireEvent.click(screen.getByRole('button', { name: 'Перевірити вплив публікації' }));
  await screen.findByText('AG-000004 · SV:normal');
  expect(screen.getByRole('button', { name: 'Опублікувати відповідності' }).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Підтверджую точну втрату покриття'));
  fireEvent.change(screen.getByLabelText('Пояснення скорочення'), { target: { value: 'Свідоме скорочення' } });
  fireEvent.click(screen.getByRole('button', { name: 'Опублікувати відповідності' }));
  await screen.findByText('Дані змінилися');
  expect(screen.queryByRole('button', { name: 'Опублікувати відповідності' })).toBeNull();
  expect(api.post.mock.calls[1][1]).toMatchObject({ ackCoverageLoss: true, coverageReason: 'Свідоме скорочення' });
});
it('missing CREATE readiness blocks publication and view-only cannot publish', async () => {
  api.post.mockResolvedValueOnce({ data: { ...proof, blockers: [{ code: 'REPRESENTATIVE_CREATE_REQUIRED', routeKey: 'XX:all' }] } });
  shell(); fireEvent.click(screen.getByRole('button', { name: 'Перевірити вплив публікації' }));
  await screen.findByText('Потрібен готовий приклад CREATE для маршруту · XX:all');
  expect(screen.getByRole('button', { name: 'Опублікувати відповідності' }).disabled).toBe(true);
  cleanup(); shell({}, ['export_templates.view']);
  expect(screen.queryByRole('button', { name: 'Перевірити вплив публікації' })).toBeNull();
});
it('publication status survives remount, polls real pending counts and offers no blind retry', async () => {
  vi.useFakeTimers(); const state = { id: 'handoff', kind: 'publication', created_at: '2026-10-02T00:00:00Z', total: 3, pending_handoff: 1, waiting: 1, protected: 1, synced: 0, needs_attention: 0, retired: 0 };
  api.get.mockResolvedValueOnce({ data: [state] }).mockResolvedValue({ data: [{ ...state, pending_handoff: 0, waiting: 0, synced: 2 }] });
  shell({ revision: { ...revision, id: 'current', state: 'published' } });
  await act(async () => {});
  expect(screen.getByText(/0 \/ 3 синхронізовано/)).toBeTruthy();
  expect(screen.getByText(/Не передано через непідтверджену попередню роботу: 1/)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText(/2 \/ 3 синхронізовано/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Retry|Повторити відправ/ })).toBeNull();
  cleanup(); shell({ revision: { ...revision, id: 'current', state: 'published' } });
  await act(async () => {}); expect(screen.getByText(/2 \/ 3 синхронізовано/)).toBeTruthy();
});
it('controlled resync and name-rule application require separate selection, reason, preview and apply', async () => {
  api.get.mockImplementation((path) => Promise.resolve({ data: path.endsWith('/handoffs') ? [] : { unexamined: 0, products: [
    { productId: 1, article: 'AG-000003', before: { all: 'Стара', en: 'Old' }, after: { all: 'Нова', en: 'New' }, changed: true, blockers: [] },
    { productId: 2, article: 'AG-000004', before: { all: 'Конфлікт' }, after: {}, changed: true, blockers: ['RECONCILIATION_REQUIRED'] }] } }));
  api.post.mockResolvedValueOnce({ data: { previewToken: 'controlled-proof', products: [{ productId: 1, article: 'AG-000003', before: { all: 'Стара', en: 'Old' }, after: { all: 'Нова', en: 'New' } }], blockers: [] } }).mockResolvedValue({ data: { handoffId: 'receipt' } });
  controlledShell({kind:'name_rule'});
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товари для контрольованої дії' }));
  await screen.findByLabelText(/AG-000003/);
  expect(screen.getByLabelText(/AG-000004/).disabled).toBe(true);
  expect(screen.queryByRole('combobox',{name:'Дія'})).toBeNull();
  fireEvent.click(screen.getByLabelText(/AG-000003/));
  fireEvent.change(screen.getByLabelText('Пояснення контрольованої дії'), { target: { value: 'Свідоме застосування' } });
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити вибрану дію' }));
  await screen.findByText('Вибрано товарів: 1.');
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити контрольовану дію' }));
  await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(api.post.mock.calls[1][1]).toMatchObject({ kind: 'name_rule', productIds: [1], previewToken: 'controlled-proof' });
  await screen.findByRole('heading',{name:'Публікація та передача товарів'});
  await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/magento-integration/bindings/current/handoffs',expect.objectContaining({signal:expect.any(AbortSignal)})));
});
it('controlled article search keeps the after cursor, preserves selection, confirms exact articles and clears it',async()=>{
  const product=(id)=>({productId:id,article:`ARTICLE-${id}`,before:{all:'Назва',en:'Name'},after:{},changed:false,blockers:[]});
  api.get.mockImplementation((path,{params}={})=>Promise.resolve({data:path.endsWith('/handoffs')?[]:
    {products:params.search?[product(999)]:params.after?[product(101)]:[product(1)],nextCursor:!params.after&&!params.search?100:null}}));
  api.post.mockResolvedValue({data:{products:[product(1),product(101)],blockers:[],previewToken:'proof'}});
  controlledShell();
  fireEvent.click(screen.getByRole('button',{name:'Перевірити товари для контрольованої дії'}));
  fireEvent.click(await screen.findByLabelText(/ARTICLE-1 /));
  fireEvent.click(screen.getByRole('button',{name:'Наступні товари'}));
  fireEvent.click(await screen.findByLabelText(/ARTICLE-101 /));
  expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/controlled-products'),{params:{after:100,search:''}});
  fireEvent.change(screen.getByLabelText('Пояснення контрольованої дії'),{target:{value:'Reviewed articles'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити вибрану дію'}));
  await screen.findByText('Вибрано товарів: 2.');
  expect(screen.getByText('ARTICLE-1')).toBeTruthy();expect(screen.getByText('ARTICLE-101')).toBeTruthy();
  expect(api.post.mock.calls[0][1]).toMatchObject({kind:'broader_resync',productIds:[1,101]});
  fireEvent.change(screen.getByLabelText('Пошук за артикулом'),{target:{value:'ARTICLE-999'}});
  expect(screen.queryByRole('button',{name:'Підтвердити контрольовану дію'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Перевірити товари для контрольованої дії'}));
  await screen.findByLabelText(/ARTICLE-999 /);
  expect(api.get).toHaveBeenLastCalledWith(expect.stringContaining('/controlled-products'),{params:{after:0,search:'ARTICLE-999'}});
  expect(screen.getByText(/вибрано 2 \/ 100/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Очистити вибір'}));
  expect(screen.getByText(/вибрано 0 \/ 100/)).toBeTruthy();
});
it('delegated publication capabilities allow normal publication but never Administrator coverage loss or controlled actions',async()=>{
  api.post.mockResolvedValueOnce({data:{...proof,lostRoutes:['SV:normal'],lostProducts:[]}});
  shell({},permissions,[]);fireEvent.click(screen.getByRole('button',{name:'Перевірити вплив публікації'}));
  await screen.findByText(/Покриття буде скорочено/);
  expect(screen.queryByLabelText('Підтверджую точну втрату покриття')).toBeNull();
  expect(screen.queryByRole('button',{name:'Опублікувати відповідності'})).toBeNull();
  cleanup();controlledShell({},permissions,[]);
  expect(screen.queryByRole('button',{name:'Перевірити товари для контрольованої дії'})).toBeNull();
  expect(api.get).not.toHaveBeenCalled();
  cleanup();api.post.mockResolvedValueOnce({data:proof});shell({},permissions,[]);
  fireEvent.click(screen.getByRole('button',{name:'Перевірити вплив публікації'}));
  expect((await screen.findByRole('button',{name:'Опублікувати відповідності'})).disabled).toBe(false);
});
it('name-rule application needs exports.create and a current publication, independently from broad resync',()=>{
  controlledShell({kind:'name_rule'},permissions.filter(permission=>permission!=='exports.create'));
  expect(screen.queryByRole('button',{name:'Перевірити товари для контрольованої дії'})).toBeNull();
  cleanup();controlledShell({},permissions.filter(permission=>permission!=='exports.create'));
  expect(screen.getByRole('button',{name:'Перевірити товари для контрольованої дії'})).toBeTruthy();
  cleanup();controlledShell({currentPublishedId:'newer'});
  expect(screen.queryByRole('button',{name:'Перевірити товари для контрольованої дії'})).toBeNull();
});
it('a late controlled preview cannot appear in another action context',async()=>{
  const product={productId:1,article:'LEGACY-ARTICLE',before:{all:'Назва'},after:{all:'Нова'},changed:true,blockers:[]};
  let resolvePreview;api.get.mockResolvedValue({data:{products:[product],nextCursor:null}});
  api.post.mockReturnValue(new Promise(resolve=>{resolvePreview=resolve;}));
  const view=controlledShell();fireEvent.click(screen.getByRole('button',{name:'Перевірити товари для контрольованої дії'}));
  fireEvent.click(await screen.findByLabelText(/LEGACY-ARTICLE/));
  fireEvent.change(screen.getByLabelText('Пояснення контрольованої дії'),{target:{value:'Точний вибір'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити вибрану дію'}));
  view.rerender(<AuthContext.Provider value={{permissions,roles}}><MemoryRouter><MagentoControlledActions revision={{...revision,id:'current',state:'published'}} currentPublishedId="current" kind="name_rule"/></MemoryRouter></AuthContext.Provider>);
  await act(async()=>resolvePreview({data:{previewToken:'obsolete',products:[product],blockers:[]}}));
  expect(screen.queryByRole('button',{name:'Підтвердити контрольовану дію'})).toBeNull();
  expect(screen.getByRole('heading',{name:'Застосувати правило назв'})).toBeTruthy();
});
it('a new coverage review resets the old acknowledgement',async()=>{
  api.post.mockResolvedValue({data:{...proof,lostRoutes:['SV:normal'],lostProducts:[]}});shell();
  fireEvent.click(screen.getByRole('button',{name:'Перевірити вплив публікації'}));
  fireEvent.click(await screen.findByLabelText('Підтверджую точну втрату покриття'));
  fireEvent.change(screen.getByLabelText('Пояснення скорочення'),{target:{value:'Перша перевірка'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити вплив публікації'}));
  expect((await screen.findByLabelText('Підтверджую точну втрату покриття')).checked).toBe(false);
  expect(screen.getByRole('button',{name:'Опублікувати відповідності'}).disabled).toBe(true);
});
