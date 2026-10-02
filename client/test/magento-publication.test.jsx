import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoPublicationActions from '../src/components/workspace/MagentoPublicationActions.jsx';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const permissions = ['export_templates.manage', 'export_templates.publish', 'exports.view', 'exports.create'];
const revision = { id: 'draft', revision: '3', state: 'draft' };
const proof = { previewToken: 'proof', totalProducts: 3, affected: [{ productId: 1, article: 'AG-000003', reason: 'unblocked' }],
  lostRoutes: [], lostProducts: [], preservedNames: [], checked: [], blockers: [] };
const shell = (props = {}, grants = permissions) => render(<AuthContext.Provider value={{ permissions: grants }}><MemoryRouter><MagentoPublicationActions revision={revision} currentPublishedId="current" onPublished={vi.fn()} {...props} /></MemoryRouter></AuthContext.Provider>);
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
it('controlled product picker can reach later pages and preserves the exact cross-page selection',async()=>{
  const product=(id)=>({productId:id,article:`AG-${id}`,before:{all:`Назва ${id}`},after:{all:`Нова ${id}`},changed:true,blockers:[]});
  api.get.mockImplementation((path,options)=>Promise.resolve({data:path.endsWith('/handoffs')?[]: options.params.after===0
    ? {products:[product(1)],nextCursor:100} : {products:[product(101)],nextCursor:null}}));
  api.post.mockResolvedValue({data:{previewToken:'selection-proof',products:[product(1),product(101)],blockers:[]}});
  shell({revision:{...revision,id:'current',state:'published'}});
  fireEvent.click(screen.getByText('Контрольовані дії Адміністратора'));
  fireEvent.click(screen.getByRole('button',{name:'Перевірити товари для контрольованої дії'}));
  await screen.findByLabelText(/AG-1 ·/);fireEvent.click(screen.getByLabelText(/AG-1 ·/));
  fireEvent.click(screen.getByRole('button',{name:'Наступні товари'}));
  await screen.findByLabelText(/AG-101 ·/);fireEvent.click(screen.getByLabelText(/AG-101 ·/));
  expect(screen.getByText(/вибрано 2 \/ 100/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Попередні товари'}));
  expect((await screen.findByLabelText(/AG-1 ·/)).checked).toBe(true);
  fireEvent.change(screen.getByLabelText('Пояснення контрольованої дії'),{target:{value:'Точний вибір із двох сторінок'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити вибрану дію'}));
  await screen.findByText('Вибрано товарів: 2.');
  expect(api.post.mock.calls[0][1].productIds).toEqual([1,101]);
});
it('complete affected and lost sets paginate locally without new HTTP snapshot pages',async()=>{
  const products=Array.from({length:101},(_,i)=>({productId:i+1,article:`ARTICLE-${i+1}`,routeKey:'XG:all',reason:'unblocked'}));
  api.post.mockResolvedValueOnce({data:{...proof,totalProducts:3323,affected:products,lostProducts:products,lostRoutes:['XG:all']}});
  shell();fireEvent.click(screen.getByRole('button',{name:'Перевірити вплив публікації'}));
  await screen.findByText(/Перевірено поточних товарів: 3323/);
  fireEvent.click(screen.getByText('Точний перелік товарів для доставки'));
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
  shell({ revision: { ...revision, id: 'current', state: 'published' } });
  fireEvent.click(screen.getByText('Контрольовані дії Адміністратора'));
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товари для контрольованої дії' }));
  await screen.findByLabelText(/AG-000003/);
  expect(screen.getByLabelText(/AG-000004/).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Дія'), { target: { value: 'name_rule' } });
  fireEvent.click(screen.getByLabelText(/AG-000003/));
  fireEvent.change(screen.getByLabelText('Пояснення контрольованої дії'), { target: { value: 'Свідоме застосування' } });
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити вибрану дію' }));
  await screen.findByText('Вибрано товарів: 1.');
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити контрольовану дію' }));
  await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(api.post.mock.calls[1][1]).toMatchObject({ kind: 'name_rule', productIds: [1], previewToken: 'controlled-proof' });
});
