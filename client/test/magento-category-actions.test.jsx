import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoCategoryActions from '../src/components/workspace/MagentoCategoryActions.jsx';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
afterEach(cleanup);
const path = 'Default/Сувеніри/Нова підкатегорія';
const revision = { id: 'draft', revision: '1', state: 'draft', bindings: { attributes: [
  { bindingKey: 'categories', target: 'categories', evidence: { categories: [{ requestedPath: path, normalizedPath: path }] } },
] } };
const observation = { categories: [{ categoryId: '10', normalizedPath: 'Default/Сувеніри', comparable: true }] };
const shell = (permissions = ['export_templates.manage', 'export_templates.publish']) => render(<AuthContext.Provider value={{ permissions }}><MagentoCategoryActions revision={revision} observation={observation} /></AuthContext.Provider>);
beforeEach(() => { vi.resetAllMocks(); api.get.mockResolvedValue({ data: [] }); });
it('category creation needs explicit preview/apply and remains separate from binding approval', async () => {
  shell(); api.post.mockResolvedValueOnce({ data: { path, parentId: 10, bindingRevisionId: 'draft', expectedRevision: '1', previewToken: 'proof' } });
  fireEvent.click(screen.getByRole('button', { name: /Перевірити створення під/ }));
  const apply = await screen.findByRole('button', { name: 'Створити підкатегорію' });
  expect(api.post).toHaveBeenCalledTimes(1);
  api.post.mockResolvedValueOnce({ data: { id: 'action', kind: 'category', state: 'verified', path, remoteId: '6001', message: 'Створено, зв’язок ще не підтверджено' } });
  fireEvent.click(apply); await screen.findByText(/Створено, зв’язок ще не підтверджено/);
  expect(api.post.mock.calls[1][1].previewToken).toBe('proof');
  expect(api.post.mock.calls.every(([url]) => !url.includes('binding'))).toBe(true);
});
it('uncertain dispatch remains visible after reload and offers no blind Retry or Create', async () => {
  api.get.mockResolvedValue({ data: [{ id: 'action', kind: 'category', state: 'dispatched', path, remoteId: null,
    canReconcile: false, message: 'Надсилання не підтверджено.' }] });
  shell(); await screen.findByText(/Надсилання не підтверджено/);
  expect(screen.queryByRole('button', { name: /створення/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Повтор|Retry|Перевірити результат/ })).toBeNull();
});
it('remote creation is unavailable without both existing permissions', () => {
  shell(['export_templates.manage']);
  expect(screen.queryByRole('button', { name: /створення/ })).toBeNull();
});
it('a sealed undispatched receipt allows another explicit preview after reload', async () => {
  api.get.mockResolvedValue({data:[{id:'sealed',kind:'category',state:'sealed',path,canReview:true,
    message:'Зміну підготовлено, але не надіслано.'}]});
  shell();await screen.findByText(/підготовлено, але не надіслано/);
  expect(screen.getByRole('button',{name:/Перевірити створення під/})).toBeTruthy();
});
it('groups one remote path once while retaining each exact binding creation command', async () => {
  const shared = { ...revision, bindings: {
    routes: [{ routeKey: 'SV:normal', enabled: true, setId: 151, reviewState: 'approved' }, { routeKey: 'SV:stone', enabled: true, setId: 151, reviewState: 'approved' }],
    attributes: ['normal', 'stone'].map(route => ({ ...revision.bindings.attributes[0], bindingKey: `categories-${route}`, routeKey: `SV:${route}`, rowId: 'base' })),
  } };
  render(<AuthContext.Provider value={{permissions:['export_templates.manage','export_templates.publish']}}><MagentoCategoryActions revision={shared} observation={observation} categoryCode="SV" /></AuthContext.Provider>);
  expect(screen.getAllByText(`${path} · Відсутня`)).toHaveLength(1);
  const group = screen.getByRole('region', { name: `Категорія Magento: ${path}` });
  const choice = within(group).getByRole('combobox', { name: 'Призначення категорії' });
  const previewButton = within(group).getByRole('button', { name: /Перевірити створення під/ });
  expect(previewButton.disabled).toBe(true);
  for (const route of ['normal', 'stone']) {
    api.post.mockResolvedValueOnce({data:{path,parentId:10,bindingRevisionId:'draft',expectedRevision:'1',previewToken:route}});
    fireEvent.change(choice,{target:{value:`categories-${route}`}});
    fireEvent.click(previewButton);
    await screen.findByRole('button',{name:'Створити підкатегорію'});
    expect(api.post).toHaveBeenLastCalledWith('/admin/magento-integration/categories/preview',expect.objectContaining({bindingKey:`categories-${route}`,path}));
    fireEvent.click(screen.getByRole('button',{name:'Скасувати'}));
  }
  expect(screen.getAllByRole('heading',{name:'Категорії Magento'})).toHaveLength(1);
});
it('category scope excludes other bindings and lazily mounts completed history and evidence', async () => {
  const otherPath='Default/Інша';
  const scoped={...revision,bindings:{routes:[{routeKey:'SV:normal',enabled:true,setId:151,reviewState:'approved'},{routeKey:'BR:all',enabled:true,setId:151,reviewState:'approved'}],attributes:[
    {...revision.bindings.attributes[0],routeKey:'SV:normal'},
    {bindingKey:'other-binding',routeKey:'BR:all',target:'categories',evidence:{categories:[{requestedPath:otherPath,normalizedPath:otherPath}]}},
  ]}};
  api.get.mockResolvedValue({data:[{id:'old-action',kind:'category',state:'verified',path:otherPath,message:'Історичну категорію створено.'},
    {id:'pending-action',kind:'category',state:'dispatched',path,message:'Поточний результат не підтверджено.'}]});
  render(<AuthContext.Provider value={{permissions:['export_templates.view']}}><MagentoCategoryActions revision={scoped} observation={observation} categoryCode="SV" /></AuthContext.Provider>);
  await screen.findByText(/Поточний результат не підтверджено/);
  expect(screen.queryByText(/Історичну категорію створено/)).toBeNull();
  expect(screen.queryByText('pending-action')).toBeNull();
  expect(screen.queryByRole('region',{name:`Категорія Magento: ${otherPath}`})).toBeNull();
  fireEvent.click(screen.getByText('Історія інших дій (1)').closest('summary'));
  expect(screen.getByText(/Історичну категорію створено/)).toBeTruthy();
});
it('ignores a late creation preview after changing binding context', async () => {
  let resolvePreview;let resolveCurrent;
  api.post.mockReturnValueOnce(new Promise(resolve=>{resolvePreview=resolve;}))
    .mockReturnValueOnce(new Promise(resolve=>{resolveCurrent=resolve;}));
  const view=render(<AuthContext.Provider value={{permissions:['export_templates.manage','export_templates.publish']}}><MagentoCategoryActions revision={revision} observation={observation} /></AuthContext.Provider>);
  fireEvent.click(screen.getByRole('button',{name:/Перевірити створення під/}));
  view.rerender(<AuthContext.Provider value={{permissions:['export_templates.manage','export_templates.publish']}}><MagentoCategoryActions revision={{...revision,id:'next-draft'}} observation={observation} /></AuthContext.Provider>);
  fireEvent.click(screen.getByRole('button',{name:/Перевірити створення під/}));
  await act(async()=>resolvePreview({data:{path,parentId:10,bindingRevisionId:'draft',expectedRevision:'1',previewToken:'old'}}));
  expect(screen.queryByRole('button',{name:'Створити підкатегорію'})).toBeNull();
  expect(screen.getByRole('button',{name:/Перевірити створення під/}).disabled).toBe(true);
  await act(async()=>resolveCurrent({data:{path,parentId:10,bindingRevisionId:'next-draft',expectedRevision:'1',previewToken:'current'}}));
  expect(screen.getByRole('button',{name:'Створити підкатегорію'})).toBeTruthy();
  expect(screen.getByRole('button',{name:/Перевірити створення під/}).disabled).toBe(false);
});
